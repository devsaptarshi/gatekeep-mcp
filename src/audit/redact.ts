import type { JsonValue } from "../hash/canonical-json.js";

// Patterns for the common shapes of secret that show up in tool
// arguments/results and must never reach the audit log in the clear:
// bearer tokens, common vendor key prefixes, long hex/base64 blobs that
// are almost certainly keys/secrets rather than ordinary data. This is a
// best-effort denylist, not a guarantee — see KNOWN_LIMITS.md.
const PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /\b(sk|pk)_(live|test)_[A-Za-z0-9]{10,}/gi, // Stripe-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gi, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex (API keys, SHA digests of secrets, etc.)
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, // long base64-looking blobs
];

const REDACTED = "[REDACTED]";

function redactString(s: string): string {
  let out = s;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Recursively redacts likely secrets from a JSON value before it's logged. */
export function redact(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      // Keys that are secrets by name, regardless of what they look like.
      if (/token|secret|password|api[_-]?key|authorization/i.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}
