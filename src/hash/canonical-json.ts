// JSON Canonicalization Scheme (RFC 8785 / JCS), restricted to the subset of
// JSON this codebase ever hashes: objects, arrays, strings, finite numbers,
// booleans, null. No support for non-finite numbers (NaN/Infinity aren't
// valid JSON anyway) and no attempt at RFC 8785's exact IEEE-754 string
// serialization for exotic float edge cases — every value gatekeep hashes
// comes from JSON-RPC payloads or our own config, which never carries
// those. Object keys are sorted by UTF-16 code unit, matching JCS.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => compareUtf16(a, b));
    const entries = keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k] as JsonValue)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot canonicalize non-finite number: ${n}`);
  }
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) {
    return String(n);
  }
  // JS's default stringification already matches JCS for the finite,
  // non-integer doubles this codebase ever produces (amounts, scores).
  return String(n);
}

function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}
