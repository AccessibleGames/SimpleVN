import type { GalleryEntry, GameContent, GameSummary, Graph, Pack } from "./game";

/**
 * Dev registry. Everything here comes from the filesystem, so adding a game is
 * adding a folder:
 *
 *   games/<id>/game.json          { id, title, sourceLocale }
 *   games/<id>/content/graph.json
 *   games/<id>/content/<lang>/pack.json
 *
 * Only the small manifests are loaded eagerly so the menu can list games; the
 * graph and the text packs are fetched when a game is opened. A graph is a
 * couple of megabytes and the pack is another two, which is the difference
 * between a menu that appears immediately and one that waits for both.
 *
 * Release builds do not use this file: `tools/build-game-module.mjs` generates a
 * module for one game instead (see `src/games.gen.ts`).
 */

type Meta = { id: string; title: string; sourceLocale: string };
type Manifest = { entries: GalleryEntry[] };

const metas = import.meta.glob<Meta>("../games/*/game.json", { eager: true, import: "default" });
const manifests = import.meta.glob<Manifest>(
  "../games/*/content/{gallery,bg,sprites}.json",
  { eager: true, import: "default" },
);
const graphs = import.meta.glob<Graph>("../games/*/content/graph.json");
const packs = import.meta.glob<Pack>("../games/*/content/*/pack.json");

/** "../games/yukikaze1/content/ja/pack.json" -> { game, parts: ["ja","pack.json"] } */
function splitKey(key: string): { game: string; parts: string[] } | null {
  const match = /^\.\.\/games\/([^/]+)\/content\/(.+)$/.exec(key);
  return match ? { game: match[1], parts: match[2].split("/") } : null;
}

const entries = new Map<string, GameSummary & { graphKey?: string; packKeys: Record<string, string> }>();

function slot(id: string, meta?: Meta) {
  let found = entries.get(id);
  if (!found) {
    found = {
      id,
      title: meta?.title ?? id,
      sourceLocale: meta?.sourceLocale ?? "ja",
      locales: [],
      packKeys: {},
    };
    entries.set(id, found);
  }
  if (meta) {
    found.title = meta.title;
    found.sourceLocale = meta.sourceLocale;
  }
  return found;
}

for (const [key, meta] of Object.entries(metas)) {
  const id = /^\.\.\/games\/([^/]+)\//.exec(key)?.[1];
  if (id) slot(id, meta);
}

for (const [key, value] of Object.entries(manifests)) {
  const split = splitKey(key);
  if (!split) continue;
  const entry = slot(split.game);
  const list = value.entries;
  if (split.parts[0] === "gallery.json") entry.gallery = list;
  else if (split.parts[0] === "bg.json") entry.bg = list;
  else if (split.parts[0] === "sprites.json") entry.sprites = list;
}

for (const key of Object.keys(graphs)) {
  const split = splitKey(key);
  if (split) slot(split.game).graphKey = key;
}

for (const key of Object.keys(packs)) {
  const split = splitKey(key);
  if (!split || split.parts.length !== 2) continue;
  const entry = slot(split.game);
  entry.packKeys[split.parts[0]] = key;
  if (!entry.locales.includes(split.parts[0])) entry.locales.push(split.parts[0]);
}

export const games: GameSummary[] = [...entries.values()]
  .filter((entry) => entry.graphKey)
  .map(({ graphKey: _graphKey, packKeys: _packKeys, ...summary }) => ({
    ...summary,
    locales: summary.locales.sort(),
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** Loads one game's script and text packs; the menu works without them. */
export async function loadGame(id: string): Promise<GameContent | null> {
  const entry = entries.get(id);
  if (!entry?.graphKey) return null;

  const [graph, ...loaded] = await Promise.all([
    graphs[entry.graphKey](),
    ...Object.values(entry.packKeys).map((key) => packs[key]()),
  ]);

  const merged: Record<string, Pack> = {};
  Object.keys(entry.packKeys).forEach((locale, index) => {
    merged[locale] = loaded[index] as Pack;
  });

  return {
    id: entry.id,
    title: entry.title,
    sourceLocale: entry.sourceLocale,
    locales: entry.locales,
    graph: graph as Graph,
    packs: merged,
    gallery: entry.gallery,
    bg: entry.bg,
    sprites: entry.sprites,
  };
}
