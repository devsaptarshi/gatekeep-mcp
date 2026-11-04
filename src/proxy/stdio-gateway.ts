#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { PolicyEngine } from "../policy/engine.js";
import { buildGatewayServer } from "./gateway-server.js";
import { ToolRegistry } from "./tool-registry.js";
import { closeUpstreams, connectUpstreams } from "./upstream-manager.js";

async function main() {
  const config = loadConfig(process.env.GATEKEEP_CONFIG_PATH ?? "./gatekeep.config.yaml");
  const db = openDb(config.dbPath);
  const policyEngine = PolicyEngine.fromFile(config.policyPath);

  // Upstreams are spawned ONLY from this startup config — never from an
  // incoming request (see SECURITY.md).
  const upstreams = await connectUpstreams(config.upstreams);

  const registry = new ToolRegistry();
  const { pinWarnings } = await registry.build(db, upstreams);
  for (const warning of pinWarnings) {
    console.error(`[gatekeep] WARNING: ${warning}`);
  }

  const runId = randomUUID();
  const server = buildGatewayServer({
    db,
    registry,
    policyEngine,
    principal: config.principal,
    upstreams,
    runId,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[gatekeep] ready — ${registry.list().length} tool(s) from ${upstreams.length} upstream(s), policy ${policyEngine.policyVersion}`,
  );

  // The gateway owns these upstream child processes (it spawned them from
  // its own local config) — when the gateway itself is torn down, by its
  // client disconnecting or by a signal, nothing else will clean them up.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeUpstreams(upstreams);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  transport.onclose = () => void shutdown();
}

main().catch((err) => {
  console.error("[gatekeep] fatal:", err);
  process.exit(1);
});
