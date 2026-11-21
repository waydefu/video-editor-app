/**
 * Parse an HTTP single byte-range request. Unsupported and unsatisfiable
 * ranges are ignored so media playback can retry with a full response.
 * Supports RFC 9110 suffix ranges such as bytes=-500.
 */
export function parseHttpByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | undefined {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
    return undefined;
  return { start, end: Math.min(end, size - 1) };
}
