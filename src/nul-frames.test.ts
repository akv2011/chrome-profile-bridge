import { describe, expect, it } from "vitest";
import { NulFramer } from "./nul-frames.ts";

const frames = (chunks: string[]): string[] => {
  const out: string[] = [];
  const f = new NulFramer();
  for (const c of chunks) f.push(Buffer.from(c), (frame) => out.push(frame.toString()));
  return out;
};

describe("NulFramer", () => {
  it("splits several frames in one chunk and joins one frame across chunks", () => {
    expect(frames(['{"a":1}\0{"b":2}\0'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(frames(['{"a"', ":1", "}\0"])).toEqual(['{"a":1}']);
    expect(frames(['{"a":1}\0{"b"', ":2}\0{\"c\":3}\0"])).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(frames(["partial-no-nul"])).toEqual([]);
  });

  it("handles a 40 MB frame in 64 KB chunks in linear time", () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 0x61);
    const f = new NulFramer();
    let got = 0;
    const t0 = Date.now();
    for (let i = 0; i < big.length; i += 64 * 1024) f.push(big.subarray(i, i + 64 * 1024), () => {});
    f.push(Buffer.from([0]), (frame) => (got = frame.length));
    expect(got).toBe(big.length);
    expect(Date.now() - t0).toBeLessThan(2_000); // the quadratic version took minutes
  });
});
