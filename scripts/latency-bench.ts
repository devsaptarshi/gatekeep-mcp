#!/usr/bin/env node
// Measures the gateway's OWN added latency on allowed (non-approval)
// calls — the spec's target is p95 < 10ms. This benchmarks
// handleToolCall() directly, in-process, against a real on-disk SQLite
// file (not :memory:, which would understate the real WAL/fsync cost of
// an actual deployment) with a no-op upstream — isolating the gateway's
// own overhead (policy decide + audit log append + tag bookkeeping) from
// MCP transport/process/network latency, which is a separate, much larger
// cost this benchmark isn't trying to measure.
//
// Usage: npm run bench:latency
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db/client.js";
import { handleToolCall } from "../src/proxy/call-handler.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { PolicyFileSchema } from "../src/policy/types.js";
import { ToolRegistry } from "../src/proxy/tool-registry.js";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));
const N = Number(process.env.GATEKEEP_BENCH_N ?? 2000);
const WARMUP = 100;

async function main() {
  const dbPath = `${PROJECT_DIR}/data/bench.sqlite`;
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = openDb(dbPath);

  const registry = new ToolRegistry();
  registry.register({ serverId: "bench", toolName: "read_thing", prefixedName: "bench__read_thing", definitionHash: "h1", definition: {} });

  const policyEngine = new PolicyEngine(
    PolicyFileSchema.parse({
      version: "bench",
      defaults: { unknown_tool: "deny", on_gateway_error: "deny", approval_ttl_seconds: 600 },
      servers: { bench: { rules: [{ tool: "read_thing", action: "allow" }] } },
    }),
  );

  const deps = {
    db,
    registry,
    policyEngine,
    principal: "bench-user",
    runId: "bench-run",
    forwardToUpstream: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  };

  // Warm up: JIT, SQLite page cache, WAL file creation — none of that
  // belongs in a measurement of steady-state overhead.
  for (let i = 0; i < WARMUP; i++) {
    await handleToolCall(deps, "bench__read_thing", { i });
  }

  const samplesMs: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await handleToolCall(deps, "bench__read_thing", { i: i + WARMUP });
    samplesMs.push(performance.now() - start);
  }

  samplesMs.sort((a, b) => a - b);
  const pct = (p: number) => samplesMs[Math.min(samplesMs.length - 1, Math.floor((p / 100) * samplesMs.length))]!;
  const mean = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;

  const summary = {
    generatedAt: new Date().toISOString(),
    samples: N,
    meanMs: Number(mean.toFixed(4)),
    p50Ms: Number(pct(50).toFixed(4)),
    p95Ms: Number(pct(95).toFixed(4)),
    p99Ms: Number(pct(99).toFixed(4)),
    maxMs: Number(samplesMs[samplesMs.length - 1]!.toFixed(4)),
    targetP95Ms: 10,
    meetsTarget: pct(95) < 10,
    note: "handleToolCall() in-process against a real on-disk SQLite file, no-op upstream — gateway's own overhead only, not MCP transport/process latency.",
  };

  console.log(JSON.stringify(summary, null, 2));

  mkdirSync(`${PROJECT_DIR}/results`, { recursive: true });
  const resultsPath = `${PROJECT_DIR}/results/latest.json`;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(resultsPath, "utf8")));
  } catch {
    // no existing file yet
  }
  writeFileSync(resultsPath, JSON.stringify({ ...existing, generatedAt: summary.generatedAt, latency: summary }, null, 2));

  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  if (!summary.meetsTarget) {
    console.error(`FAILED: p95 ${summary.p95Ms}ms exceeds the 10ms target.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
