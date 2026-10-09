// no-inline: a file this small would otherwise ship as a data: URL, which
// the app's CSP (script-src 'self') refuses to load as a worklet.
import workletUrl from "./pcmCapture.worklet.js?url&no-inline";
import { resampleMono, WHISPER_SAMPLE_RATE } from "./wav";

/** The worklet posts one block per 100 ms of audio. */
const BLOCKS_PER_SECOND = 10;
/** A minute past the longest take. Whatever goes wrong upstream, the
 * capture never grows past about 23 MB. */
const MAX_BLOCKS = 6 * 60 * BLOCKS_PER_SECOND;

/**
 * A take's audio as 16 kHz mono while it records, for live text. Decoding the
 * recorder's own file every second or two would cost more the longer a take
 * runs; these blocks cost the same at any length, and five minutes (the
 * longest take) hold about 19 MB.
 */
export type PcmTake = {
  /** Seconds captured so far. */
  seconds(): number;
  /** The samples between two points of the take, in seconds. */
  slice(from: number, to?: number): Float32Array;
  /** The loudest 100 ms block between two points, as RMS. */
  peak(from: number, to?: number): number;
};

export function createPcmTake(): PcmTake & { push(block: Float32Array): void } {
  const blocks: Float32Array[] = [];
  const levels: number[] = [];
  const index = (seconds: number) =>
    Math.max(
      0,
      Math.min(blocks.length, Math.round(seconds * BLOCKS_PER_SECOND)),
    );
  return {
    push(block) {
      if (block.length === 0 || blocks.length >= MAX_BLOCKS) return;
      let energy = 0;
      for (const sample of block) energy += sample * sample;
      blocks.push(block);
      levels.push(Math.sqrt(energy / Math.max(1, block.length)));
    },
    seconds: () => blocks.length / BLOCKS_PER_SECOND,
    slice(from, to = Number.POSITIVE_INFINITY) {
      const parts = blocks.slice(index(from), index(to));
      const out = new Float32Array(
        parts.reduce((total, part) => total + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },
    peak(from, to = Number.POSITIVE_INFINITY) {
      let loudest = 0;
      for (let at = index(from); at < index(to); at += 1) {
        loudest = Math.max(loudest, levels[at]);
      }
      return loudest;
    },
  };
}

export type PcmCapture = PcmTake & { stop(): void };

/** Taps `stream` alongside the recorder. Throws when this WebView cannot run
 * an audio worklet; the recording itself does not depend on it. */
export async function startPcmCapture(
  stream: MediaStream,
): Promise<PcmCapture> {
  // Playback latency lets the audio thread wake less often; nothing here is
  // heard, so the delay costs nothing.
  const context = new AudioContext({ latencyHint: "playback" });
  const take = createPcmTake();
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  const stop = () => {
    if (node) node.port.onmessage = null;
    source?.disconnect();
    node?.disconnect();
    if (context.state !== "closed") void context.close();
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "anbo-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      take.push(resampleMono(data, context.sampleRate, WHISPER_SAMPLE_RATE));
    };
    source.connect(node);
    if (context.state === "suspended") void context.resume();
  } catch (error) {
    stop();
    throw error;
  }
  return {
    seconds: take.seconds,
    slice: take.slice,
    peak: take.peak,
    stop,
  };
}
