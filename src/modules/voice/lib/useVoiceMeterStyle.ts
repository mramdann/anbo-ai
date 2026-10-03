import type { AudioMeter } from "@/modules/ai/lib/audioMeter";
import { type RefObject, useEffect } from "react";

/**
 * Drives an orb's ring, glow and bars from the live meter while it records,
 * through CSS properties named `${prefix}-ring-scale` and so on, and rests
 * them at silence otherwise.
 */
export function useVoiceMeterStyle(
  ref: RefObject<HTMLElement | null>,
  prefix: string,
  meter: AudioMeter,
  recording: boolean,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (level: number, bands: readonly number[]) => {
      element.style.setProperty(
        `${prefix}-ring-scale`,
        (1.08 + level * 0.34).toFixed(3),
      );
      element.style.setProperty(
        `${prefix}-ring-opacity`,
        (0.18 + level * 0.5).toFixed(3),
      );
      element.style.setProperty(
        `${prefix}-glow`,
        `${Math.round(5 + level * 14)}px`,
      );
      bands.forEach((band, index) => {
        element.style.setProperty(
          `${prefix}-bar-${index + 1}`,
          `${(3 + band * 9).toFixed(1)}px`,
        );
      });
    };
    if (!recording) {
      apply(0, [0, 0, 0, 0, 0]);
      return;
    }
    return meter.subscribe((frame) => {
      apply(frame.level, frame.bands);
    });
  }, [ref, prefix, meter, recording]);
}
