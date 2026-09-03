import {
  clampOrbX,
  clampOrbPosition,
  defaultOrbPosition,
  nearestOrbSide,
  orbX,
  type OrbPosition,
  type OrbViewport,
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
    const parsed = JSON.parse(raw) as Partial<OrbPosition>;
    if (
      (parsed.side === "left" || parsed.side === "right") &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return clampOrbPosition({ side: parsed.side, y: parsed.y }, viewport());
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
  const [dragX, setDragX] = useState<number | null>(null);
  const dragRef = useRef(false);
  const dragXRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onResize = () =>
      setPosition((current) => clampOrbPosition(current, viewport()));
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
      const initialX = orbX(initial.side, window.innerWidth);
      dragRef.current = false;
      suppressClickRef.current = false;
      element.setPointerCapture?.(pointerId);

      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        if (!dragRef.current && Math.hypot(dx, dy) < 4) return;
        dragRef.current = true;
        suppressClickRef.current = true;
        const nextX = clampOrbX(initialX + dx, window.innerWidth);
        dragXRef.current = nextX;
        setDragX(nextX);
        setPosition(
          clampOrbPosition(
            { side: initial.side, y: initial.y + dy },
            viewport(),
          ),
        );
      };

      const onEnd = (end: PointerEvent) => {
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onEnd);
        element.removeEventListener("pointercancel", onEnd);
        element.releasePointerCapture?.(pointerId);
        if (dragRef.current) {
          setPosition((current) => {
            const next = clampOrbPosition(
              {
                side: nearestOrbSide(
                  dragXRef.current ?? initialX,
                  window.innerWidth,
                ),
                y: current.y,
              },
              viewport(),
            );
            savePosition(next);
            return next;
          });
        }
        dragXRef.current = null;
        setDragX(null);
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
      left: dragX ?? orbX(position.side, window.innerWidth),
      top: position.y,
    },
    onPointerDown,
    consumeSuppressedClick,
  };
}
