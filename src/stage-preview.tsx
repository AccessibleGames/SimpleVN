import { useEffect, useRef, useState } from "preact/hooks";
import { createStage } from "./stage";
import type { Camera } from "./stage";
import type { GameSummary } from "./game";

/**
 * Dev harness for the WebGL2 stage: one CG as the background, arrow keys and
 * +/- to drive the camera. This is the same compositor the galgame mode uses,
 * so a problem here is a problem there — but it needs no script data.
 *
 * Open with `?stage`.
 */
export function StagePreview({ game, assets }: { game: GameSummary; assets: string }) {
  // ?stage&img=sprites/g_t001a draws any single image the compositor is given,
  // which is how a framing question gets answered with pixels instead of theory.
  const custom = new URLSearchParams(window.location.search).get("img");
  const artBase = custom ? assets : `${assets}art/`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<ReturnType<typeof createStage> | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 512, y: 384, zoom: 1 });
  const [status, setStatus] = useState("loading");
  /** How far the camera can travel before an edge shows, at this viewport. */
  const [room, setRoom] = useState({ x: 0, y: 0 });

  const entry = game.gallery?.[0];
  const source = custom ?? (entry ? entry.full : null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) {
      setStatus("no image");
      return;
    }

    let stage: ReturnType<typeof createStage>;
    try {
      stage = createStage(canvas, { designWidth: 1024, designHeight: 768 });
    } catch (error) {
      setStatus(`init failed: ${String(error)}`);
      return;
    }
    stageRef.current = stage;
    stage.setLayers([{ url: artBase + source, x: 0, y: 0, width: 1024, anchorX: 0, anchorY: 0 }]);
    void stage.ready().then(() => setStatus(stage.lost ? "context lost" : "ok"));

    return () => {
      stage.destroy();
      stageRef.current = null;
    };
  }, [source, artBase]);

  useEffect(() => {
    stageRef.current?.setCamera(camera);
    stageRef.current?.render();
  }, [camera]);

  useEffect(() => {
    const report = () => {
      const stage = stageRef.current;
      if (stage) setRoom(stage.panRoom());
    };

    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [source, status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const step = event.shiftKey ? 120 : 40;
      setCamera((current) => {
        switch (event.key) {
          case "ArrowLeft":
            return { ...current, x: current.x - step };
          case "ArrowRight":
            return { ...current, x: current.x + step };
          case "ArrowUp":
            return { ...current, y: current.y - step };
          case "ArrowDown":
            return { ...current, y: current.y + step };
          case "+":
          case "=":
            return { ...current, zoom: Math.min(3, current.zoom + 0.1) };
          case "-":
            return { ...current, zoom: Math.max(1, current.zoom - 0.1) };
          default:
            return current;
        }
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main class="stage-preview">
      <canvas ref={canvasRef} class="stage-canvas" />
      <p class="stage-hud">
        {status} · x {Math.round(camera.x)} y {Math.round(camera.y)} · zoom {camera.zoom.toFixed(1)} · pan
        ±{Math.round(room.x)}/±{Math.round(room.y)} · {innerWidth}x{innerHeight}
      </p>
    </main>
  );
}
