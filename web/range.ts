// Single-range streaming is enough for browser MP4 seeking. Reject malformed/multiple ranges.
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const a = Number(match[1]), b = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (suffix && b <= 0)) return null;
  const start = suffix ? Math.max(0, size - b) : a;
  const end = suffix ? size - 1 : Math.min(b, size - 1);
  return start >= size || start > end ? null : { start, end };
}
