// Serialize-and-truncate helper used for tool args/results and optional payloads.
// Never throws: unserializable values (cycles, BigInt, etc.) degrade to a marker.
const ELLIPSIS = '…';

// Slice a string to at most maxChars UTF-16 code units without splitting a surrogate
// pair: if the cut would land between a high and low surrogate (e.g. mid-emoji), drop
// the dangling high surrogate so the result is always well-formed UTF-16 (a lone
// surrogate corrupts the string when encoded for OTLP export).
export function safeSlice(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const lastKept = value.charCodeAt(maxChars - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

export function safeJsonTruncate(value: unknown, maxChars: number): string {
  let serialized: string | undefined;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  if (serialized === undefined) return '';
  if (maxChars <= 0) return '';
  return serialized.length > maxChars ? safeSlice(serialized, maxChars) + ELLIPSIS : serialized;
}
