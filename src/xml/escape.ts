/** Minimal XML text/attribute escaping (mirrors Python's xml.sax.saxutils.escape). */
export function escapeXml(value: string, attr = false): string {
  let out = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (attr) out = out.replaceAll('"', "&quot;");
  return out;
}
