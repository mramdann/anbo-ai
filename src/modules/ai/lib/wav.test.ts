import { describe, expect, it } from "vitest";
import { encodeWav, resampleMono } from "./wav";

describe("resampleMono", () => {
  it("averages each span when going from 48 kHz to 16 kHz", () => {
    const samples = Float32Array.from([0, 0.3, 0.6, 1, 1, 1]);
    const out = resampleMono(samples, 48_000, 16_000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(1);
  });

  it("returns the same samples at the same rate", () => {
    const samples = Float32Array.from([0.1, 0.2]);
    expect(resampleMono(samples, 16_000, 16_000)).toBe(samples);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono RIFF header and clamped samples", async () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), 16_000);
    expect(wav.type).toBe("audio/wav");
    const view = new DataView(await wav.arrayBuffer());
    const text = (offset: number) =>
      String.fromCharCode(
        ...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)),
      );
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect(
      [0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true)),
    ).toEqual([0, 32767, -32768, 32767]);
  });
});
