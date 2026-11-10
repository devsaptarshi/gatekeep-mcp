#!/usr/bin/env node
// Optional upstream for the gateway's demo, bridging the two sibling
// projects: a single ask_erp tool that calls the erp-analyst-agent's own
// FastAPI backend (src/erp_analyst/api/app.py over there) and returns
// whatever it answers. Read-only end to end — the agent behind this has
// no write tool at the application layer, and its DB role has no
// INSERT/UPDATE/DELETE grants either (see that project's SECURITY.md) —
// but it still goes through the gateway: the point is to show that even a
// "safe-by-construction" read-only agent benefits from an independent
// human-in-the-loop layer that knows nothing about SQL or RLS, only about
// the shape of the call. See this repo's policies/default.yaml for why
// ask_erp is routed to "approve" rather than auto-allowed despite being
// read-only.
//
// Requires the erp-analyst-agent API running locally (`uvicorn
// erp_analyst.api.main:app`) at ERP_ANALYST_API_URL (default
// http://127.0.0.1:8000). Untested against a live instance in this
// environment — no ANTHROPIC_API_KEY, same honest gap as the rest of
// that project's live-model paths; see its KNOWN_LIMITS.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.ERP_ANALYST_API_URL ?? "http://127.0.0.1:8000";

const server = new McpServer({ name: "erp-analyst-tool", version: "0.1.0" });

server.registerTool(
  "ask_erp",
  {
    title: "Ask the ERP analyst agent",
    description:
      "Ask a plain-English analytics question about one tenant's manufacturing ERP data " +
      "(suppliers, production yield, revenue, quality). Read-only. Answers may ask a " +
      "clarifying question back instead of data, or honestly say the data can't answer it.",
    inputSchema: { question: z.string(), tenantName: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ question, tenantName }) => {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, tenant_name: tenantName }),
      });
    } catch (err) {
      return {
        content: [{ type: "text", text: `Could not reach the ERP analyst API at ${API_URL}: ${String(err)}` }],
        isError: true,
      };
    }
    if (!response.ok) {
      const body = await response.text();
      return { content: [{ type: "text", text: `ERP analyst API returned ${response.status}: ${body}` }], isError: true };
    }
    const body = (await response.json()) as {
      answer: string | null;
      sql: string | null;
      rows: unknown[] | null;
      confidence: string | null;
      clarification_question: string | null;
    };
    if (body.clarification_question) {
      return { content: [{ type: "text", text: `Clarification needed: ${body.clarification_question}` }] };
    }
    const lines = [body.answer ?? "(no answer)"];
    if (body.confidence) lines.push(`Confidence: ${body.confidence}`);
    if (body.sql) lines.push(`SQL used: ${body.sql}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
