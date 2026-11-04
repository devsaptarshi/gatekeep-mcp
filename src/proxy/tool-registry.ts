import { appendEvent } from "../audit/log.js";
import { computeToolDefinitionHash } from "../hash/call-hash.js";
import type { JsonValue } from "../hash/canonical-json.js";
import type { GatekeepDb } from "../db/client.js";
import { checkAndRecordPin } from "../db/repositories/tool-pins.js";
import type { ConnectedUpstream } from "./upstream-manager.js";

export const PREFIX_SEP = "__";

export interface RegisteredTool {
  serverId: string;
  toolName: string; // bare, as the upstream knows it
  prefixedName: string; // "<serverId>__<toolName>", what the client sees
  definitionHash: string;
  definition: Record<string, unknown>;
}

export interface BuildResult {
  tools: RegisteredTool[];
  pinWarnings: string[];
}

export class ToolRegistry {
  private byPrefixedName = new Map<string, RegisteredTool>();

  /**
   * Fetches tools/list from every upstream, computes each tool's
   * definition hash, and checks it against the DB-pinned hash from the
   * last time the gateway saw that tool — surfacing rug pulls rather than
   * silently trusting a changed definition.
   */
  async build(db: GatekeepDb, upstreams: ConnectedUpstream[], runId = "startup"): Promise<BuildResult> {
    const warnings: string[] = [];
    this.byPrefixedName.clear();

    for (const upstream of upstreams) {
      const result = await upstream.client.listTools();
      for (const tool of result.tools) {
        const definition = tool as unknown as Record<string, unknown>;
        const definitionHash = computeToolDefinitionHash(definition as JsonValue);
        const pinResult = checkAndRecordPin(db, upstream.id, tool.name, definitionHash);
        if (pinResult.kind === "changed") {
          const warning =
            `tool "${upstream.id}/${tool.name}" definition changed since it was pinned ` +
            `(was ${pinResult.previousHash.slice(0, 12)}…, now ${definitionHash.slice(0, 12)}…) — ` +
            `review and re-pin before trusting it (see src/db/repositories/tool-pins.ts#repin)`;
          warnings.push(warning);
          appendEvent(db, {
            runId,
            event: "tool_definition_changed",
            payload: {
              server_id: upstream.id,
              tool_name: tool.name,
              previous_definition_hash: pinResult.previousHash,
              new_definition_hash: definitionHash,
            },
          });
        }
        const prefixedName = `${upstream.id}${PREFIX_SEP}${tool.name}`;
        this.register({ serverId: upstream.id, toolName: tool.name, prefixedName, definitionHash, definition });
      }
    }

    return { tools: [...this.byPrefixedName.values()], pinWarnings: warnings };
  }

  /** Public so tests can seed a registry without a real upstream connection. */
  register(tool: RegisteredTool): void {
    this.byPrefixedName.set(tool.prefixedName, tool);
  }

  get(prefixedName: string): RegisteredTool | undefined {
    return this.byPrefixedName.get(prefixedName);
  }

  list(): RegisteredTool[] {
    return [...this.byPrefixedName.values()];
  }
}
