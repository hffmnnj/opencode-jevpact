import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function runDiagnostic(configured: unknown, actual: unknown) {
  const fixtures: Record<string, unknown> = {
    "/api/info": { version: "test", pid: 1 },
    "/api/plugin": { data: [{ id: "jevpact", state: { status: "active" } }] },
    "/api/rpc/jevpact/status": { output: { enabled: true, configured: true, eventStreamHealthy: true, model: configured } },
    "/api/rpc/jevpact/check": { output: { ok: true, model: actual } },
    "/api/rpc/jevpact/stats": { output: { stats: { version: 1 }, statsStorageErrors: 0 } },
    "/api/model": { data: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra"].map((id) => ({ id, providerID: "openai", settings: { compaction: { type: "native" } } })) },
  };
  const preload = `const fixtures = ${JSON.stringify(fixtures)}; globalThis.fetch = async (url) => { const path = new URL(url).pathname; if (!(path in fixtures)) throw new Error('unexpected request'); return Response.json(fixtures[path]); };`;
  const moduleURL = `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`;
  return spawnSync(process.execPath, ["--import", moduleURL, "scripts/check-live.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "fake-password" },
    encoding: "utf8",
  });
}

test("live diagnostic accepts a configured alias and a different resolved model", () => {
  const result = runDiagnostic("jev-latest", "jev-1.14.0");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status.model, "jev-latest");
  assert.equal(output.check.model, "jev-1.14.0");
  assert.ok(!result.stdout.includes("fake-password"));
});

test("live diagnostic rejects missing or blank configured and actual models", () => {
  for (const [configured, actual] of [["", "jev-1.14.0"], ["jev-latest", "  "], ["jev-latest", null]]) {
    const result = runDiagnostic(configured, actual);
    assert.notEqual(result.status, 0);
    assert.ok(!result.stderr.includes("fake-password"));
  }
});
