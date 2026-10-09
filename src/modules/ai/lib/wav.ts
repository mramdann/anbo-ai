/** Whisper's own rate; anything higher only makes the upload bigger. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Averages each output sample over its span of input samples, which keeps
 * a 48 kHz recording from folding high frequencies into speech at 16 kHz. */
export function resampleMono(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.floor((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * step);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((index + 1) * step)),
    );
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += samples[source];
    out[index] = sum / (end - start);
  }
  return out;
}

/** 16-bit mono PCM in a RIFF/WAVE container. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}
