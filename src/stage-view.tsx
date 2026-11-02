import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createStage } from "./stage";
import type { Camera, StageLayer } from "./stage";
import type { StageState } from "./types";

/** Native resolution of the source art; the stage maps this to the viewport. */
const DESIGN_WIDTH = 1024;
const DESIGN_HEIGHT = 768;

interface StageViewProps {
  /** Base path for art/, bg/ and sprites/. */
  assets: string;
  stage: StageState;
  /** Slot positions declared by the script. */
  slots?: { l: number; c: number; r: number };
  /** Camera offset from tilt, in design px. */
  offset: { x: number; y: number };
  /** Device tilt that drives the camera; 0 disables it. */
  enabled: boolean;
  onClick: () => void;
  /** Long press: treat the current attitude as the new centre. */
  onRecenter?: () => void;
  /** Reports how far the camera may travel, so the tilt range can match it. */
  onPanRoom?: (room: { x: number; y: number }) => void;
}

/**
 * The visual half of galgame mode: one canvas running the WebGL2 compositor,
 * driven entirely by the interpreter's stage state. The text stays DOM.
 */
export function StageView({
  assets,
  stage,
  slots,
  offset,
  enabled,
  onClick,
  onRecenter,
  onPanRoom,
}: StageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<ReturnType<typeof createStage> | null>(null);
  const holdRef = useRef(0);
  const recenteredRef = useRef(false);
  const previousBgRef = useRef<string | null>(null);
  /** Measured pan travel; the tilt range and the camera clamp both use it. */
  const roomRef = useRef({ x: 0, y: 0 });
  const [failed, setFailed] = useState<string | null>(null);
  /** Crossfade in progress: the outgoing background plus how far it has gone. */
  const [fade, setFade] = useState<{ from: string; progress: number } | null>(null);

  const bgName = stage.bg?.bmp ?? null;
  const bgMs = stage.bg?.ms ?? 0;

  // The script says how long a background swap takes (TR .. t=); honour it
  // instead of cutting. The new image is drawn over the old one, which stays
  // opaque underneath, so a partially loaded texture never shows black.
  useEffect(() => {
    const previous = previousBgRef.current;
    previousBgRef.current = bgName;
    if (!previous || !bgName || previous === bgName || bgMs <= 0) {
      setFade(null);
      return;
    }

    const started = performance.now();
    let frame = 0;
    const step = () => {
      const progress = Math.min(1, (performance.now() - started) / bgMs);
      setFade(progress < 1 ? { from: previous, progress } : null);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [bgName, bgMs]);

  const layers = useMemo<StageLayer[]>(() => {
    const list: StageLayer[] = [];
    const slotOffsets = [slots?.l ?? -250, slots?.c ?? 0, slots?.r ?? 250, slots?.l ?? -250];

    if (fade) {
      list.push({ url: `${assets}bg/${fade.from}.webp`, x: 0, y: 0, width: DESIGN_WIDTH });
    }
    if (bgName) {
      list.push({
        url: `${assets}bg/${bgName}.webp`,
        x: 0,
        y: 0,
        width: DESIGN_WIDTH,
        alpha: fade ? fade.progress : 1,
      });
    }

    stage.sprites.forEach((name, slot) => {
      if (!name) return;
      // Each tachie image is a full-canvas layer with the character drawn at the
      // centre position, so a slot is just a horizontal shift of that canvas.
      list.push({
        url: `${assets}sprites/${name}.webp`,
        x: slotOffsets[slot] ?? 0,
        y: 0,
        width: DESIGN_WIDTH,
      });
    });

    return list;
  }, [assets, bgName, fade?.from, fade?.progress, stage.sprites.join(","), slots?.l, slots?.c, slots?.r]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      handleRef.current = createStage(canvas, { designWidth: DESIGN_WIDTH, designHeight: DESIGN_HEIGHT });
      setFailed(null);
    } catch (error) {
      setFailed(String(error));
      return;
    }

    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setLayers(layers);
  }, [layers]);

  // The pan range is measured, not guessed: a tall phone hides a lot of the 4:3
  // art sideways and nothing vertically, while a wide window is the opposite.
  // Reporting it up lets the tilt sweep exactly to the edges.
  useEffect(() => {
    const report = () => {
      const handle = handleRef.current;
      if (!handle) return;
      const room = handle.panRoom();
      roomRef.current = room;
      onPanRoom?.(room);
    };

    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [onPanRoom]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const room = roomRef.current;
    const camera: Camera = {
      x: DESIGN_WIDTH / 2 + (enabled ? clamp(offset.x, room.x) : 0),
      y: DESIGN_HEIGHT / 2 + (enabled ? clamp(offset.y, room.y) : 0),
      zoom: 1,
    };
    handle.setCamera(camera);
    handle.render();

    // Dev diagnostics: what the app believes it is drawing. Read from the
    // console when a framing question needs an answer instead of a guess.
    if (import.meta.env.DEV) {
      (window as unknown as { __stage?: unknown }).__stage = {
        camera,
        room,
        viewport: { w: canvasClientWidth(), h: canvasClientHeight() },
        layers: layers.map((layer) => ({
          url: layer.url.split("/").pop(),
          x: layer.x,
          y: layer.y,
          width: layer.width,
        })),
      };
    }
  }, [offset.x, offset.y, enabled, layers]);

  return (
    <div
      class="gstage"
      onPointerDown={() => {
        recenteredRef.current = false;
        holdRef.current = window.setTimeout(() => {
          recenteredRef.current = true;
          onRecenter?.();
        }, 500);
      }}
      onPointerUp={() => window.clearTimeout(holdRef.current)}
      onPointerCancel={() => window.clearTimeout(holdRef.current)}
      onClick={() => {
        // a long press recentres the camera instead of advancing
        if (recenteredRef.current) {
          recenteredRef.current = false;
          return;
        }
        onClick();
      }}
    >
      <canvas ref={canvasRef} class="gstage-canvas" />
      {failed && <p class="gstage-fallback">{failed}</p>}
    </div>
  );
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function canvasClientWidth(): number {
  return document.querySelector<HTMLCanvasElement>(".gstage-canvas")?.clientWidth ?? 0;
}

function canvasClientHeight(): number {
  return document.querySelector<HTMLCanvasElement>(".gstage-canvas")?.clientHeight ?? 0;
}
