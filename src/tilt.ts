import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * Gyroscope-driven camera offset.
 *
 * The camera is relative, not absolute: the first reading after enabling (or
 * after a long press) becomes the centre, so the view does not depend on how
 * the phone happens to be held. A small dead zone keeps hand tremor from
 * moving the picture, and the output is low-passed because the raw sensor is
 * noisy enough to look like jitter once it drives a 1000px image.
 */

/** Degrees of tilt that pan the stage from edge to edge. */
const RANGE_DEGREES = 18;
/** Ignore tilt inside this cone, in degrees. */
const DEAD_ZONE = 1.6;
/** Fallback travel until the stage reports how much it actually hides. */
const DEFAULT_PAN = { x: 150, y: 90 };
const SMOOTHING = 0.18;

/** Camera travel available in design px; see Stage.panRoom(). */
export interface PanRoom {
  x: number;
  y: number;
}

export interface Tilt {
  offset: { x: number; y: number };
  supported: boolean;
  /** Ask for permission (iOS) and start tracking; safe to call repeatedly. */
  enable: () => Promise<void>;
  /** Make the current attitude the centre again. */
  recenter: () => void;
}

export function useTilt(active: boolean, room: PanRoom = DEFAULT_PAN): Tilt {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [supported, setSupported] = useState(false);
  const [granted, setGranted] = useState(false);
  const roomRef = useRef(room);
  roomRef.current = room;

  const baseRef = useRef<{ beta: number; gamma: number } | null>(null);
  const targetRef = useRef({ x: 0, y: 0 });
  const smoothRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef(0);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "DeviceOrientationEvent" in window);
  }, []);

  const enable = useCallback(async () => {
    type Requestable = { requestPermission?: () => Promise<"granted" | "denied"> };
    const ctor = (window as unknown as { DeviceOrientationEvent?: Requestable }).DeviceOrientationEvent;

    if (ctor && typeof ctor.requestPermission === "function") {
      try {
        const result = await ctor.requestPermission();
        if (result !== "granted") return;
      } catch {
        return;
      }
    }
    baseRef.current = null;
    setGranted(true);
  }, []);

  const recenter = useCallback(() => {
    baseRef.current = null;
    targetRef.current = { x: 0, y: 0 };
  }, []);

  useEffect(() => {
    if (!active || !granted) {
      setOffset({ x: 0, y: 0 });
      return;
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      const { beta, gamma } = event;
      if (beta === null || gamma === null) return;

      if (!baseRef.current) baseRef.current = { beta, gamma };
      const dGamma = gamma - baseRef.current.gamma;
      const dBeta = beta - baseRef.current.beta;

      const applyDeadZone = (value: number) =>
        Math.abs(value) < DEAD_ZONE ? 0 : value - Math.sign(value) * DEAD_ZONE;

      const pan = roomRef.current;
      targetRef.current = {
        x: -clamp(applyDeadZone(dGamma) / RANGE_DEGREES, 1) * pan.x,
        y: clamp(applyDeadZone(dBeta) / RANGE_DEGREES, 1) * pan.y,
      };
    };

    const tick = () => {
      const target = targetRef.current;
      const smooth = smoothRef.current;
      smooth.x += (target.x - smooth.x) * SMOOTHING;
      smooth.y += (target.y - smooth.y) * SMOOTHING;

      if (Math.abs(target.x - smooth.x) < 0.2 && Math.abs(target.y - smooth.y) < 0.2) {
        smooth.x = target.x;
        smooth.y = target.y;
      }

      setOffset((current) =>
        Math.abs(current.x - smooth.x) < 0.1 && Math.abs(current.y - smooth.y) < 0.1
          ? current
          : { x: smooth.x, y: smooth.y },
      );
      frameRef.current = requestAnimationFrame(tick);
    };

    window.addEventListener("deviceorientation", onOrientation);
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      cancelAnimationFrame(frameRef.current);
    };
  }, [active, granted]);

  return { offset, supported, enable, recenter };
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}
