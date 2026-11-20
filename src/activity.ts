export interface ActivitySnapshot {
  readonly streaming: boolean;
  readonly shells: number;
  readonly subagents: number;
  readonly requesting: boolean;
  readonly idle: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(sets: Map<string, Set<string>>, key: string, id: string): void {
  let value = sets.get(key);
  if (!value) {
    value = new Set<string>();
    sets.set(key, value);
  }
  value.add(id);
}

function remove(sets: Map<string, Set<string>>, key: string, id?: string): void {
  const value = sets.get(key);
  if (!value) return;
  if (id) value.delete(id);
  else value.clear();
  if (value.size === 0) sets.delete(key);
}

/**
 * Tracks the concrete liveness signals JevPact is allowed to treat as work:
 * an open assistant text stream, a running shell, a running child session, or
 * a model request whose context has just been assembled. A session with none
 * of these is completely idle and must not be compacted.
 */
export class ActivityTracker {
  private readonly streams = new Map<string, Set<string>>();
  private readonly shells = new Map<string, Set<string>>();
  private readonly requests = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly children = new Map<string, Set<string>>();

  observe(event: unknown): void {
    if (!record(event) || !record(event.data)) return;
    const data = event.data;
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    if (!sessionID) return;

    switch (event.type) {
      case "session.created": {
        const parentID = typeof data.parentID === "string" ? data.parentID : undefined;
        if (parentID) this.parents.set(sessionID, parentID);
        break;
      }
      case "session.text.started": {
        const id = typeof data.assistantMessageID === "string" ? data.assistantMessageID : sessionID;
        add(this.streams, sessionID, id);
        this.noteChild(sessionID);
        break;
      }
      case "session.text.ended": {
        const id = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
        remove(this.streams, sessionID, id);
        break;
      }
      case "session.shell.started": {
        const shell = record(data.shell) ? data.shell : undefined;
        const id = typeof shell?.id === "string" ? shell.id : sessionID;
        if (shell?.status === undefined || shell.status === "running") add(this.shells, sessionID, id);
        this.noteChild(sessionID);
        break;
      }
      case "session.shell.ended": {
        const shell = record(data.shell) ? data.shell : undefined;
        const id = typeof shell?.id === "string" ? shell.id : undefined;
        remove(this.shells, sessionID, id);
        break;
      }
      case "session.step.started":
      case "session.tool.called":
      case "session.execution.started": {
        this.noteChild(sessionID);
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle": {
        this.stop(sessionID);
        break;
      }
      case "session.deleted": {
        this.forget(sessionID);
        break;
      }
    }
  }

  /** The context hook only runs while a model request is being assembled. */
  noteRequest(sessionID: string): void {
    this.requests.add(sessionID);
  }

  state(sessionID: string): ActivitySnapshot {
    const streaming = (this.streams.get(sessionID)?.size ?? 0) > 0;
    const shells = this.shells.get(sessionID)?.size ?? 0;
    const subagents = this.children.get(sessionID)?.size ?? 0;
    const requesting = this.requests.has(sessionID);
    return { streaming, shells, subagents, requesting, idle: !streaming && shells === 0 && subagents === 0 && !requesting };
  }

  forget(sessionID: string): void {
    this.stop(sessionID);
    this.shells.delete(sessionID);
    const parentID = this.parents.get(sessionID);
    if (parentID) remove(this.children, parentID, sessionID);
    this.parents.delete(sessionID);
    this.children.delete(sessionID);
  }

  private noteChild(sessionID: string): void {
    const parentID = this.parents.get(sessionID);
    if (parentID) add(this.children, parentID, sessionID);
  }

  private stop(sessionID: string): void {
    this.requests.delete(sessionID);
    this.streams.delete(sessionID);
    // Shells have their own end event: a background command can outlive the
    // execution that started it, so it must keep the session non-idle.
    const parentID = this.parents.get(sessionID);
    if (parentID) remove(this.children, parentID, sessionID);
  }
}
