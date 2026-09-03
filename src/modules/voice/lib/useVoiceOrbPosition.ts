import {
  clampOrbPosition,
  defaultOrbPosition,
  type OrbPosition,
  type OrbViewport,
  orbX,
} from "@/modules/voice/lib/orbPosition";
import { useCallback, useEffect, useRef, useState } from "react";

const STORE_KEY = "anbo-ui-voice-orb-position";

function viewport(): OrbViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function loadPosition(): OrbPosition {
  const fallback = defaultOrbPosition(viewport());
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return clampOrbPosition(fallback, viewport());
    const parsed = JSON.parse(raw) as Partial<OrbPosition> & {
      side?: "left" | "right";
    };
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return clampOrbPosition({ x: parsed.x, y: parsed.y }, viewport());
    }
    if (
      (parsed.side === "left" || parsed.side === "right") &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return clampOrbPosition(
        { x: orbX(parsed.side, window.innerWidth), y: parsed.y },
        viewport(),
      );
    }
  } catch {}
  return clampOrbPosition(fallback, viewport());
}

function savePosition(position: OrbPosition): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(position));
  } catch {}
}

export function useVoiceOrbPosition() {
  const [position, setPosition] = useState(loadPosition);
  const dragRef = useRef(false);
  const dragPositionRef = useRef<OrbPosition | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => {
        const next = clampOrbPosition(current, viewport());
        savePosition(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const element = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const initial = position;
      dragRef.current = false;
      dragPositionRef.current = initial;
      suppressClickRef.current = false;
      element.setPointerCapture?.(pointerId);

      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        if (!dragRef.current && Math.hypot(dx, dy) < 4) return;
        dragRef.current = true;
        suppressClickRef.current = true;
        const next = clampOrbPosition(
          { x: initial.x + dx, y: initial.y + dy },
          viewport(),
        );
        dragPositionRef.current = next;
        setPosition(next);
      };

      const onEnd = (end: PointerEvent) => {
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onEnd);
        element.removeEventListener("pointercancel", onEnd);
        element.releasePointerCapture?.(pointerId);
        if (dragRef.current) {
          const next = clampOrbPosition(
            dragPositionRef.current ?? initial,
            viewport(),
          );
          savePosition(next);
          setPosition(next);
        }
        dragPositionRef.current = null;
        dragRef.current = false;
        if (end.type === "pointercancel") suppressClickRef.current = false;
      };

      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onEnd);
      element.addEventListener("pointercancel", onEnd);
    },
    [position],
  );

  const consumeSuppressedClick = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  return {
    position,
    style: {
      left: position.x,
      top: position.y,
    },
    onPointerDown,
    consumeSuppressedClick,
  };
}
