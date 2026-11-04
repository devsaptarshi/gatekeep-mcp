/** Constant-time-ish string comparison for secrets (tokens, CSRF values). */
export function timingSafeEqual(a: string, b: string): boolean {
  // Lengths almost never match for a wrong guess anyway, but avoid the
  // obvious early-exit-on-length shortcut some naive comparisons use.
  const maxLen = Math.max(a.length, b.length, 32);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
