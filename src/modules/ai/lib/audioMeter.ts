export type AudioMeterFrame = Readonly<{
  level: number;
  bands: readonly [number, number, number, number, number];
}>;

export type AudioMeter = Readonly<{
  connect: (stream: MediaStream) => void;
  disconnect: () => void;
  subscribe: (listener: (frame: AudioMeterFrame) => void) => () => void;
}>;

const EMPTY_FRAME: AudioMeterFrame = {
  level: 0,
  bands: [0, 0, 0, 0, 0],
};
const BAND_RANGES = [
  [80, 250],
  [250, 500],
  [500, 1_000],
  [1_000, 2_000],
  [2_000, 4_000],
] as const;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeVoiceLevel(rms: number): number {
  return clampUnit((rms - 0.012) / 0.18) ** 0.65;
}

export function calculateVoiceBands(
  frequencyData: Uint8Array,
  sampleRate: number,
  fftSize: number,
  level: number,
): [number, number, number, number, number] {
  if (frequencyData.length === 0 || sampleRate <= 0 || fftSize <= 0) {
    return [0, 0, 0, 0, 0];
  }

  const hzPerBin = sampleRate / fftSize;
  return BAND_RANGES.map(([low, high]) => {
    const start = Math.max(1, Math.floor(low / hzPerBin));
    const end = Math.min(
      frequencyData.length,
      Math.max(start + 1, Math.ceil(high / hzPerBin)),
    );
    let total = 0;
    for (let index = start; index < end; index += 1) {
      total += frequencyData[index] ?? 0;
    }
    const average = total / Math.max(1, end - start) / 255;
    const band = clampUnit((average - 0.025) / 0.38) ** 0.72;
    return clampUnit(band * (0.22 + level * 0.78));
  }) as [number, number, number, number, number];
}

export function createAudioMeter(): AudioMeter {
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let animationFrame: number | null = null;
  let frame = EMPTY_FRAME;
  let lastSample = 0;
  const listeners = new Set<(next: AudioMeterFrame) => void>();

  const emit = (next: AudioMeterFrame) => {
    frame = next;
    for (const listener of listeners) listener(next);
  };

  const disconnect = () => {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    source?.disconnect();
    analyser?.disconnect();
    source = null;
    analyser = null;
    if (context && context.state !== "closed") void context.close();
    context = null;
    lastSample = 0;
    emit(EMPTY_FRAME);
  };

  const connect = (stream: MediaStream) => {
    disconnect();
    const AudioContextConstructor = globalThis.AudioContext;
    if (typeof AudioContextConstructor !== "function") return;

    try {
      context = new AudioContextConstructor();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.minDecibels = -78;
      analyser.maxDecibels = -18;
      analyser.smoothingTimeConstant = 0.72;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      const timeData = new Uint8Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);

      const sample = (timestamp: number) => {
        if (!context || !analyser) return;
        animationFrame = requestAnimationFrame(sample);
        if (timestamp - lastSample < 32) return;
        lastSample = timestamp;
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(frequencyData);
        let energy = 0;
        for (const sampleValue of timeData) {
          const centered = (sampleValue - 128) / 128;
          energy += centered * centered;
        }
        const level = normalizeVoiceLevel(
          Math.sqrt(energy / Math.max(1, timeData.length)),
        );
        emit({
          level,
          bands: calculateVoiceBands(
            frequencyData,
            context.sampleRate,
            analyser.fftSize,
            level,
          ),
        });
      };

      if (context.state === "suspended") void context.resume();
      animationFrame = requestAnimationFrame(sample);
    } catch {
      disconnect();
    }
  };

  return {
    connect,
    disconnect,
    subscribe(listener) {
      listeners.add(listener);
      listener(frame);
      return () => listeners.delete(listener);
    },
  };
}
