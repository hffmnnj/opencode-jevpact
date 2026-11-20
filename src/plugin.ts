import { Plugin, Rpc } from "@opencode/plugin";
import type { ModelInfo } from "@opencode/client";
import { ActivityTracker } from "./activity.ts";
import { evaluate, parseModel } from "./client.ts";
import { selectSnapshot } from "./evidence.ts";
import type { EvidenceSkipReason } from "./evidence.ts";
import { eligible, parsePolicy, shouldCompact } from "./policy.ts";
import type { Evaluation, Evidence } from "./types.ts";
import { createStats } from "./stats.ts";
import type { StatsEvent } from "./stats-types.ts";

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;
const rpc = Rpc.define({
  id: "jevpact",
  methods: {
    status: { input: emptyInput, output: { type: "object" } },
    stats: { input: emptyInput, output: { type: "object" } },
    check: { input: emptyInput, output: { type: "object" } },
  },
  events: {},
});

interface SessionState {
  requests: number;
  baselineTokens: number;
  initialized: boolean;
  lastEvaluationAt: number;
  lastCheckpoint?: string;
  compactionID?: string;
  resetBaseline: boolean;
  pending: boolean;
  revision: number;
  controller?: AbortController;
}

export function compactionMode(model: Pick<ModelInfo, "settings">): "provider-native" | "opencode-summary" {
  return model.settings?.compaction?.type === "native" ? "provider-native" : "opencode-summary";
}

export interface Dependencies {
  readonly evaluate?: (evidence: Evidence, options: { apiKey: string; signal?: AbortSignal; model?: string }) => Promise<Evaluation>;
  readonly apiKey?: () => string | undefined;
  readonly now?: () => number;
}

