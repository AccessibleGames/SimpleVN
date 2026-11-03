#!/usr/bin/env node
/**
 * Check that every game's stage can actually find its pictures.
 *
 *   node --experimental-strip-types tools/check-stage-assets.mjs [gameId ...]
 *
 * For each scene the reader can replay, run the interpreter to that page, take the
 * background it asks for, resolve the name through the game's manifest, and confirm
 * the file the stage would request exists on disk. The same for the sprites on
 * stage at that moment.
 *
 * Why this rather than a screenshot: a screenshot proves one frame, this walks
 * every entry point a reader can jump to, and it needs no browser. Names that do
 * not resolve are reported but are not failures - a game may legitimately have
 * animations, solid colour scenes and composite images.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { run } = await import(`file:///${root.replace(/\\/g, "/")}/src/engine.ts`);
const { materialize } = await import(`file:///${root.replace(/\\/g, "/")}/src/content.ts`);

const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const gamesDir = join(root, "games");
const ids = wanted.length
  ? wanted
  : readdirSync(gamesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => existsSync(join(gamesDir, id, "content", "graph.json")));

let failures = 0;

for (const id of ids) {
  const base = join(gamesDir, id);
  const graphPath = join(base, "content", "graph.json");
  if (!existsSync(graphPath)) {
    console.log(`${id}: no graph, skipped`);
    continue;
  }

  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const meta = JSON.parse(readFileSync(join(base, "game.json"), "utf8"));
  const locale = meta.sourceLocale ?? "en";
  const packPath = join(base, "content", locale, "pack.json");
  const pack = existsSync(packPath) ? JSON.parse(readFileSync(packPath, "utf8")) : { text: {}, names: {} };

  const listOf = (name) => {
    const path = join(base, "content", `${name}.json`);
    if (!existsSync(path)) return new Map();
    const { entries } = JSON.parse(readFileSync(path, "utf8"));
    return new Map(entries.map((entry) => [entry.id, entry.full]));
  };
  const bgIndex = listOf("bg");
  const spriteIndex = listOf("sprites");

  const story = materialize(graph, pack);
  const scenes = story.scenes ?? [];
  const problems = [];
  let ran = 0;
  let bgFound = 0;
  let spriteFound = 0;
  let spriteChecked = 0;

  for (const scene of scenes) {
    let view;
    try {
      view = run(story, [], 40, scene.node);
    } catch (error) {
      problems.push(`scene ${scene.caption}: interpreter failed (${error.message})`);
      failures++;
      continue;
    }
    ran++;

    const bgName = view.stage?.bg?.bmp;
    if (bgName) {
      const file = bgIndex.get(bgName);
      if (file && existsSync(join(base, "public", "bg", file))) bgFound++;
      else problems.push(`background unresolved: ${bgName}`);
    }

    for (const sprite of view.stage?.sprites ?? []) {
      if (!sprite) continue;
      spriteChecked++;
      const file = spriteIndex.get(sprite);
      if (file && existsSync(join(base, "public", "sprites", file))) spriteFound++;
      else problems.push(`sprite unresolved: ${sprite}`);
    }
  }

  // A choice whose every option leads nowhere is the one failure a reader feels
  // as a freeze: the click lands and nothing follows. Every asset can resolve
  // and this still bites, which is why it is checked here and not by eye.
  let menuCount = 0;
  let deadMenus = 0;
  let nullOptions = 0;
  const deadSamples = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (!node.choices) continue;
    menuCount++;
    const nulls = node.choices.filter((choice) => !choice.next).length;
    nullOptions += nulls;
    if (nulls === node.choices.length) {
      deadMenus++;
      failures++;
      if (deadSamples.length < 3) deadSamples.push(nodeId);
    }
  }

  console.log(`${id} (${locale}, design ${JSON.stringify(meta.design ?? { w: 1024, h: 768 })})`);
  console.log(`  scenes ${ran}/${scenes.length}, backgrounds resolved ${bgFound}, sprites resolved ${spriteFound}/${spriteChecked}`);
  console.log(
    `  menus ${menuCount}, options with no target ${nullOptions}${deadMenus ? `, DEAD-END MENUS ${deadMenus}: ${deadSamples.join(", ")}` : ""}`,
  );
  const unique = [...new Set(problems)];
  if (unique.length) {
    console.log(`  unresolved: ${unique.length}`);
    for (const line of unique.slice(0, 5)) console.log(`    ${line}`);
  }
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
