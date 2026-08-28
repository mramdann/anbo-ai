export type RendererFrameGeometry = {
  width: number;
  height: number;
  cols: number;
  rows: number;
};

export function shouldRepairWebglFrame(
  previous: RendererFrameGeometry,
  next: RendererFrameGeometry,
  force = false,
): boolean {
  return (
    force ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.cols !== next.cols ||
    previous.rows !== next.rows
  );
}
