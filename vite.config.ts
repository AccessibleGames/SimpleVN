import { defineConfig } from "vite";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

/**
 * Dev build: every game in `games/` is bundled and the menu switches between
 * them. Release build: `GAME=<id>` swaps `@games` for a generated module that
 * statically imports a single game, so the other games never reach the bundle.
 */
const game = process.env.GAME?.trim();

const MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
};

/**
 * Serve games/<id>/public/* as /asset/<id>/* in dev, so every game can carry
 * art, backgrounds and sprites without sharing one public directory.
 */
function gameAssets(): Plugin {
  return {
    name: "vn-game-assets",
    configureServer(server) {
      server.middlewares.use("/asset", (req, res, next) => {
        const match = /^\/([^/]+)\/(.+)$/.exec(req.url ?? "");
        if (!match) return next();

        const target = resolve(
          "games",
          decodeURIComponent(match[1]),
          "public",
          decodeURIComponent(match[2]),
        );
        const type = MIME[target.slice(target.lastIndexOf("."))];
        if (!type) return next();

        res.setHeader("Content-Type", type);
        createReadStream(target)
          .on("error", () => next())
          .pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), gameAssets()],
  base: "./",
  // In a release build only the chosen game's public/ is copied, so art ends up
  // at art/<file>; in dev it is served per game at art/<id>/<file>.
  publicDir: game ? resolve("games", game, "public") : false,
  resolve: {
    alias: { "@games": resolve(game ? "src/games.gen.ts" : "src/games.registry.ts") },
  },
  build: {
    outDir: game ? `dist/${game}` : "dist",
    target: "es2022",
  },
});
