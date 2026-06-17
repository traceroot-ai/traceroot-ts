// Serialize-and-truncate helper used for tool args/results and optional payloads.
// Never throws: unserializable values (cycles, BigInt, etc.) degrade to a marker.
const ELLIPSIS = "…";

export function safeJsonTruncate(value: unknown, maxChars: number): string {
  let serialized: string | undefined;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (serialized === undefined) return "";
  if (maxChars <= 0) return "";
  return serialized.length > maxChars ? serialized.slice(0, maxChars) + ELLIPSIS : serialized;
}
