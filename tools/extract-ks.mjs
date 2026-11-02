#!/usr/bin/env node
/**
 * Extract KiriKiri (LiLiTH) scenario text from .ks files into JSON.
 *
 *   node tools/extract-ks.mjs --src "<scenario dir>" \
 *        [--files newgame.ks,select/movie_seen02.ks] [--out src/content/ja]
 *
 * What it understands (all observed in the KiriKiri scripts this was written
 * against):
 *
 *   *label|caption        a page label plus the chapter caption shown in game
 *   ; ...                 comment
 *   [NAME_W n="..."]      speaker name for the page that follows
 *   [NAME_M n="..."]      same, male name plate
 *   [NAME_TIPS_OFF]       no name plate -> narration
 *   [VO vo="v_xxx"]       voice clip of the page
 *   [T_NEXT]              end of message page (the game expands it to [p])
 *   [p] / [er]            page break / erase, treated like a page end
 *   [r]                   line break inside one page
 *   [jump target=*X]      flow leaves for another label
 *   [SELECT_CENTER ...]   choice; file_N / tag_N / sel_N is one option
 *   [if exp="..."][endif] condition block, recorded verbatim
 *
 * Everything else is ignored and counted in `stats.ignoredTags`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, dirname, extname, sep } from "node:path";

const LABEL_RE = /^\*([A-Za-z0-9_]+)[ \t]*(?:\|(.*))?$/;
const TAG_NAME_RE = /^\[\s*([A-Za-z_][A-Za-z0-9_]*)/;
const PARAM_RE = /([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|([^\s\]]+))/g;

/**
 * Split a line into text runs and `[...]` tags.
 *
 * A plain `\[[^\]]*\]` regex breaks on tags that contain array subscripts or
 * brackets inside quoted values, e.g. [MPEG_PLAY loop="&mpglist[0].loop"], which
 * leaves `].loop"]` behind as text. So scan with quote awareness instead.
 */
function splitTags(line) {
  const parts = [];
  let buffer = "";
  let i = 0;

  while (i < line.length) {
    if (line[i] !== "[") {
      buffer += line[i];
      i++;
      continue;
    }

    let j = i + 1;
    let inQuote = false;
    while (j < line.length) {
      const ch = line[j];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === "]" && !inQuote) break;
      j++;
    }

    if (j >= line.length) {
      // unterminated: keep it as literal text
      buffer += line[i];
      i++;
      continue;
    }

    if (buffer) {
      parts.push(buffer);
      buffer = "";
    }
    parts.push(line.slice(i, j + 1));
    i = j + 1;
  }

  if (buffer) parts.push(buffer);
  return parts;
}

const PAGE_END_TAGS = new Set(["T_NEXT", "p"]);
const NAME_TAGS = new Set(["NAME_W", "NAME_M", "NAME_M2", "NAME_TIPS_ON"]);
const CHOICE_TAGS = new Set([
  "SELECT_CENTER",
  "SELECT_WIDE",
  "SELECT_NORMAL",
  "SELECT_TIME_CENTER",
  "SELECT_A_TIME_CENTER",
]);
const SILENT_TAGS = new Set([
  "cm",
  "SYSMENU",
  "er",
  "er2",
  "l",
  "history",
  "ws",
  "wait",
  "click",
  "mapdisable",
  "freeimage",
  "TIPS_OFF",
  "TIPS_ON",
  "SELECT_CLEAR",
  "SELECT_W_CLEAR",
  "cm",
]);

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

