export type OrbSide = "left" | "right";

export type OrbPosition = {
  x: number;
  y: number;
};

export type OrbViewport = {
  width: number;
  height: number;
};

export const ORB_WIDTH = 104;
export const ORB_HEIGHT = 32;
export const ORB_EDGE = 12;
export const ORB_TOP_LIMIT = 52;
export const ORB_BOTTOM_LIMIT = 44;

export function defaultOrbPosition(viewport: OrbViewport): OrbPosition {
  return {
    x: orbX("right", viewport.width),
    y: Math.round(viewport.height * 0.62),
  };
}

export function clampOrbPosition(
  position: OrbPosition,
  viewport: OrbViewport,
): OrbPosition {
  const maxY = Math.max(
    ORB_TOP_LIMIT,
    viewport.height - ORB_BOTTOM_LIMIT - ORB_HEIGHT,
  );
  return {
    x: clampOrbX(position.x, viewport.width),
    y: Math.max(ORB_TOP_LIMIT, Math.min(position.y, maxY)),
  };
}

export function orbX(side: OrbSide, viewportWidth: number): number {
  return side === "left"
    ? ORB_EDGE
    : Math.max(ORB_EDGE, viewportWidth - ORB_EDGE - ORB_WIDTH);
}

export function clampOrbX(x: number, viewportWidth: number): number {
  const maxX = Math.max(ORB_EDGE, viewportWidth - ORB_EDGE - ORB_WIDTH);
  return Math.max(ORB_EDGE, Math.min(x, maxX));
}
