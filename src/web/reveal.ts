// "Reveal mode": renders a string so that characters commonly used to
// disguise what an approver is looking at — zero-width characters, RTL/LTR
// overrides, other invisible formatting codes, and a non-breaking space
// standing in for a normal one — become visible instead of rendering as
// nothing or as an ordinary-looking space. This is purely a DISPLAY aid:
// the policy/hash layer already treats these as ordinary bytes (see the
// Unicode red-team cases in tests/redteam/layer1-corpus.test.ts) and never
// normalizes them away, so an approver who turns this on sees exactly what
// the hash was computed over.

const NAMED_INVISIBLES: Record<string, string> = {
  "​": "[ZWSP]", // zero-width space
  "‌": "[ZWNJ]", // zero-width non-joiner
  "‍": "[ZWJ]", // zero-width joiner
  "‎": "[LRM]", // left-to-right mark
  "‏": "[RLM]", // right-to-left mark
  "‪": "[LRE]", // left-to-right embedding
  "‫": "[RLE]", // right-to-left embedding
  "‬": "[PDF]", // pop directional formatting
  "‭": "[LRO]", // left-to-right override
  "‮": "[RLO]", // right-to-left override — the classic filename-spoofing trick
  "⁠": "[WJ]", // word joiner
  "﻿": "[BOM]", // byte order mark / zero-width no-break space
  " ": "[NBSP]", // non-breaking space — looks identical to a regular space
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
    // Other C0/C1 control characters (not newline/tab, which are fine to
    // show as-is) — surface them rather than letting a terminal/browser
    // eat or misrender them.
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) {
      out += `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Recursively applies `reveal` to every string value in a JSON-ish structure, for displaying arguments. */
export function revealDeep(value: unknown): unknown {
  if (typeof value === "string") return reveal(value);
  if (Array.isArray(value)) return value.map(revealDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, revealDeep(v)]));
  }
  return value;
}
