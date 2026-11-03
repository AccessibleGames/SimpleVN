#!/usr/bin/env node
/**
 * Compile extracted .ks pages into a language-neutral page graph plus one
 * text pack per language.
 *
 *   node tools/build-content.mjs --src src/content/ja --out src/content
 *
 * Input  : <src>/*.pages.json          (tools/extract-ks.mjs output)
 * Output : <out>/graph.json            language neutral: ids, links, choices
 *          <out>/ja/pack.json          texts + speaker names + captions
 *
 * Everything that a reader sees is a key in a pack, so a translation only has
 * to provide another pack: same graph, same saves, different strings.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
    else out[body] = argv[++i];
  }
  return out;
}

function createKeymaker(prefix, width) {
  const keys = new Map();
  const values = {};
  return {
    key(value) {
      if (value === null || value === undefined || value === "") return null;
      let key = keys.get(value);
      if (!key) {
        key = prefix + String(keys.size + 1).padStart(width, "0");
        keys.set(value, key);
        values[key] = value;
      }
      return key;
    },
    values,
    get size() {
      return keys.size;
    },
  };
}

function findEntryLabel(index, label) {
  for (const idOf of index.values()) {
    const id = idOf.get(label);
    if (id) return id;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcDir = args.src;
  if (!srcDir) {
    console.error("usage: node tools/build-content.mjs --src <pages dir> [--out src/content]");
    process.exit(1);
  }
  const outDir = args.out ?? join("src", "content");

  const files = (await readdir(srcDir)).filter((name) => name.endsWith(".pages.json")).sort();
  if (files.length === 0) {
    console.error(`no *.pages.json in ${srcDir}`);
    process.exit(1);
  }

  const speakers = createKeymaker("n", 3);
  const captions = createKeymaker("c", 3);

  const nodes = {};
  const text = {};
  const warnings = [];

  // file key -> { pageId -> global node id }, used to resolve cross-file jumps
  const index = new Map();

  const sources = [];
  /** globalId -> page, so dropped pages can be bypassed when relinking. */
  const pageAt = new Map();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await readFile(join(srcDir, file), "utf8"));
    } catch {
      // A half-written or empty intermediate must not take the whole build down.
      warnings.push(`skipped unreadable page file: ${file}`);
      continue;
    }
    const fileKey = basename(file, ".pages.json");
    const idOf = new Map();
    // Every label of a page (jump targets and page names) resolves to that page.
    for (const page of data.pages) {
      const globalId = `${fileKey}:${page.id}`;
      pageAt.set(globalId, { page, fileKey });
      for (const label of page.labels ?? [page.label]) {
        if (!idOf.has(label)) idOf.set(label, globalId);
      }
      idOf.set(page.id, globalId);
    }
    index.set(fileKey, idOf);
    sources.push({ fileKey, data, idOf });
  }

  const resolveTarget = (fileKey, target, storage) => {
    if (!target) return null;
    if (!storage) return index.get(fileKey)?.get(target) ?? `${fileKey}:${target}`;
    const storageKey = basename(storage, ".ks");
    const other = index.get(storageKey);
    if (!other) {
      warnings.push(`missing file for jump: ${fileKey} -> ${storage}:${target}`);
      return null;
    }
    // The file exists but the label does not (end.ks ships a bare "*end" with no
    // caption, so no page is produced). Ending the flow here beats a dangling
    // link that throws when the reader reaches it.
    if (!other.has(target)) {
      warnings.push(`missing label for jump: ${fileKey} -> ${storage}:${target}`);
      return null;
    }
    return other.get(target);
  };

  let choiceCount = 0;
  let jumpCount = 0;

  // --drop <regex>: pages that are not story content (release banners, patch
  // watermarks, editor notes). Links hop over them so the flow stays intact.
  const dropRe = args.drop ? new RegExp(args.drop) : null;
  const dropped = new Set();
  if (dropRe) {
    for (const { data, fileKey } of sources) {
      for (const page of data.pages) {
        if (dropRe.test(page.text ?? "")) dropped.add(`${fileKey}:${page.id}`);
      }
    }
  }

  const liveNode = (globalId) => {
    let cur = globalId;
    for (let guard = 0; cur && dropped.has(cur) && guard < 10000; guard++) {
      const entry = pageAt.get(cur);
      cur = entry?.page.next ? resolveTarget(entry.fileKey, entry.page.next, null) : null;
    }
    return cur;
  };

  const scenes = [];
  let sceneCaption = null;

  for (const { fileKey, data, idOf } of sources) {
    for (const page of data.pages) {
      const id = idOf.get(page.id);
      if (dropped.has(id)) continue;
      const node = {};

      node.line = page.line;
      if (page.speaker) node.speaker = speakers.key(page.speaker);
      if (page.caption) node.caption = captions.key(page.caption);
      // A caption run is one scene; remember where each one starts so the player
      // can list sections in script order instead of guessing from node keys.
      if (page.caption && page.caption !== sceneCaption) {
        sceneCaption = page.caption;
        scenes.push({ caption: node.caption, node: id });
      }
      if (page.voice) node.voice = page.voice;
      if (page.endLine && page.endLine !== page.line) node.endLine = page.endLine;
      if (page.stage) node.stage = page.stage;

      text[id] = page.text;

      if (page.flow.type === "choice") {
        const flow = page.flow;
        if (flow.prompt) {
          text[`${id}#prompt`] = flow.prompt;
          node.prompt = `${id}#prompt`;
        }
        node.choices = flow.options.map((option, i) => {
          const textKey = `${id}#${i + 1}`;
          text[textKey] = option.label;
          return { text: textKey, next: liveNode(resolveTarget(fileKey, option.target, option.storage)) };
        });
        choiceCount++;
      } else if (page.flow.type === "jump") {
        node.next = liveNode(resolveTarget(fileKey, page.flow.target, page.flow.storage));
        jumpCount++;
      } else if (page.flow.type === "call") {
        // Ren'Py `call`: go to the callee, come back to this page's next.
        node.call = liveNode(resolveTarget(fileKey, page.flow.target, page.flow.storage));
        node.next = page.next ? liveNode(idOf.get(page.next) ?? null) : null;
        jumpCount++;
      } else if (page.flow.type === "return") {
        // Pop the call stack; depth is tracked by the interpreter during replay.
        node.ret = true;
        node.next = null;
      } else if (page.flow.type === "end") {
        node.next = null;
      } else {
        node.next = page.next ? liveNode(idOf.get(page.next) ?? null) : null;
      }

      if (page.alternates && page.alternates.length > 0) {
        // conditional shortcuts ("prologue already seen"), kept for reference
        node.alternates = page.alternates.map((alt) => ({
          when: alt.when,
          next: liveNode(resolveTarget(fileKey, alt.target, alt.storage)),
        }));
      }

      nodes[id] = node;
    }
  }

  // A page whose target is missing cannot continue: make that visible.
  const dangling = [];
  for (const [id, node] of Object.entries(nodes)) {
    const refs = [node.next, ...(node.choices ?? []).map((c) => c.next)];
    for (const ref of refs) {
      if (ref && !nodes[ref]) dangling.push([id, ref]);
    }
  }

  const start =
    liveNode(
      (args.start ? findEntryLabel(index, args.start) : null) ??
        findEntryLabel(index, "newgame") ??
        index.get(sources[0].fileKey)?.values().next().value ??
        null,
    ) ?? null;

  const graph = {
    start,
    vars: {},
    // Horizontal offsets of the tachie slots, taken from the script's own
    // layer_init.ks when it ships one.
    slots: sources.find((s) => s.data.slotOffsets)?.data.slotOffsets ?? { l: -250, c: 0, r: 250 },
    sources: sources.map((s) => ({ fileKey: s.fileKey, file: s.data.source, pages: s.data.pages.length })),
    scenes,
    nodes,
  };

  // Locale of the extracted pack: the script's own language. Some releases ship
  // with a fan-translated script, so this is data, not a constant.
  const packLocale = args.lang ?? "ja";
  await mkdir(join(outDir, packLocale), { recursive: true });
  await writeFile(join(outDir, "graph.json"), `${JSON.stringify(graph)}\n`, "utf8");
  await writeFile(
    join(outDir, packLocale, "pack.json"),
    `${JSON.stringify(
      { locale: packLocale, title: args.title ?? "", names: speakers.values, captions: captions.values, text },
      null,
      0,
    )}\n`,
    "utf8",
  );

  const danglingSet = new Set(dangling.map((d) => d[1]));
  console.log(`sources : ${graph.sources.map((s) => `${s.file}(${s.pages})`).join(" + ")}`);
  console.log(`nodes   : ${Object.keys(nodes).length}   choices=${choiceCount} jumps=${jumpCount}`);
  console.log(`texts   : ${Object.keys(text).length}   names=${speakers.size} captions=${captions.size}`);
  console.log(`start   : ${start}`);
  console.log(`scenes  : ${scenes.length}`);
  console.log(`dangling: ${dangling.length}${dangling.length ? ` (unique refs: ${danglingSet.size})` : ""}`);
  if (warnings.length) console.log(`warnings: ${warnings.length}`, warnings.slice(0, 5));
  if (dangling.length) console.log("  e.g.", dangling.slice(0, 5));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
