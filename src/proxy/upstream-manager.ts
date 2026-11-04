import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { UpstreamConfig } from "../config.js";

export interface ConnectedUpstream {
  id: string;
  client: Client;
}

/**
 * Spawns and connects to every configured upstream as a local stdio child
 * process. This is the ONLY place upstreams are started, and it only ever
 * reads from the gateway's own startup config — never from an incoming
 * request. Spawning an upstream from an API call would let a client decide
 * what the gateway executes, which defeats the whole point of a trusted
 * local proxy (see SECURITY.md).
 */
export async function connectUpstreams(configs: UpstreamConfig[]): Promise<ConnectedUpstream[]> {
  const connected: ConnectedUpstream[] = [];
  for (const cfg of configs) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
    const client = new Client({ name: `gatekeep-upstream-${cfg.id}`, version: "0.1.0" });
    await client.connect(transport);
    connected.push({ id: cfg.id, client });
  }
  return connected;
}

export async function closeUpstreams(upstreams: ConnectedUpstream[]): Promise<void> {
  await Promise.all(upstreams.map((u) => u.client.close()));
}
