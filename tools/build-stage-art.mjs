#!/usr/bin/env node
/**
 * Build the stage art a script actually asks for.
 *
 *   node tools/build-stage-art.mjs --graph games/<id>/content/graph.json \
 *                                  --src <dir of png> --public games/<id>/public
 *
 * The stage resolves a picture by name: `bg/<name>.webp` and `sprites/<name>.webp`,
 * where the name is the one the script wrote (`TR bg=nc001a`, `T_BMP スロット=bmp
 * bmp=あやめ_t001a`). So the only thing that has to be true is that those files
 * exist under those names; no index is involved.
 *
 * Converting is skipped when the output is newer than the source, because a
 * source directory is often the whole unpacked archive and most of it is not
 * referenced by the script at all.
 */

import { spawnSync } from "node:child_process";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const graphPath = flag("graph");
const srcDir = flag("src");
const publicDir = flag("public");
const contentDir = flag("content", publicDir ? join(dirname(publicDir), "content") : undefined);
const quality = flag("quality", "88");
const dryRun = args.includes("--dry-run");

if (!graphPath || !srcDir || !publicDir) {
  console.error("usage: build-stage-art.mjs --graph <graph.json> --src <png dir> --public <game public dir>");
  process.exit(1);
}

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

const graph = JSON.parse(await readFile(graphPath, "utf8"));

/** Every picture name the script puts on the stage, split by layer. */
const wanted = { bg: new Set(), sprites: new Set() };
for (const node of Object.values(graph.nodes ?? {})) {
  for (const event of node.stage ?? []) {
    if (!event.bmp) continue;
    if (event.k === "bg") wanted.bg.add(event.bmp);
    else if (event.k === "show") wanted.sprites.add(event.bmp);
  }
}

async function newer(target, source) {
  try {
    const [out, src] = await Promise.all([stat(target), stat(source)]);
    return out.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

const report = { bg: { done: 0, skipped: 0, missing: [] }, sprites: { done: 0, skipped: 0, missing: [] } };
/** Manifests carry the source size; the PNG header has it as two big-endian u32. */
const sizes = new Map();

async function pngSize(path) {
  const cached = sizes.get(path);
  if (cached) return cached;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(24);
    await handle.read(head, 0, 24, 0);
    // Only PNG carries width and height at this offset; anything else is left
    // unknown and simply not listed in the manifest, which the stage does not read.
    if (head.subarray(1, 4).toString("latin1") !== "PNG") return null;
    const size = { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
    sizes.set(path, size);
    return size;
  } finally {
    await handle.close();
  }
}

/** The source may be png, jpg or webp; Ren'Py names images by file stem. */
async function findSource(name) {
  for (const extension of ["png", "jpg", "jpeg", "webp"]) {
    const candidate = join(srcDir, `${name}.${extension}`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try the next extension
    }
  }
  return null;
}

for (const layer of ["bg", "sprites"]) {
  const outDir = join(publicDir, layer);
  if (!dryRun) await mkdir(outDir, { recursive: true });

  for (const name of wanted[layer]) {
    const source = await findSource(name);
    const target = join(outDir, `${name}.webp`);

    if (!source) {
      report[layer].missing.push(name);
      continue;
    }

    if (await newer(target, source)) {
      report[layer].skipped++;
      continue;
    }    if (dryRun) {
      report[layer].done++;
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    const result = spawnSync(
      ffmpeg,
      ["-y", "-loglevel", "error", "-i", source, "-c:v", "libwebp", "-quality", quality, "-compression_level", "5", target],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.error(`  ! ${name}: ffmpeg failed`);
      report[layer].missing.push(name);
      continue;
    }
    report[layer].done++;
  }
}

for (const layer of ["bg", "sprites"]) {
  const { done, skipped, missing } = report[layer];
  console.log(`${layer}: ${done} written, ${skipped} up to date, ${missing.length} missing`);
  if (missing.length) console.log(`  missing: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`);
}

// The reader gates the stage on the manifests existing, and the gallery uses the
// same shape, so both layers get one. Only what the script asks for is listed.
if (!dryRun && contentDir) {
  for (const layer of ["bg", "sprites"]) {
    const entries = [];
    for (const name of [...wanted[layer]].sort()) {
      const source = await findSource(name);
      if (!source) continue;
      const size = await pngSize(source).catch(() => null);
      if (!size) continue;
      entries.push({ id: name, group: name, label: name, full: `${name}.webp`, thumb: `${name}.webp`, w: size.w, h: size.h });
    }
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, `${layer}.json`), `${JSON.stringify({ entries }, null, 0)}\n`, "utf8");
    console.log(`${layer}.json: ${entries.length} entries`);
  }
}
