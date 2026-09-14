import { test, expect } from 'bun:test';
import { byteRange } from '../web/range';

test('browser MP4 range requests', () => {
  expect(byteRange(undefined, 100)).toEqual({ start: 0, end: 99 });
  expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
  expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=5-3', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=NaN-2']) expect(byteRange(bad, 100)).toBeNull();
  expect(byteRange(undefined, 0)).toBeNull();
});
