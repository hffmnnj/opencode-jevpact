const baseURL = "http://127.0.0.1:4108";
const directory = process.argv[2] ?? "/home/james/.config/opencode-v2";
const password = process.env.OPENCODE_SERVER_PASSWORD;
if (!password) throw new Error("OPENCODE_SERVER_PASSWORD must be available in the environment");
const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const query = new URLSearchParams({ "location[directory]": directory });

async function request(path: string, method = "GET"): Promise<unknown> {
  const response = await fetch(`${baseURL}${path}?${query}`, {
    method,
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ input: {} }) } : {}),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`OpenCode diagnostic HTTP ${response.status}`);
  return await response.json();
}

const info = await request("/api/info") as { version: string; pid: number };
const plugins = await request("/api/plugin") as { data: Array<{ id: string; state: { status: string } }> };
const plugin = plugins.data.find((value) => value.id === "jevpact");
if (plugin?.state.status !== "active") throw new Error("Jev checkpoint plugin is not active");
const status = await request("/api/rpc/jevpact/status", "POST") as { output: { enabled: boolean; configured: boolean; eventStreamHealthy: boolean; model: string } };
if (!status.output.enabled || !status.output.configured || !status.output.eventStreamHealthy || status.output.model !== "jev-1.14.0") throw new Error("Jev plugin is not enabled, configured, and observing events");
const check = await request("/api/rpc/jevpact/check", "POST") as { output: { ok: boolean; model: string } };
if (!check.output.ok || check.output.model !== "jev-1.14.0") throw new Error("Jev live diagnostic did not pass");
const models = await request("/api/model") as { data: Array<{ providerID: string; id: string; settings?: { compaction?: { type: string } } }> };
const routes = models.data.filter((model) => model.providerID === "openai" && ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra"].includes(model.id)).map((model) => ({ providerID: model.providerID, modelID: model.id, compaction: model.settings?.compaction?.type }));
if (routes.length !== 3 || routes.some((route) => route.compaction !== "native")) throw new Error("Expected OpenAI native compaction settings were not resolved");
const summaryRoutes = models.data.filter((model) => (model.providerID === "anthropic" && model.id === "claude-sonnet-5-5") || (model.providerID === "opencode-go" && model.id === "deepseek-v4.1-flash")).map((model) => ({ providerID: model.providerID, modelID: model.id, compaction: model.settings?.compaction?.type ?? "summary" }));
console.log(JSON.stringify({ server: { version: info.version, pid: info.pid }, plugin: { id: plugin.id, status: plugin.state.status }, status: status.output, check: check.output, routes, summaryRoutes }, null, 2));
