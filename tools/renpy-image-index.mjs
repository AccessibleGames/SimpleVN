#!/usr/bin/env node
/**
 * Map the picture names a Ren'Py script uses onto files that already exist.
 *
 *   node tools/renpy-image-index.mjs --graph games/<id>/content/graph.json \
 *                                    --src <unpacked rpa directory> \
 *                                    --content games/<id>/content
 *
 * Ren'Py names an image after its file, but the two do not always agree in
 * spelling - a script may say `fc38` where the file is `fc 38`, or `screen chat`
 * where the file is `screen_chat`. Matching on a slug (case, spaces, underscores
 * and hyphens removed) resolves those without touching the files.
 *
 * Nothing is converted and nothing is copied: the manifest records where the
 * picture already is, relative to the unpacked directory, and the stage is served
 * from that directory directly. A game whose art is already flat WebP does not
 * need a second copy of it to be readable.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, join, relative } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const graphPath = flag("graph");
const srcDir = flag("src");
const contentDir = flag("content");
const convertDir = flag("convert");
const quality = flag("quality", "85");
const IMAGES = /\.(webp|png|jpg|jpeg|avif|bmp|tga)$/i;

if (!graphPath || !srcDir || !contentDir) {
  console.error("usage: renpy-image-index.mjs --graph <graph.json> --src <dir> --content <content dir>");
  process.exit(1);
}

const slug = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (IMAGES.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = walk(srcDir);
const bySlug = new Map();
for (const file of files) {
  const key = slug(basename(file, extname(file)));
  const list = bySlug.get(key) ?? [];
  list.push(file);
  bySlug.set(key, list);
}

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const wanted = { bg: new Set(), sprites: new Set() };
for (const node of Object.values(graph.nodes ?? {})) {
  for (const event of node.stage ?? []) {
    if (!event.bmp) continue;
    if (event.k === "bg") wanted.bg.add(event.bmp);
    else if (event.k === "show") wanted.sprites.add(event.bmp);
  }
}

const report = {};
let stills = 0;
let converted = 0;
for (const layer of ["bg", "sprites"]) {
  const entries = [];
  const missing = [];
  const aliased = [];

  for (const name of [...wanted[layer]].sort()) {
    // An animation is a `.webm`, which a reading app has no use for. Many of them
    // ship a still frame as well, named without the suffix, so that is what gets
    // shown instead of nothing at all.
    const candidates = [name];
    if (/[-_ ]anim$/i.test(name)) candidates.push(name.replace(/[-_ ]anim$/i, ""));

    let file = null;
    for (const candidate of candidates) {
      const list = bySlug.get(slug(candidate));
      if (list?.length) {
        file = list[0];
        if (candidate !== name) stills++;
        break;
      }
    }
    if (!file) {
      missing.push(name);
      continue;
    }
    const path = relative(srcDir, file).split("\\").join("/");
    if (basename(file, extname(file)) !== name) aliased.push(`${name} -> ${basename(file)}`);

    // Converting writes one flat WebP named after the script's name, so the stage
    // needs no path lookup and the output can live in a directory of its own.
    let full = path;
    if (convertDir) {
      const output = join(convertDir, layer, `${name}.webp`);
      let stale = true;
      try {
        stale = statSync(output).mtimeMs < statSync(file).mtimeMs;
      } catch {
        stale = true;
      }
      if (stale) {
        mkdirSync(join(convertDir, layer), { recursive: true });
        const result = spawnSync(
          process.env.FFMPEG ?? "ffmpeg",
          ["-y", "-loglevel", "error", "-i", file, "-c:v", "libwebp", "-quality", quality, "-compression_level", "5", output],
          { stdio: "inherit" },
        );
        if (result.status !== 0) {
          missing.push(`${name} (conversion failed)`);
          continue;
        }
        converted++;
      }
      full = `${name}.webp`;
    }

    entries.push({
      id: name,
      group: name,
      label: name,
      full,
      thumb: full,
      w: 0,
      h: 0,
    });
  }

  mkdirSync(contentDir, { recursive: true });
  writeFileSync(join(contentDir, `${layer}.json`), `${JSON.stringify({ entries })}\n`, "utf8");
  report[layer] = { entries: entries.length, missing: missing.length, aliased: aliased.length, sample: aliased.slice(0, 3) };
}

console.log(`source images: ${files.length}, distinct slugs: ${bySlug.size}`);
for (const layer of ["bg", "sprites"]) {
  const { entries, missing, aliased, sample } = report[layer];
  console.log(`${layer}: ${entries} mapped, ${missing} not found, ${aliased} spelled differently`);
  if (sample.length) console.log(`  e.g. ${sample.join(", ")}`);
}
if (stills) console.log(`animations shown as their still frame: ${stills}`);
if (convertDir) console.log(`converted to WebP: ${converted} (into ${convertDir})`);
