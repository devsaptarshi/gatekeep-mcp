#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { PolicyEngine } from "../policy/engine.js";
import { buildGatewayServer } from "./gateway-server.js";
import { checkHeaderBodyConsistency, checkLocalToken, checkOrigin } from "./http-security.js";
import { ToolRegistry } from "./tool-registry.js";
import { closeUpstreams, connectUpstreams } from "./upstream-manager.js";
import { buildWebApi } from "../web/api.js";
import { SessionStore } from "../web/session.js";

const HOST = process.env.GATEKEEP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GATEKEEP_HTTP_PORT ?? 3100);

async function main() {
  const config = loadConfig(process.env.GATEKEEP_CONFIG_PATH ?? "./gatekeep.config.yaml");
  const db = openDb(config.dbPath);
  const policyEngine = PolicyEngine.fromFile(config.policyPath);
  const upstreams = await connectUpstreams(config.upstreams);

  const registry = new ToolRegistry();
  const { pinWarnings } = await registry.build(db, upstreams);
  for (const warning of pinWarnings) console.error(`[gatekeep-http] WARNING: ${warning}`);

  const allowedOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];

  // Stateless, per the 2026-07-28 spec: no sessionIdGenerator means no
  // session IDs, no stream resumability. The SDK enforces this literally —
  // a WebStandardStreamableHTTPServerTransport instance can only ever
  // handle ONE request ("Stateless transport cannot be reused across
  // requests"), so a fresh Server + transport pair is built per request.
  // That's cheap: it's just closures over the shared, expensive state
  // (db, registry, policyEngine, upstreams) built once above — none of
  // that is duplicated. The gateway's own run_id (below) is what ties
  // this request's audit events together; it never depends on a
  // transport-level session, so per-request transports don't fragment it.
  const runId = randomUUID();
  async function handleOneRequest(request: Request, parsedBody: unknown): Promise<Response> {
    const mcpServer = buildGatewayServer({ db, registry, policyEngine, principal: config.principal, upstreams, runId });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    return transport.handleRequest(request, { parsedBody });
  }

  const app = new Hono();

  app.all("/mcp", async (c) => {
    // 1. Anti DNS-rebinding: reject an unexpected Origin outright.
    const originResult = checkOrigin(c.req.header("Origin"), allowedOrigins);
    if (!originResult.ok) {
      return c.json({ error: "forbidden_origin", reason: originResult.reason }, 403);
    }

    // 2. Local token required on every request.
    const tokenResult = checkLocalToken(c.req.header("Authorization"), config.localToken);
    if (!tokenResult.ok) {
      return c.json({ error: "unauthorized", reason: tokenResult.reason }, 401);
    }

    // 3. Header/body consistency. We have to read the body ourselves to
    // check it, then hand the already-parsed body to the transport via
    // `parsedBody` (the Request's own body stream is single-use).
    let parsedBody: unknown;
    if (c.req.method === "POST") {
      const raw = await c.req.text();
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          return c.json({ error: "invalid_json" }, 400);
        }
      }
    }

    const bodyObj = parsedBody as { method?: string; params?: { name?: string } } | undefined;
    const consistency = checkHeaderBodyConsistency({
      mcpMethodHeader: c.req.header("Mcp-Method"),
      mcpNameHeader: c.req.header("Mcp-Name"),
      bodyMethod: bodyObj?.method,
      bodyToolName: bodyObj?.params?.name,
    });
    if (!consistency.ok) {
      return c.json({ error: "header_body_mismatch", reason: consistency.reason }, 400);
    }

    return handleOneRequest(c.req.raw, parsedBody);
  });

  app.get("/healthz", (c) => c.json({ ok: true, tools: registry.list().length, policy: policyEngine.policyVersion }));

  const sessions = new SessionStore();
  app.route("/api", buildWebApi({ db, approverToken: config.approverToken, sessions }));

  const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    console.error(`[gatekeep-http] listening on http://${HOST}:${info.port}/mcp (${registry.list().length} tool(s))`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await closeUpstreams(upstreams);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[gatekeep-http] fatal:", err);
  process.exit(1);
});
