export function short(s: string, n = 18) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}
