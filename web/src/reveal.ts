// Mirrors src/web/reveal.ts in the main gatekeep package. Duplicated here
// (rather than imported across the package boundary) because this is a
// separate npm package with its own build; the two copies are small and
// the server-side one is the one with tests (tests/web-reveal.test.ts) —
// this one renders purely in the browser and never affects any decision.
const NAMED_INVISIBLES: Record<string, string> = {
  "​": "[ZWSP]",
  "‌": "[ZWNJ]",
  "‍": "[ZWJ]",
  "‎": "[LRM]",
  "‏": "[RLM]",
  "‪": "[LRE]",
  "‫": "[RLE]",
  "‬": "[PDF]",
  "‭": "[LRO]",
  "‮": "[RLO]",
  "⁠": "[WJ]",
  "﻿": "[BOM]",
  " ": "[NBSP]",
};

export function reveal(input: string): string {
  let out = "";
  for (const ch of input) {
    const named = NAMED_INVISIBLES[ch];
    if (named) {
      out += named;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) {
      out += `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
      continue;
    }
    out += ch;
  }
  return out;
}

export function revealDeep(value: unknown): unknown {
  if (typeof value === "string") return reveal(value);
  if (Array.isArray(value)) return value.map(revealDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, revealDeep(v)]));
  }
  return value;
}