export function createPlugin(dependencies: Dependencies = {}): Plugin.Plugin {
  return Plugin.define({
    id: "jevpact",
    async setup(ctx) {
      const policy = parsePolicy(ctx.options);
      const enabled = ctx.options.enabled !== false;
      const key = dependencies.apiKey ?? (() => process.env.TYPESAFE_API_KEY);
      const judgeModel = parseModel(ctx.options.model);
      const initialKey = key();
      if (initialKey?.trim() && judgeModel.includes(initialKey)) throw new Error("Invalid System One model");
      const safeModel = () => {
        const currentKey = key();
        return currentKey?.trim() && judgeModel.includes(currentKey) ? "[REDACTED]" : judgeModel;
      };
      const judgeOptions = (signal: AbortSignal) => {
        const apiKey = key() ?? "";
        if (apiKey.trim() && judgeModel.includes(apiKey)) throw new Error("Invalid System One model");
        return { apiKey, signal, model: judgeModel };
      };
      const judge = dependencies.evaluate ?? evaluate;
      const now = dependencies.now ?? Date.now;
      const durableStats = createStats(ctx.storage, now);
      const activity = new ActivityTracker();
      let statsStorageErrors = 0;
      const lifetime = new AbortController();
      const sessions = new Map<string, SessionState>();
      const tasks = new Set<Promise<void>>();
      const counters = { evaluations: 0, compactionsRequested: 0, compactionsCompleted: 0, errors: 0 };
      let lastDecision: Record<string, unknown> | null = null;
      let lastSkipReason: string | null = null;
      let lastEvidenceSkip: { sessionID: string; reason: EvidenceSkipReason } | null = null;
      let eventStreamHealthy = false;

      function record(event: StatsEvent): Promise<void> {
        const task = durableStats.record(event).catch(() => { statsStorageErrors++; });
        tasks.add(task);
        void task.finally(() => tasks.delete(task)).catch(() => {});
        return task;
      }

      async function readStats() {
        try {
          return { stats: await durableStats.read(), statsStorageErrors };
        } catch {
          statsStorageErrors++;
          return { stats: null, statsStorageErrors };
        }
      }

      function state(sessionID: string): SessionState {
        let value = sessions.get(sessionID);
        if (!value) {
          value = { requests: 0, baselineTokens: 0, initialized: false, lastEvaluationAt: 0, resetBaseline: false, pending: false, revision: 0 };
          sessions.set(sessionID, value);
        }
        return value;
      }

      function invalidate(sessionID: string) {
        const value = sessions.get(sessionID);
        if (!value) return;
        value.revision++;
        value.controller?.abort();
      }

      function launch(sessionID: string, model?: { providerID: string; id: string }) {
        const task = consider(sessionID, model);
        tasks.add(task);
        void task.finally(() => tasks.delete(task)).catch(() => {});
      }

      // Stops and new controls invalidate in-flight judgments; never invent a resume.
      const events = (async () => {
        try {
          const stream = ctx.event.subscribe({ signal: lifetime.signal });
          eventStreamHealthy = true;
          for await (const event of stream) {
            // Activity is keyed by globally unique session ID. A child session
            // may run in another directory (for example a worktree) and must
            // still count as liveness for the parent being judged here.
            activity.observe(event);
            if (event.location && event.location.directory !== ctx.location.directory) continue;
            if (event.type === "session.inbox.enqueued" || event.type === "session.synthetic" || event.type === "session.step.started" || event.type === "session.execution.interrupted" || event.type === "session.execution.failed") invalidate(event.data.sessionID);
            if (event.type === "session.execution.succeeded") {
              // A terminal execution with no remaining liveness signal is an idle
              // session. It must never start a checkpoint judgment or compaction.
              if (activity.state(event.data.sessionID).idle) {
                lastSkipReason = "Session is completely idle: no streaming, subagent, or shell activity";
                void record({ type: "skip", reason: "idle" });
              } else {
                // Do not block event consumption: a new user prompt must cancel this judgment.
                launch(event.data.sessionID);
              }
            }
            if (event.type === "session.compaction.started") {
              invalidate(event.data.sessionID);
              state(event.data.sessionID).pending = true;
            }
            if (event.type === "session.compaction.ended" || event.type === "session.compaction.failed") {
              const value = state(event.data.sessionID);
              value.pending = false;
              if (event.type === "session.compaction.ended") {
                value.resetBaseline = true;
                value.requests = 0;
                counters.compactionsCompleted++;
              }
              if (event.location?.directory === ctx.location.directory) {
                void record({ type: "compaction", phase: event.type === "session.compaction.ended" ? "completed" : "failed" });
              }
            }
            if (event.type === "session.deleted") {
              invalidate(event.data.sessionID);
              sessions.delete(event.data.sessionID);
            }
          }
        } catch {
          if (!lifetime.signal.aborted) {
            counters.errors++;
            void record({ type: "error" });
          }
        } finally {
          eventStreamHealthy = false;
          for (const value of sessions.values()) value.controller?.abort();
        }
      })();

      await ctx.rpc.register(rpc, {
        status: async () => ({ enabled, configured: Boolean(key()?.trim()), model: safeModel(), location: ctx.location.directory, policy, eventStreamHealthy, ...counters, lastDecision, lastSkipReason, lastEvidenceSkip, ...await readStats() }),
        stats: async () => await readStats(),
        check: async (_input, call) => {
          const started = now();
          try {
            const result = await judge({ excerpt: "User: Implement the parser, then deploy it.\nAssistant: The parser implementation is complete. All parser tests passed and their results confirm the expected behavior. The implementation phase is finished. The next distinct phase is deployment.", inputTokens: 0, contextWindow: 0 }, judgeOptions(AbortSignal.any([lifetime.signal, call.signal])));
            void record({ type: "diagnostic", outcome: "success", latencyMs: result.latencyMs, ...(result.usage ? { usage: result.usage } : {}) });
            return { ok: true, ...result, wouldCompact: shouldCompact(result, policy) };
          } catch {
            void record({ type: "diagnostic", outcome: "error", latencyMs: Math.max(0, now() - started) });
            return { ok: false, model: safeModel(), error: "Jev diagnostic failed; verify key availability and TypeSafe connectivity" };
          }
        },
      });

      async function consider(sessionID: string, ref?: { providerID: string; id: string }) {
        if (!enabled || !key()?.trim() || lifetime.signal.aborted || !eventStreamHealthy) return;
        const value = state(sessionID);
        if (value.pending || value.controller) { void record({ type: "skip", reason: "busy" }); return; }
        const controller = new AbortController();
        value.controller = controller;
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const revision = value.revision;
        let evaluationStartedAt: number | undefined;
        let evaluationRecorded = false;
        let resolvedModel: { providerID: string; modelID: string } | undefined;
        try {
          const session = await ctx.session.get({ sessionID });
          // Child sessions are observed as activity for their parent; they never
          // become checkpoint or compaction targets themselves.
          if (session.parentID !== undefined) return;
          if (session.location.directory !== ctx.location.directory || session.outcome === "interrupted" || session.outcome === "failed") return;
          const selected = ref ?? session.model;
          if (!selected) return;
          const models = await ctx.model.list();
          const model = models.data.find((candidate) => candidate.providerID === selected.providerID && candidate.id === selected.id);
          if (!model) return;
          resolvedModel = { providerID: model.providerID, modelID: model.id };
          const messages = await ctx.session.context({ sessionID });
          const selectedEvidence = selectSnapshot(messages, model.limit.context);
          if (selectedEvidence.type === "skip") {
            lastEvidenceSkip = { sessionID, reason: selectedEvidence.reason };
            lastSkipReason = `Evidence checkpoint skipped: ${selectedEvidence.reason}`;
            void record({ type: "skip", reason: "evidence" });
            return;
          }
          const view = selectedEvidence.snapshot;
          if (!value.initialized || view.compactionID !== value.compactionID || value.resetBaseline) {
            value.compactionID = view.compactionID;
            value.baselineTokens = view.baselineTokens;
            value.initialized = true;
            value.resetBaseline = false;
          }
          value.requests = view.requestsSinceCompaction;
          if (view.checkpoint === value.lastCheckpoint) { void record({ type: "skip", reason: "duplicate" }); return; }
          const previousCheckpoint = value.lastCheckpoint;
          value.lastCheckpoint = view.checkpoint;
          if (!eligible(view.evidence, value, policy, now())) { lastSkipReason = "Below usage, growth, request-count, or cooldown threshold"; void record({ type: "skip", reason: "threshold" }); return; }
          const marker = `checkpoint/${sessionID}`;
          if (await ctx.storage.get(marker) === view.checkpoint) { void record({ type: "skip", reason: "duplicate" }); return; }
          value.lastEvaluationAt = now();
          counters.evaluations++;
          evaluationStartedAt = now();
          const result = await judge(view.evidence, judgeOptions(signal));
          if (signal.aborted || revision !== value.revision || !eventStreamHealthy) {
            evaluationRecorded = true;
            void record({ type: "evaluation", outcome: "cancelled", latencyMs: result.latencyMs, ...(result.usage ? { usage: result.usage } : {}), ...(resolvedModel ? { model: resolvedModel } : {}) });
            lastSkipReason = "Judgment cancelled by new direction, execution, compaction, or unload";
            return;
          }
          const compact = shouldCompact(result, policy);
          evaluationRecorded = true;
          void record({ type: "evaluation", outcome: compact ? "compact" : "wait", latencyMs: result.latencyMs, ...(result.usage ? { usage: result.usage } : {}), ...(resolvedModel ? { model: resolvedModel } : {}) });
          lastDecision = { at: now(), sessionID, checkpointID: view.checkpoint, requestSource: view.requestSource, thresholds: { boundary: policy.minProbability, supporting: policy.minSupportingProbability, confidence: policy.minConfidence }, action: compact ? "compact" : "wait", mode: compactionMode(model), providerID: model.providerID, modelID: model.id, judgeModel: result.model, inputTokens: view.evidence.inputTokens, answers: result.answers, latencyMs: result.latencyMs };
          if (!compact) return;
          // Final guard: Jev may have approved while work was active, but a
          // completely idle session must never be compacted. Recheck here so a
          // judgment that finishes after work stopped cannot request compaction.
          const current = activity.state(sessionID);
          if (current.idle) {
            value.lastCheckpoint = previousCheckpoint;
            lastSkipReason = "Session is completely idle: no streaming, subagent, or shell activity";
            lastDecision = { at: now(), sessionID, checkpointID: view.checkpoint, action: "wait", reason: lastSkipReason };
            void record({ type: "skip", reason: "idle" });
            return;
          }
          // Persist only the checkpoint identity, not text; a reload must not repeat it.
          await ctx.storage.set(marker, view.checkpoint);
          if (signal.aborted || revision !== value.revision) return;
          value.pending = true;
          try {
            // Core chooses provider-native versus OpenCode summary from model settings.
            await ctx.session.compact({ sessionID });
            counters.compactionsRequested++;
            void record({ type: "compaction", phase: "requested", mode: compactionMode(model), ...(resolvedModel ? { model: resolvedModel } : {}) });
          } catch {
            value.pending = false;
            throw new Error("Native compaction admission failed");
          }
        } catch {
          if (evaluationStartedAt !== undefined && !evaluationRecorded) {
            void record({ type: "evaluation", outcome: signal.aborted ? "cancelled" : "error", latencyMs: Math.max(0, now() - evaluationStartedAt), ...(resolvedModel ? { model: resolvedModel } : {}) });
          } else if (!signal.aborted) {
            void record({ type: "error" });
          }
          if (!signal.aborted) {
            counters.errors++;
            lastDecision = { at: now(), action: "wait", reason: "Checkpoint evaluation or native admission failed; normal execution continues" };
          }
        } finally {
          if (value.controller === controller) value.controller = undefined;
        }
      }

      await ctx.session.hook("prompt", (event) => { invalidate(event.sessionID); });
      await ctx.session.hook("context", (event) => {
        // A context assembly means a model request is about to run; the agent is
        // active at this point even before its first text delta arrives.
        activity.noteRequest(event.sessionID);
        launch(event.sessionID, event.model);
      });

      return async () => {
        lifetime.abort();
        for (const value of sessions.values()) value.controller?.abort();
        await events;
        while (tasks.size > 0) await Promise.allSettled([...tasks]);
        sessions.clear();
      };
    },
  });
}

export default createPlugin();