function parseParams(rest) {
  const params = {};
  PARAM_RE.lastIndex = 0;
  let match;
  while ((match = PARAM_RE.exec(rest)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return params;
}

/** Normalize a jump/label reference: "*S001a" -> "S001a", " *S001a" -> "S001a". */
function refName(value) {
  if (!value) return null;
  return value.trim().replace(/^\*/, "");
}

function extractFile(text, fileName) {
  const lines = text.split(/\r?\n/);

  const pages = [];
  const ignoredTags = new Map();
  const warnings = [];

  let label = null;
  let caption = null;
  let labelAtText = null;
  let captionAtText = null;
  let pageLine = 0;

  // Every page is usually introduced by two labels: a jump target (*S001a)
  // and the page itself (*s01_101_a|caption). Collect them all.
  const pendingLabels = [];

  let speaker = null;
  let voice = null;
  let buffer = [];
  let pageConditions = [];
  let conditions = [];
  let macroDepth = 0;
  /** Stage changes seen since the last flushed page, in source order. */
  let pendingStage = [];

  function currentPage() {
    return pages.length > 0 ? pages[pages.length - 1] : null;
  }

  function flushPage(endLine) {
    const text = buffer.join("").replace(/[ \t\u3000]+$/u, "");

    if (text === "") {
      buffer = [];
      pendingLabels.length = 0;
      speaker = null;
      voice = null;
      return;
    }

    const labels = pendingLabels.length > 0 ? [...pendingLabels] : [labelAtText ?? `@${pageLine}`];

    pages.push({
      id: null, // assigned after parsing, once duplicates are known
      labels,
      label: labels[labels.length - 1],
      caption: captionAtText ?? caption ?? null,
      line: pageLine,
      endLine,
      speaker,
      voice,
      text,
      conditions: [...pageConditions],
      flow: { type: "seq" },
      ...(pendingStage.length > 0 ? { stage: pendingStage } : {}),
    });

    pendingStage = [];
    buffer = [];
    pendingLabels.length = 0;
    pageConditions = [];
    speaker = null;
    voice = null;
  }

  function appendText(chunk) {
    if (chunk === "") return;
    if (buffer.length === 0) {
      labelAtText = pendingLabels.length > 0 ? pendingLabels[pendingLabels.length - 1] : label;
      captionAtText = caption;
      pageLine = currentLineAtText;
      pageConditions = [...conditions];
    }
    buffer.push(chunk);
  }

  let currentLine = 0;
  let currentLineAtText = 0;

  for (let index = 0; index < lines.length; index++) {
    currentLine = index + 1;
    currentLineAtText = currentLine;
    // `\;` is KiriKiri's "literal semicolon" escape (a line starting with `;`
    // is a comment). It never shows up in game, so drop it wherever it appears.
    let raw = lines[index].replace(/\\\s*$/, "").replace(/\\;/g, "");

    // A label line that lost its leading `*` in the original script
    // (e.g. "0593|―さらに一ヵ月後―") is not text: drop the stray number and keep
    // the caption as the page text.
    const brokenLabel = /^\s*\d{3,4}\|/.exec(raw);
    if (brokenLabel) {
      warnings.push(`label without * at line ${currentLine}: ${raw.trim().slice(0, 24)}`);
      raw = raw.slice(brokenLabel[0].length);
    }

    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith(";")) continue;

    // Macro definitions are library code, not story text.
    if (/^\[macro\b/.test(trimmed)) {
      macroDepth++;
      continue;
    }
    if (/^\[endmacro\]/.test(trimmed)) {
      if (macroDepth > 0) macroDepth--;
      continue;
    }
    if (macroDepth > 0) continue;

    const labelMatch = LABEL_RE.exec(trimmed);
    if (labelMatch) {
      label = labelMatch[1];
      if (labelMatch[2]) caption = labelMatch[2].trim();
      pendingLabels.push(label);
      continue;
    }

    const parts = splitTags(raw);
    let textPart = "";

    for (const part of parts) {
      if (!part.startsWith("[")) {
        textPart += part;
        continue;
      }

      if (textPart !== "") {
        appendText(textPart);
        textPart = "";
      }

      const nameMatch = TAG_NAME_RE.exec(part);
      const tag = nameMatch ? nameMatch[1] : "";
      const body = tag ? part.slice(nameMatch[0].length, part.lastIndexOf("]")) : "";

      if (PAGE_END_TAGS.has(tag)) {
        flushPage(currentLine);
        continue;
      }
      if (tag === "r") {
        appendText("\n");
        continue;
      }
      if (NAME_TAGS.has(tag)) {
        const params = parseParams(body);
        speaker = params.n ? params.n.trim() : speaker;
        continue;
      }
      if (tag === "NAME_TIPS_OFF") {
        speaker = null;
        continue;
      }
      if (tag === "VO" || tag === "vo") {
        const params = parseParams(body);
        voice = params.vo ?? params.v ?? null;
        continue;
      }
      if (tag === "jump") {
        const params = parseParams(body);
        const page = currentPage();
        const target = refName(params.target);

        // A jump guarded by [if] is a shortcut ("prologue already seen"), not
        // the end of the page: the page still shows its own text.
        if (conditions.length > 0) {
          if (page) {
            page.alternates = page.alternates ?? [];
            page.alternates.push({ target, when: [...conditions], line: currentLine });
          }
          continue;
        }

        const flow = {
          type: "jump",
          target,
          storage: params.storage ? basename(params.storage) : null,
          line: currentLine,
        };
        if (page) page.flow = flow;
        else warnings.push(`jump without a preceding page at line ${currentLine}`);
        continue;
      }
      if (CHOICE_TAGS.has(tag)) {
        const params = parseParams(body);
        const options = [];
        for (let n = 1; n <= 8; n++) {
          const sel = params[`sel_${n}`];
          if (sel === undefined) continue;
          options.push({
            label: sel.trim(),
            target: refName(params[`tag_${n}`]),
            storage: params[`file_${n}`] ? basename(params[`file_${n}`]) : null,
          });
        }
        const flow = { type: "choice", prompt: params.text ?? null, options, line: currentLine };
        const page = currentPage();
        if (page) page.flow = flow;
        else warnings.push(`choice without a preceding page at line ${currentLine}`);
        continue;
      }
      if (tag === "if") {
        conditions.push(parseParams(body).exp ?? "");
        continue;
      }
      if (tag === "else") {
        conditions.push("!else");
        continue;
      }
      if (tag === "endif") {
        conditions.pop();
        continue;
      }
      if (tag === "eval") {
        const exp = parseParams(body).exp ?? "";
        const page = currentPage();
        if (page && page.flow.type === "seq") {
          page.effects = page.effects ?? [];
          page.effects.push(exp);
        }
        continue;
      }
      if (SILENT_TAGS.has(tag)) continue;

      // Stage tags: the engine keeps a small layer state (background + three
      // tachie slots), so recording the deltas is enough to replay the visuals.
      // The script uses two spellings for a background swap: [TR ..] and the
      // misspelled [FAID_IN] family. Both carry bmp= and an optional t=.
      if (tag === "TR" || tag === "FAID_IN" || tag === "FAID_IN_T") {
        const params = parseParams(body);
        if (params.bmp) {
          pendingStage.push({
            k: "bg",
            bmp: params.bmp,
            tr: params.type ?? (tag === "TR" ? null : tag),
            ms: Number(params.t ?? 0) || 0,
          });
        }
        continue;
      }

      // [FAID_OUT] fades to a black screen; the scripts mark it with a
      // [;【黒画面】] comment. It carries no image, so it clears the background.
      if (tag === "FAID_OUT" || tag === "FAID_OUT_T") {
        const params = parseParams(body);
        pendingStage.push({ k: "bgout", ms: Number(params.t ?? 0) || 0 });
        continue;
      }

      if (tag === "T_BMP" || tag === "T_FADEIN" || tag === "T_FADEOUT") {
        const params = parseParams(body);
        const slot = params.place !== undefined ? Number(params.place) : null;
        if (slot === null || Number.isNaN(slot)) continue;

        if (tag === "T_FADEOUT") {
          pendingStage.push({ k: "clear", slot });
        } else {
          const bmp = params.bmp_l ?? params.bmp_c ?? params.bmp_r ?? null;
          if (bmp) pendingStage.push({ k: "show", slot, bmp, fade: tag === "T_FADEIN" });
        }
        continue;
      }

      ignoredTags.set(tag, (ignoredTags.get(tag) ?? 0) + 1);
    }

    if (textPart !== "") appendText(textPart);
  }

  flushPage(currentLine);

  // Resolve ids (labels are mostly unique, but guard against repeats).
  const used = new Map();
  for (const page of pages) {
    const seen = used.get(page.label) ?? 0;
    used.set(page.label, seen + 1);
    page.id = seen === 0 ? page.label : `${page.label}#${seen + 1}`;
  }

  // Any label of a page (jump target or page label) resolves to that page.
  const byLabel = new Map();
  for (const page of pages) {
    for (const name of page.labels) if (!byLabel.has(name)) byLabel.set(name, page.id);
  }

  const resolve = (ref) => {
    if (!ref) return null;
    return byLabel.get(ref) ?? ref; // unknown labels keep their raw name
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.flow.type === "jump") {
      page.next = page.flow.storage ? null : resolve(page.flow.target);
    } else if (page.flow.type === "choice") {
      page.flow.options = page.flow.options.map((option) => ({
        ...option,
        next: resolve(option.target),
      }));
      page.next = null;
    } else {
      const following = pages[i + 1];
      page.next = following ? following.id : null;
      if (!following) page.flow = { type: "end" };
    }
  }

  const captions = [];
  for (const page of pages) {
    if (!page.caption) continue;
    const last = captions[captions.length - 1];
    if (last && last.value === page.caption) continue;
    captions.push({ value: page.caption, firstPage: page.id });
  }

  // Layer geometry comes from the scenario's own layer_init.ks when it ships
  // one; the values are the horizontal offsets of the left/centre/right slots.
  const initMatch = /\[T_INIT\b([^\]]*)\]/.exec(text);
  const init = initMatch ? parseParams(initMatch[1]) : null;
  const slotOffsets = init
    ? {
        l: Number(init.lx ?? -250),
        c: Number(init.cx ?? 0),
        r: Number(init.rx ?? 250),
      }
    : { l: -250, c: 0, r: 250 };

  return {
    source: fileName,
    slotOffsets,
    stats: {
      lines: lines.length,
      pages: pages.length,
      withSpeaker: pages.filter((p) => p.speaker).length,
      narration: pages.filter((p) => !p.speaker).length,
      withVoice: pages.filter((p) => p.voice).length,
      jumps: pages.filter((p) => p.flow.type === "jump").length,
      choices: pages.filter((p) => p.flow.type === "choice").length,
      conditionalPages: pages.filter((p) => p.conditions.length > 0).length,
      captions: captions.length,
      ignoredTags: Object.fromEntries([...ignoredTags].sort((a, b) => b[1] - a[1])),
    },
    captions,
    pages,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = args.src;
  if (!src) {
    console.error(
      [
        "usage: node tools/extract-ks.mjs --src <scenario dir> [--files a.ks,b.ks] [--out dir]",
        "",
        "  --src    directory that contains the .ks files (extracted from data.xp3)",
        "  --files  comma separated, relative to --src   (default: newgame.ks)",
        "  --out    output directory                     (default: src/content/ja)",
      ].join("\n"),
    );
    process.exit(1);
  }

  const files = (args.files ?? "newgame.ks").split(",").map((s) => s.trim()).filter(Boolean);
  const outDir = args.out ?? join("src", "content", "ja");

  for (const file of files) {
    const text = await readFile(join(src, file), "utf8");
    const result = extractFile(text, file.split("/").join(sep));

    const name = basename(file, extname(file)) + ".pages.json";
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, name), `${JSON.stringify(result, null, 1)}\n`, "utf8");

    const s = result.stats;
    console.log(`\n${file} -> ${join(outDir, name)}`);
    console.log(
      `  pages=${s.pages} speaker=${s.withSpeaker} narration=${s.narration} voice=${s.withVoice}` +
        ` jumps=${s.jumps} choices=${s.choices} conditional=${s.conditionalPages} captions=${s.captions}`,
    );
    console.log(`  captions: ${result.captions.slice(0, 8).map((c) => c.value).join(" | ")}`);
    const ignored = Object.entries(s.ignoredTags).slice(0, 10);
    if (ignored.length) console.log(`  ignored tags: ${ignored.map(([k, v]) => `${k}(${v})`).join(" ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
