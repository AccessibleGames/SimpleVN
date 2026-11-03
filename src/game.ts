import type { Graph, Pack } from "./content";

export type { Graph, Pack };

/** One image in the appreciation gallery, produced by tools/build-art.mjs. */
export interface GalleryEntry {
  id: string;
  /** Variants of one CG share a group (ev001a / ev001b -> ev001). */
  group: string;
  label: string;
  full: string;
  thumb: string;
  w: number;
  h: number;
}

/**
 * Everything the menu can show without paying for the script: the title, which
 * locales exist, and the image manifests. The graph and the text packs are
 * loaded only when a game is actually opened — they are megabytes each.
 */
export interface GameSummary {
  id: string;
  title: string;
  /** Language the script was authored in; other packs are overlays on top of it. */
  sourceLocale: string;
  /** Locales that have a text pack on disk. */
  locales: string[];
  /** Native pixel size of the stage art; two games of one engine can differ. */
  design?: { w: number; h: number };
  gallery?: GalleryEntry[];
  /** Stage backgrounds, from content/bg.json. */
  bg?: GalleryEntry[];
  /** Tachie layers, from content/sprites.json. */
  sprites?: GalleryEntry[];
}

/**
 * One game's data, loaded statically so Vite bundles exactly the games that are
 * imported. A release build aliases `@games` to a single game module, so the
 * other games' content never enters the bundle.
 */
export interface GameContent extends GameSummary {
  graph: Graph;
  packs: Record<string, Pack>;
}

/** Restartable snapshot of a playthrough. */
export interface SaveState {
  decisions: string[];
  limit: number;
  marks: { from: number; to: number }[];
  temp: { id: number; line: number; delta: number; text: string }[];
  pinned: { id: number; line: number; delta: number; text: string }[];
  /** Which chapter the reader was in, for the save list. */
  caption?: string;
  /** Set when the session replays a single scene rather than the whole script. */
  from?: string;
  savedAt: number;
}

const SAVE_PREFIX = "vn.save.";

function keyOf(gameId: string, slot: string): string {
  return `${SAVE_PREFIX}${gameId}.${slot}`;
}

export const AUTO_SLOT = "auto";

/** Manual slots the reader can write to; the autosave slot is separate. */
export const SAVE_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8"];

/** Timestamp shown in save lists; the same format in the menu and in game. */
export function formatSaveTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function readSave(gameId: string, slot: string): SaveState | null {
  try {
    const raw = window.localStorage.getItem(keyOf(gameId, slot));
    return raw ? (JSON.parse(raw) as SaveState) : null;
  } catch {
    return null;
  }
}

export function writeSave(gameId: string, slot: string, state: SaveState): void {
  try {
    window.localStorage.setItem(keyOf(gameId, slot), JSON.stringify(state));
  } catch {
    // storage full or disabled: playing continues, saving just does not persist
  }
}

/** Manual slots are removable; the autosave slot is owned by the reader. */
export function removeSave(gameId: string, slot: string): void {
  try {
    window.localStorage.removeItem(keyOf(gameId, slot));
  } catch {
    // ignore
  }
}

export function listSaves(gameId: string): { slot: string; state: SaveState }[] {
  const out: { slot: string; state: SaveState }[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(`${SAVE_PREFIX}${gameId}.`)) continue;
      const slot = key.slice(`${SAVE_PREFIX}${gameId}.`.length);
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      out.push({ slot, state: JSON.parse(raw) as SaveState });
    }
  } catch {
    // ignore
  }
  return out.sort((a, b) => b.state.savedAt - a.state.savedAt);
}
