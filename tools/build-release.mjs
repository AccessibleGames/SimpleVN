#!/usr/bin/env node
/**
 * Build one game as a standalone release.
 *
 *   node tools/build-release.mjs <gameId>            # dist/<gameId>
 *   node tools/build-release.mjs <gameId> --preview   # build, then serve it
 *
 * Generates the single-game module first, so only that game's content is
 * bundled and the game switcher disappears from the menu.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const gameId = args.find((arg) => !arg.startsWith("--"));
const preview = args.includes("--preview");

if (!gameId) {
  console.error("usage: node tools/build-release.mjs <gameId> [--preview]");
  process.exit(1);
}

const metaPath = join("games", gameId, "game.json");
if (!existsSync(metaPath)) {
  console.error(`no game at ${metaPath}`);
  process.exit(1);
}

const env = { ...process.env, GAME: gameId };

const generate = spawnSync(process.execPath, ["tools/build-game-module.mjs", "--game", gameId], {
  stdio: "inherit",
  env,
});
if (generate.status !== 0) process.exit(generate.status ?? 1);

const build = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  stdio: "inherit",
  env,
});
if (build.status !== 0) process.exit(build.status ?? 1);

console.log(`\nrelease ready: dist/${gameId}`);

if (preview) {
  spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", `dist/${gameId}`], {
    stdio: "inherit",
    env,
  });
}
