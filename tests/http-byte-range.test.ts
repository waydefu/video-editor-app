import { describe, expect, it } from "vitest";
import { parseHttpByteRange } from "../src/main/services/http-byte-range";

describe("HTTP media byte ranges", () => {
  it("supports explicit, open-ended, and suffix ranges", () => {
    expect(parseHttpByteRange("bytes=0-0", 1000)).toEqual({ start: 0, end: 0 });
    expect(parseHttpByteRange("bytes=100-", 1000)).toEqual({ start: 100, end: 999 });
    expect(parseHttpByteRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseHttpByteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseHttpByteRange("bytes=990-2000", 1000)).toEqual({ start: 990, end: 999 });
  });
  it("rejects invalid, zero, and out-of-file ranges without negative reads", () => {
    for (const header of ["bytes=-0", "bytes=-", "bytes=1000-", "bytes=200-100", "bytes=0-1,5-6", "items=0-1"]) {
      expect(parseHttpByteRange(header, 1000)).toBeUndefined();
    }
    expect(parseHttpByteRange("bytes=0-0", 0)).toBeUndefined();
    expect(parseHttpByteRange(null, 1000)).toBeUndefined();
  });
});
