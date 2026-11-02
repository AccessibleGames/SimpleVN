#!/usr/bin/env node
/**
 * Build the gallery from an already-extracted image directory.
 *
 *   node tools/build-art.mjs --src <dir> --out games/<id>/public/art \
 *                            --gallery games/<id>/content/gallery.json
 *
 * Unpacking the game archives is out of scope here; this only consumes plain
 * PNGs. Each image becomes a WebP full size plus a WebP thumbnail, and the
 * manifest records both, so the player never has to decode a 2 MB PNG for the
 * grid. Re-runs skip files whose output is newer than the source.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const srcDir = flag("src");
const outDir = flag("out");
const galleryPath = flag("gallery");
const quality = flag("quality", "90");
const thumbWidth = flag("thumb-width", "480");
const exclude = flag("exclude");
const withThumbs = !args.includes("--no-thumb");

if (!srcDir || !outDir || !galleryPath) {
  console.error("usage: build-art.mjs --src <dir> --out <dir> --gallery <manifest.json>");
  process.exit(1);
}

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (extname(entry.name).toLowerCase() === ".png") found.push(path);
  }
  return found;
}

/** Read width/height straight out of the PNG IHDR chunk. */
async function pngSize(path) {
  const handle = await readFile(path);
  if (handle.length < 24) return null;
  return { w: handle.readUInt32BE(16), h: handle.readUInt32BE(20) };
}

function convert(source, target, extra) {
  const result = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", source, ...extra, "-c:v", "libwebp", "-quality", String(quality), target],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${source}`);
}

async function fresh(target, source) {
  try {
    const [out, src] = await Promise.all([stat(target), stat(source)]);
    return out.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

const files = (await walk(srcDir))
  .filter((file) => !exclude || !new RegExp(exclude).test(relative(srcDir, file).replace(/[\\/]/g, "/")))
  .sort();
if (files.length === 0) {
  console.error(`no PNG files under ${srcDir}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await mkdir(dirname(galleryPath), { recursive: true });

const entries = [];
for (const file of files) {
  const stem = relative(srcDir, file).replace(/\.png$/i, "").replace(/[\\/]/g, "-");
  const size = await pngSize(file);
  if (!size) {
    console.warn(`skip (not a PNG): ${file}`);
    continue;
  }

  const full = `${stem}.webp`;
  const thumb = `${stem}.thumb.webp`;

  if (!(await fresh(join(outDir, full), file))) {
    convert(file, join(outDir, full), []);
  }
  if (withThumbs && !(await fresh(join(outDir, thumb), file))) {
    convert(file, join(outDir, thumb), ["-vf", `scale=${thumbWidth}:-2`]);
  }

  entries.push({
    id: stem,
    // ev001a -> ev001: variants of one CG belong to the same group
    group: stem.replace(/[a-z]$/, ""),
    label: stem,
    full,
    thumb: withThumbs ? thumb : full,
    w: size.w,
    h: size.h,
  });
}

entries.sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));

const manifest = { entries };
await writeFile(galleryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const total = entries.length;
console.log(`gallery: ${total} entries -> ${outDir}`);
console.log(`manifest: ${galleryPath}`);
