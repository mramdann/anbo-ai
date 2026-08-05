import { useTheme } from "@/modules/theme";
import { useEffect, useRef } from "react";

type Node = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

type Spark = {
  from: number;
  to: number;
  progress: number;
  speed: number;
};

const LINK_DISTANCE = 132;
const FRAME_INTERVAL = 1000 / 30;

export function WorkspaceConstellation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeTheme, resolvedMode } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const styles = getComputedStyle(canvas);
    const themeVariant =
      activeTheme.variants[resolvedMode] ??
      activeTheme.variants.dark ??
      activeTheme.variants.light;
    const nodeColor =
      themeVariant?.colors?.primary ??
      styles.getPropertyValue("--primary").trim();
    const sparkColor =
      themeVariant?.colors?.foreground ??
      styles.getPropertyValue("--foreground").trim();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0;
    let height = 0;
    let animationFrame = 0;
    let previousFrame = 0;
    let sparkTimer = 0;
    let nodes: Node[] = [];
    const sparks: Spark[] = [];

    const seed = () => {
      const count = Math.max(
        12,
        Math.min(24, Math.round((width * height) / 24_000)),
      );
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.025,
        vy: (Math.random() - 0.5) * 0.025,
        radius: 1.1 + Math.random() * 1.3,
      }));
      sparks.length = 0;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const neighbors = (): Array<[number, number, number]> => {
      const pairs: Array<[number, number, number]> = [];
      for (let from = 0; from < nodes.length; from += 1) {
        for (let to = from + 1; to < nodes.length; to += 1) {
          const distance = Math.hypot(
            nodes[from].x - nodes[to].x,
            nodes[from].y - nodes[to].y,
          );
          if (distance < LINK_DISTANCE) pairs.push([from, to, distance]);
        }
      }
      return pairs;
    };

    const draw = (pairs: Array<[number, number, number]>) => {
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      context.strokeStyle = nodeColor;
      for (const [from, to, distance] of pairs) {
        context.globalAlpha = (1 - distance / LINK_DISTANCE) * 0.22;
        context.beginPath();
        context.moveTo(nodes[from].x, nodes[from].y);
        context.lineTo(nodes[to].x, nodes[to].y);
        context.stroke();
      }

      context.fillStyle = nodeColor;
      context.globalAlpha = 0.52;
      for (const node of nodes) {
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const drawSparks = (delta: number) => {
      for (let index = sparks.length - 1; index >= 0; index -= 1) {
        const spark = sparks[index];
        const from = nodes[spark.from];
        const to = nodes[spark.to];
        spark.progress += (spark.speed * delta) / 1000;
        if (!from || !to || spark.progress >= 1) {
          sparks.splice(index, 1);
          continue;
        }
        const x = from.x + (to.x - from.x) * spark.progress;
        const y = from.y + (to.y - from.y) * spark.progress;
        const glow = context.createRadialGradient(x, y, 0, x, y, 7);
        glow.addColorStop(0, sparkColor);
        glow.addColorStop(1, "transparent");
        context.fillStyle = glow;
        context.globalAlpha = 0.72;
        context.beginPath();
        context.arc(x, y, 7, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = sparkColor;
        context.globalAlpha = 0.9;
        context.beginPath();
        context.arc(x, y, 1.25, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const frame = (timestamp: number) => {
      animationFrame = requestAnimationFrame(frame);
      if (timestamp - previousFrame < FRAME_INTERVAL) return;
      const delta = previousFrame
        ? Math.min(50, timestamp - previousFrame)
        : FRAME_INTERVAL;
      previousFrame = timestamp;
      for (const node of nodes) {
        node.x += node.vx * delta;
        node.y += node.vy * delta;
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;
      }
      const pairs = neighbors();
      draw(pairs);
      sparkTimer += delta;
      if (sparkTimer > 1800 && pairs.length > 0 && sparks.length < 3) {
        sparkTimer = 0;
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        sparks.push({
          from: pair[0],
          to: pair[1],
          progress: 0,
          speed: 0.65 + Math.random() * 0.35,
        });
      }
      drawSparks(delta);
    };

    const start = () => {
      if (animationFrame || reducedMotion) return;
      previousFrame = 0;
      animationFrame = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!animationFrame) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reducedMotion) draw(neighbors());
    });
    resizeObserver.observe(canvas);
    if (reducedMotion) draw(neighbors());
    else start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeTheme, resolvedMode]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}
