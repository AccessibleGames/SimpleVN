#!/usr/bin/env node
/**
 * Import Ren'Py games into the page format the reader already speaks.
 *
 *   node tools/renpy-import.mjs --root "<folder with Ren'Py games>" [--only <name>] [--out games]
 *   node tools/renpy-import.mjs --root "<folder with Ren'Py games>" --list
 *
 * Why a batch tool: these games keep shipping updates, so importing has to be
 * cheap to repeat. Each run rewrites content/ from the scripts and records what
 * it saw in content/import.json, which is what a later diff reads.
 *
 * Shape decisions, all in service of reading rather than simulating:
 *   - the whole game is one page file, because Ren'Py labels are global and
 *     jumps cross files freely; one file key keeps every jump resolvable
 *   - one say statement = one page, so a reader advances one line at a time
 *   - one .rpy file = one chapter, which is exactly what scene replay lists
 *   - maps and QTEs are menus in Ren'Py, so they arrive as choices for free
 *   - audio, animation and screens are dropped; this is a text reader
 *
 * Unsupported constructs are counted and reported rather than silently skipped.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  if (eq >= 0) args[body.slice(0, eq)] = body.slice(eq + 1);
  else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) args[body] = process.argv[++i];
  else args[body] = true;
}

if (!args.root) {
  console.error("usage: node tools/renpy-import.mjs --root <dir with Ren'Py games> [--only <name>] [--out <dir>] [--list]");
  process.exit(1);
}

const outRoot = args.out ?? "games";

/**
 * Read one of Ren'Py's own translation files (`game/tl/<lang>/*.rpy`).
 *
 * A `translate <lang> <label>_<hash>:` block holds the translated lines for that
 * label in source order, so lining them up by position is what using the block
 * means. `translate <lang> strings:` holds `old`/`new` pairs, which is where menu
 * options and UI text are translated.
 */
function parseTranslations(lines) {
  const labels = new Map();
  const strings = new Map();
  let block = null;
  let last = null; // pending `old` waiting for its `new`

  for (const { indent, body } of lines) {
    const header = /^translate\s+\S+\s+([^\s:]+)\s*:/.exec(body);
    if (header && indent === 0) {
      const id = header[1];
      block = id === "strings" ? "strings" : id.slice(0, id.lastIndexOf("_") === -1 ? undefined : id.lastIndexOf("_"));
      if (block !== "strings" && !labels.has(block)) labels.set(block, []);
      last = null;
      continue;
    }
    if (indent === 0) block = null;
    if (block === null) continue;

    const say = /^"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/.exec(body);
    const old = /^old\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(body);
    const fresh = /^new\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(body);

    if (block === "strings") {
      if (old) last = old[1];
      else if (fresh && last !== null) {
        strings.set(last, fresh[1]);
        last = null;
      }
      continue;
    }

    // a translated line may carry a speaker in front of it
    const voiced = /^[A-Za-z_][\w]*\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(body);
    const text = say?.[1] ?? voiced?.[1];
    if (text !== undefined) labels.get(block).push(text);
  }

  return { labels, strings };
}

/** `--design 1600x900` */
function parseDesign(value) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(value));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Which locale to prefer when a game ships several patches. */
const SUPPORTED_ORDER = ["zh-CN", "zh-TW", "ja", "en"];

/** Ren'Py's directory names are not locale tags. */
function patchLocale(language) {
  if (/^(schinese|simplified_chinese|cn|zh|chinese)$/.test(language)) return "zh-CN";
  if (/^(tchinese|traditional_chinese|zh_tw)$/.test(language)) return "zh-TW";
  if (/^(japanese|jp|ja)$/.test(language)) return "ja";
  return "en";
}

/**
 * A Chinese patch replaces the dialogue but not the code, so counting letters over
 * dialogue lines (not whole files) is what tells the two apart.
 */
function guessLocale(pages) {
  let cjk = 0;
  let latin = 0;

  for (const page of pages) {
    if (typeof page.text !== "string") continue;
    for (const char of page.text) {
      const code = char.codePointAt(0);
      if (code >= 0x3040 && code <= 0x9fff) cjk++;
      else if (code >= 0x41 && code <= 0x7a) latin++;
    }
  }

  return cjk > latin ? "zh-CN" : "en";
}
const TRANSITION_MS = {
  dissolve: 300,
  fade: 500,
  slowfade: 1200,
  fadeblack: 600,
  flash: 120,
  vpunch: 120,
  hpunch: 120,
  none: 0,
};

/* ------------------------------- discovery -------------------------------- */

/** A Ren'Py game is a directory holding game/ with .rpy or .rpa inside. */
async function discover(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const gameDir = join(dir, "game");
    if (!existsSync(gameDir)) continue;
    const files = await readdir(gameDir).catch(() => []);
    const rpy = files.some((name) => name.endsWith(".rpy"));
    const rpa = files.some((name) => name.endsWith(".rpa"));
    if (rpy || rpa) found.push({ name: entry.name, dir, gameDir, hasRpy: rpy, hasRpa: rpa });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Directory name -> a stable folder id. */
function gameId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/* -------------------------------- parsing --------------------------------- */

/** Strip a trailing comment while respecting quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function indentOf(line) {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 4;
    else break;
  }
  return n;
}

function unquote(value) {
  const trimmed = value.trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(trimmed);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n");
}

/** Ren'Py transition on a `with` line or a trailing `with X`. */
function transitionMs(name) {
  if (!name) return 0;
  const base = name.replace(/^[a-z]+\s+/, "").trim();
  return TRANSITION_MS[base] ?? 0;
}

/** Read a script file into a flat list of meaningful lines. */
async function readScript(path) {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((raw, index) => {
    const body = stripComment(raw).replace(/\s+$/, "");
    if (!body.trim()) return;
    out.push({ indent: indentOf(body), body: body.trim(), line: index + 1 });
  });

  // `define C5 = Character("Cyrus")` is where the displayed names live.
  const defines = new Map();
  const re = /^\s*define\s+([A-Za-z_]\w*)\s*=\s*Character\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gm;
  let m;
  while ((m = re.exec(text))) {
    const name = (m[2] ?? m[3] ?? "").replace(/\\"/g, '"');
    if (name) defines.set(m[1], name);
  }

  // `image ba-74-anim = "images/ba/74"` is the only reliable way to turn the
  // name a script uses into a file; a scene line can name an image anything.
  const images = new Map();
  const imageRe = /^\s*image\s+([^=\n]+?)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([\w.]+)\s*(?:\(|$))/gm;
  while ((m = imageRe.exec(text))) {
    const name = m[1].trim().replace(/\s+/g, "_");
    const file = m[2] ?? m[3] ?? null;
    if (name && file) images.set(name, file);
  }

  return { lines: out, defines, images };
}

/**
 * Parse one script file into pages.
 *
 * Every page is one line of reading. Stage changes are collected and attached
 * to the next page, so the picture changes when the line appears.
 */
/**
 * Parse one script file into pages.
 *
 * Every page is one line of reading. Stage changes are collected and attached
 * to the next page, so the picture changes when the line appears.
 *
 * Blocks nest by indentation, so this is a recursive descent: a label body sits
 * one level deeper than the label, a menu option one level deeper than the menu.
 */
function parseScript(lines, { fileKey, chapter, names, translations }) {
  const pages = [];
  const warnings = { menu: 0, if: 0, screen: 0, python: 0, while: 0, replay: 0, markup: 0, expression: 0, bracket: 0 };
  /** How many option bodies were joined to the statement after their menu. */
  let joinedAfterMenu = 0;

  /**
   * A game can ask for the player's name, and then use it everywhere:
   * `$ persistent.A_name = renpy.input(..., default=_('Ain'), ...)`.
   * Nothing in a text reader can type, so the default is the honest answer, and
   * collecting it up front means the name resolves even when the input line is
   * further down the file than its first use.
   */
  const inputDefaults = new Map();
  for (const line of lines) {
    const assign = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*renpy\.input\(/.exec(line.body);
    if (!assign) continue;
    const fallback = /\bdefault\s*=\s*(?:_\(\s*)?(['"])(.*?)\1/.exec(line.body);
    if (fallback) inputDefaults.set(assign[1], fallback[2]);
  }
  const charSlots = new Map(); // character -> slot
  /** Every picture the script puts on stage, as a file-safe stem. */
  const images = new Set();
  let pendingStage = [];
  let label = null;
  let said = 0; // says seen in the current label, for translation lookup
  let seq = 0;
  let scope = 0;
  let scopeSeq = 0;
  const labels = [];
  /** Child scope -> parent scope, so a block can find the statement after it. */
  const scopeParent = new Map();
  /**
   * Ren'Py continues after a menu when the picked option does not jump or return.
   * Each option body gets its own scope, so the sequential linker cannot reach
   * past it; these groups record where each option body stops so the page that
   * follows the menu can be linked back to it afterwards.
   */
  const menuFallthrough = [];

  // The first page of a label keeps the bare label name, so `jump daily_home`
  // resolves without a rewriting pass; later pages add a suffix.
  const pageId = (suffix) => {
    const name = label ?? "__pre";
    return suffix === 1 ? name : `${name}~${suffix}`;
  };
  const nextIndent = () => (lines[i] ? lines[i].indent : 0);
  let i = 0;

  function newPage(flow, text, speaker) {
    const page = { id: pageId(++seq), line: 0, text: text ?? "", speaker: speaker ?? null, _scope: scope };
    if (pendingStage.length) page.stage = pendingStage;
    page.flow = flow;
    if (chapter) page.caption = chapter;
    pages.push(page);
    pendingStage = [];
    return page;
  }

  function startLabel(name) {
    if (label !== null) seq = 0;
    label = name;
    said = 0;
    labels.push({ label: name, page: name });
    // Every label gets an entry page, so `jump X` resolves even when X only
    // sets state. An empty page costs no click: the reader walks through it.
    newPage({ type: "seq" }, "");
  }

  /** Skip the indented body of a construct we do not represent. */
  function skipChildBlock(indent) {
    while (i < lines.length && lines[i].indent > indent) i++;
  }

  function parseBody(indent) {
    if (indent > lines[i - 1]?.indent || i >= lines.length) return;
    parseBlock(indent);
  }

  function parseBlock(baseIndent) {
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.indent < baseIndent) return;
      if (cur.indent > baseIndent) {
        i++;
        continue;
      }
      const body = cur.body;
      i++;

      let m = /^label\s+([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:/.exec(body);
      if (m) {
        startLabel(m[1]);
        if (i < lines.length && lines[i].indent > cur.indent) parseBlock(lines[i].indent);
        continue;
      }

      if (/^(init\b|define\b|default\b|image\b|transform\b|style\b|screen\b|translate\b|python\b|layeredimage\b|font\b|nvl\b|window\b|modal\b|testcase\b)/.test(body)) {
        if (/^screen\b/.test(body)) warnings.screen++;
        if (/^python\b/.test(body)) warnings.python++;
        if (body.endsWith(":")) skipChildBlock(cur.indent);
        continue;
      }

      if (body.startsWith("$")) continue;

      if (/^menu\b/.test(body)) {
        parseMenu(cur.indent);
        continue;
      }

      if (/^if\b/.test(body)) {
        parseConditional(cur.indent);
        continue;
      }
      if (/^(elif|else)\b/.test(body)) {
        // a branch we did not take; skip its body so its lines are not read twice
        if (body.endsWith(":")) skipChildBlock(cur.indent);
        continue;
      }
      if (/^(while|for)\b/.test(body)) {
        warnings.while++;
        if (body.endsWith(":")) skipChildBlock(cur.indent);
        continue;
      }

      m = /^scene\s+(.+)$/.exec(body);
      if (m) {
        // `scene bg classroom` names an image by tag and attributes, not a file.
        const name = imageName(m[1]);
        pendingStage.push({ k: "bg", bmp: name, tr: null, ms: 0 });
        for (let slot = 0; slot < 4; slot++) pendingStage.push({ k: "clear", slot });
        charSlots.clear();
        if (name) images.add(name);
        continue;
      }

      m = /^show\s+(.+)$/.exec(body);
      if (m) {
        const raw = m[1];
        // `show screen chat` puts a screen on the stage, not a picture.
        if (/^screen\b/.test(raw)) {
          warnings.screen++;
          continue;
        }
        const name = imageName(raw);
        const slot = slotOf(raw);
        if (name) {
          charSlots.set(name, slot);
          images.add(name);
        }
        pendingStage.push({ k: "show", slot, bmp: name ?? raw, fade: /dissolve|fade/.test(raw) });
        continue;
      }

      m = /^hide\s+(.+)$/.exec(body);
      if (m) {
        if (/^screen\b/.test(m[1])) continue;
        const name = imageName(m[1]);
        const slot = charSlots.get(name) ?? charSlots.get(m[1].trim().split(/\s+/)[0]);
        if (slot !== undefined) {
          pendingStage.push({ k: "clear", slot });
          charSlots.delete(name);
        }
        continue;
      }

      m = /^with\s+(.+)$/.exec(body);
      if (m) {
        // a transition belongs to the stage change just before it
        const ms = transitionMs(m[1]);
        const last = pendingStage.length ? pendingStage[pendingStage.length - 1] : null;
        if (last && last.k === "bg") last.ms = ms;
        continue;
      }

      m = /^jump\s+(?:expression\s+)?([A-Za-z_][\w.]*)/.exec(body);
      if (m) {
        newPage({ type: "jump", target: m[1] }, "");
        continue;
      }

      m = /^call\s+(screen\s+)?([A-Za-z_][\w.]*)/.exec(body);
      if (m) {
        if (m[1]) {
          // call screen map / call screen inventory: the UI is not represented
          warnings.screen++;
          continue;
        }
        newPage({ type: "call", target: m[2] }, "");
        continue;
      }

      if (/^return\b/.test(body)) {
        newPage({ type: "return" }, "");
        continue;
      }

      const say = parseSay(body);
      if (say) {
        // A translation replaces the line at the same position in the same label,
        // which is how Ren'Py's own tl/ files line up with the source.
        const translated = translations?.labels.get(label ?? "")?.[said];
        said++;
        newPage({ type: "seq" }, cleanText(translated ?? say.text), say.speaker ? cleanText(say.speaker) : null);
        continue;
      }
      // pause / play / voice / stop / show screen / everything else: atmosphere
    }
  }

  /**
   * `if` keeps the branch the reader would see; the other branches are dropped.
   * A branch guarded by a variable the reader cannot evaluate - `_in_replay` is
   * the common one - is replay-only content in Ren'Py itself, so keeping it
   * would splice extras into the main line and dead-end on dropped statements.
   */
  function parseConditional(ifIndent) {
    const condition = lines[i - 1]?.body ?? "";
    if (/\b_in_replay\b|\brenpy\.in_replay\b/.test(condition)) {
      warnings.replay++;
      if (i < lines.length && lines[i].indent > ifIndent) skipChildBlock(ifIndent);
      while (i < lines.length && lines[i].indent === ifIndent && /^(elif|else)\b/.test(lines[i].body)) {
        const body = lines[i].body;
        i++;
        if (body.endsWith(":")) skipChildBlock(ifIndent);
      }
      return;
    }
    warnings.if++;
    if (i < lines.length && lines[i].indent > ifIndent) parseBlock(lines[i].indent);
    // skip sibling elif/else at the same level
    while (i < lines.length && lines[i].indent === ifIndent && /^(elif|else)\b/.test(lines[i].body)) {
      const body = lines[i].body;
      i++;
      if (body.endsWith(":")) skipChildBlock(ifIndent);
    }
  }

  function parseMenu(menuIndent) {
    warnings.menu++;
    const options = [];
    newPage({ type: "choice", prompt: null, options }, "");

    const optionIndent = i < lines.length ? lines[i].indent : menuIndent + 4;
    const tails = [];
    /** Options whose body produced no page at all: `$` only, or a bare jump. */
    const empty = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.indent <= menuIndent) break;
      if (cur.indent > optionIndent) {
        i++;
        continue;
      }

      const optionLabel = parseOptionLabel(cur.body);
      i++;
      if (optionLabel === null) {
        if (cur.body.endsWith(":")) skipChildBlock(cur.indent);
        continue;
      }

      // Each option body is its own scope so the sequential linker cannot chain
      // the end of one option into the start of the next.
      const saved = scope;
      scope = ++scopeSeq;
      scopeParent.set(scope, saved ?? 0);
      const optionScope = scope;
      const before = pages.length;
      if (i < lines.length && lines[i].indent > cur.indent) parseBlock(lines[i].indent);
      scope = saved;

      const entry = { label: optionLabel, target: pages[before]?.id ?? null };
      options.push(entry);
      if (!entry.target) empty.push(entry);
      for (let p = pages.length - 1; p >= before; p--) {
        if (pages[p]._scope === optionScope) {
          tails.push(pages[p].id);
          break;
        }
      }
    }

    if (tails.length || empty.length) {
      menuFallthrough.push({ tails, empty, parentScope: scope, afterIndex: pages.length });
    }
    return options;
  }

  /**
   * Ren'Py writes markup and variables into the same string as the words:
   * `{i}`, `{/i}`, `{w=0.5}`, `{#0.1,pregnant}` and `[As]`, `[persistent.dad]`.
   * None of it is dialogue, and this reader renders plain text, so tags go and a
   * bracketed name is replaced by the name it stands for.
   *
   * A character's own display name can be an expression - a game that lets the
   * player name someone defines `A = Character("[persistent.A_name]")` - so one
   * resolution can uncover another, hence the depth limit.
   */
  function cleanText(text, depth = 0) {
    if (!text) return text;
    if (depth > 3) return "";
    if (text.indexOf("{") < 0 && text.indexOf("[") < 0) return text;
    if (depth === 0) warnings.markup++;

    const out = text
      // `{w=0.5}`, `{p}`, `{nw}` are timed pauses: a beat between words, not nothing.
      .replace(/\{(?:w|p|nw|cps)(?:=[^{}]*)?\}/g, " ")
      .replace(/\{[^{}]*\}/g, "")
      .replace(/\[([A-Za-z_][\w.\s]*?)\s*(?:![^!\]]*)?\]/g, (_, raw) => {
        const name = raw.replace(/\s+/g, "");
        // The input default is what the game itself would show before typing.
        if (inputDefaults.has(name)) return inputDefaults.get(name);
        const display = names?.get(name);
        if (display !== undefined && display !== name) return cleanText(display, depth + 1);
        // `persistent.dad` is engine state; its last part is the closest word.
        return name.includes(".") ? name.split(".").pop() : "";
      })
      // A python expression in brackets (`[string.capwords(...)]`) cannot be
      // evaluated here, so it goes; leaving source code in dialogue is worse.
      .replace(/\[[^\]\[]{1,120}\]/g, () => {
        warnings.expression++;
        return "";
      })
      // A stray bracket with no partner (`"[ ?"`) is a source typo; it reads as
      // damage rather than as punctuation, so the brackets themselves go.
      .replace(/[[\]]/g, () => {
        warnings.bracket++;
        return "";
      })
      .replace(/\s{2,}/g, " ")
      .trim();

    return out;
  }

  function parseOptionLabel(body) {
    // `"Take the shot" if flag:` / "\"...\"" (args) if cond:
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:\([^)]*\))?\s*(?:if\s+.+?)?\s*:\s*$/.exec(body);
    const text = m ? unquote(m[1]) : null;
    return text === null ? null : cleanText(translations?.strings.get(text) ?? text);
  }

  function parseSay(body) {
    // VAR "text" / "text" / VAR "text" with dissolve / VAR "text" (args)
    const m = /^([A-Za-z_][\w]*)\s+((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\s*(?:with\s+[\w\s]+)?\s*$/.exec(body);
    if (m) {
      const text = unquote(m[2]);
      if (text !== null) return { speaker: names?.get(m[1]) ?? m[1], text };
    }
    const only = unquote(body);
    if (only !== null) return { speaker: null, text: only };
    const m2 = /^([A-Za-z_][\w]*)\s+((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\s+.*$/.exec(body);
    if (m2) {
      const text = unquote(m2[2]);
      if (text !== null) return { speaker: names?.get(m2[1]) ?? m2[1], text };
    }
    return null;
  }

  function slotOf(rest) {
    if (/\bleft\b/.test(rest)) return 0;
    if (/\bright\b/.test(rest)) return 2;
    return 1;
  }

  /**
   * `scene bg classroom at left with dissolve` names an image, then says things
   * about it. Ren'Py's image name is what the script wrote, joined by its own
   * spaces, and a picture file is named the same way - `bg classroom.webp` - so
   * the name is kept verbatim rather than rewritten into an identifier.
   */
  function imageName(rest) {
    // `scene text "..."` draws text, not a picture; the quoted string is not a name.
    if (/^text\s+["']/.test(rest)) return null;
    const name = rest
      .replace(/\([^)]*\)\s*$/, "")
      .replace(/\s+(?:at|as|behind|onlayer|with|zorder|if)\b.*$/, "")
      .trim();
    if (!name) return null;
    return name.replace(/\s+/g, " ");
  }

  parseBlock(0);

  // Labels inside branches we skipped still exist as jump targets. Give them an
  // empty landing page so a jump never points at nothing.
  const declared = [];
  for (const line of lines) {
    const m = /^label\s+([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:/.exec(line.body);
    if (m) declared.push(m[1]);
  }
  const have = new Set(pages.map((page) => page.id.split("~")[0]));
  for (const name of declared) {
    if (have.has(name)) continue;
    const saved = label;
    label = name;
    seq = 0;
    newPage({ type: "seq" }, "");
    label = saved;
    warnings.detached = (warnings.detached ?? 0) + 1;
  }

  // Sequential links stay inside a scope: an option body ends where it ends.
  const encloses = (candidate, scope) => {
    let current = scope ?? 0;
    for (let guard = 0; guard < 64; guard++) {
      if (current === (candidate ?? 0)) return true;
      const parent = scopeParent.get(current);
      if (parent === undefined || parent === current) return false;
      current = parent;
    }
    return false;
  };
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (page.flow.type !== "seq" && page.flow.type !== "call") continue;
    const next = pages[p + 1];
    if (next && next._scope === page._scope) page.next = next.id;
  }

  // Only now can an option body be joined to the statement after its menu: that
  // statement is parsed later, and only if no jump or return already ended the
  // option. Without this the opening menus dead-end and the reader stops there.
  if (menuFallthrough.length) {
    const byId = new Map(pages.map((page) => [page.id, page]));
    for (const group of menuFallthrough) {
      let target = null;
      // The statement a menu falls through to may sit outside the block that
      // held the menu, so any enclosing scope counts, not just the immediate one.
      for (let p = group.afterIndex; p < pages.length; p++) {
        if (encloses(pages[p]._scope, group.parentScope)) {
          target = pages[p];
          break;
        }
      }
      if (!target) continue;
      // An option whose body was only dropped statements still continues after
      // the menu, exactly like an option whose body simply ran to its end.
      for (const entry of group.empty) {
        entry.target = target.id;
        joinedAfterMenu++;
      }
      for (const id of group.tails) {
        const page = byId.get(id);
        if (!page || page.next) continue;
        if (page.flow.type !== "seq" && page.flow.type !== "call") continue;
        page.next = target.id;
        joinedAfterMenu++;
      }
    }
  }

  for (const page of pages) delete page._scope;

  return { pages, warnings, labels, chapter, images: [...images], joinedAfterMenu };
}

/* ------------------------------- importing -------------------------------- */

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function importGame(game, outRoot, variant = {}) {
  const id = gameId(game.name);
  const contentDir = join(outRoot, id, "content");
  const work = join(outRoot, id, "content", "_pages");

  if (!game.hasRpy) {
    return { id, name: game.name, skipped: "no .rpy scripts; needs rpa unpacking first" };
  }

  const scripts = [];
  const translationFiles = [];
  async function walk(dir, underTl = false) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // caches, saves and assets are not story; translations are kept apart
        if (/^(cache|saves|gui|images|audio|fonts)$/i.test(entry.name)) continue;
        await walk(path, underTl || entry.name.toLowerCase() === "tl");
      } else if (entry.name.endsWith(".rpy")) {
        (underTl ? translationFiles : scripts).push(path);
      }
    }
  }
  await walk(game.gameDir);

  // A patch ships `game/tl/<language>/*.rpy`; reading it is what turns a
  // translated game into a translated book. Games can carry several, and applying
  // the wrong one silently changes the language of the whole game, so each is
  // collected separately and one is chosen deliberately.
  const patches = new Map();
  for (const path of translationFiles.sort()) {
    const parts = relative(game.gameDir, path).split(sep);
    const index = parts.findIndex((part) => part.toLowerCase() === "tl");
    if (index < 0 || !parts[index + 1]) continue;
    const language = parts[index + 1].toLowerCase();

    const { lines } = await readScript(path);
    const parsed = parseTranslations(lines);
    const patch = patches.get(language) ?? { labels: new Map(), strings: new Map() };
    for (const [key, texts] of parsed.labels) {
      patch.labels.set(key, (patch.labels.get(key) ?? []).concat(texts));
    }
    for (const [from, to] of parsed.strings) patch.strings.set(from, to);
    patches.set(language, patch);
  }

  // Only a language the reader can present is worth applying: a Vietnamese patch
  // on an English game would replace the text with something the UI cannot name.
  // Two variants are produced per game - the native text and Chinese - and neither
  // is guessed from whatever patch happens to sit in the folder.
  const SUPPORTED = new Set(["zh-CN", "zh-TW", "ja", "en"]);
  const wantedPatch = variant.patch === undefined ? null : variant.patch;
  const chosen =
    wantedPatch === "auto"
      ? [...patches.keys()]
          .map((language) => ({ language, locale: patchLocale(language) }))
          .filter((entry) => SUPPORTED.has(entry.locale))
          .sort((a, b) => SUPPORTED_ORDER.indexOf(a.locale) - SUPPORTED_ORDER.indexOf(b.locale))[0]?.language ?? null
      : wantedPatch && patches.has(String(wantedPatch).toLowerCase())
        ? String(wantedPatch).toLowerCase()
        : null;
  const patchLanguage = chosen;
  const translations = patchLanguage ? patches.get(patchLanguage) : { labels: new Map(), strings: new Map() };
  const skippedPatches = [...patches.keys()].filter((language) => language !== patchLanguage);

  if (variant.patch && !patchLanguage) {
    return { id, name: game.name, skipped: `no patch for ${variant.patch}` };
  }

  // story files first, by name, so day2 comes before day10
  const storyFiles = scripts
    .filter((path) => {
      const stem = basename(path, ".rpy");
      return !/^(options|gui|screens|00|01_|02_|03_|04_|05_)/.test(stem);
    })
    .sort((a, b) => naturalCompare(relative(game.gameDir, a), relative(game.gameDir, b)));

  // Names live in files we do not import as story (01_variables.rpy and friends),
  // so scan every script for character definitions first.
  const characterNames = new Map();
  const imageFiles = new Map();
  for (const path of scripts) {
    const { defines, images } = await readScript(path);
    for (const [key, value] of defines) characterNames.set(key, value);
    for (const [key, value] of images) imageFiles.set(key, value);
  }

  const allPages = [];
  const warnings = {};
  const referencedImages = new Set();
  const stats = { files: storyFiles.length, lines: 0, pages: 0, choices: 0, labels: 0, joined: 0 };

  for (const path of storyFiles) {
    const stem = basename(path, ".rpy");
    const chapter = prettify(stem);
    const { lines } = await readScript(path);
    const parsed = parseScript(lines, { fileKey: "story", chapter, names: characterNames, translations });
    stats.files++;
    stats.lines += lines.length;
    stats.labels += parsed.labels.length;
    stats.joined += parsed.joinedAfterMenu ?? 0;
    if (args.verbose) console.log(`    ${stem.padEnd(28)} lines=${String(lines.length).padStart(6)} pages=${String(parsed.pages.length).padStart(6)} labels=${parsed.labels.length}`);
    if (args.trace === stem) console.log(`    labels: ${parsed.labels.map((l) => l.label).join(", ")}`);
    for (const page of parsed.pages) {
      page.line = page.line || 0;
      allPages.push(page);
    }
    for (const name of parsed.images) referencedImages.add(name);
    for (const [key, value] of Object.entries(parsed.warnings)) {
      warnings[key] = (warnings[key] ?? 0) + value;
    }
  }

  stats.pages = allPages.length;
  stats.choices = allPages.filter((page) => page.flow.type === "choice").length;

  // A menu whose every option leads nowhere is the one failure a reader feels as
  // a freeze: the click happens, nothing follows. Name it here, at import time.
  const deadMenus = allPages.filter(
    (page) => page.flow.type === "choice" && page.flow.options.length > 0 && page.flow.options.every((option) => !option.target),
  );
  stats.deadMenus = deadMenus.length;
  if (deadMenus.length) {
    console.log(`    dead-end menus: ${deadMenus.length}  e.g. ${deadMenus.slice(0, 4).map((page) => page.id).join(", ")}`);
  }

  // Duplicate ids silently overwrite each other downstream, so count them.
  const idCounts = new Map();
  for (const page of allPages) idCounts.set(page.id, (idCounts.get(page.id) ?? 0) + 1);
  const duplicates = [...idCounts].filter(([, count]) => count > 1);
  stats.duplicateIds = duplicates.length;
  if (duplicates.length) {
    console.log(`    duplicate page ids: ${duplicates.length}  e.g. ${duplicates.slice(0, 5).map(([id, count]) => `${id}x${count}`).join(", ")}`);
  }
  if (referencedImages.size) {
    const resolved = [...referencedImages].filter((name) => imageFiles.has(name)).length;
    console.log(
      `    stage images: ${referencedImages.size} named, ${resolved} with a file, ${imageFiles.size} image definitions`,
    );
    if (resolved < referencedImages.size) {
      const unknown = [...referencedImages].filter((name) => !imageFiles.has(name)).slice(0, 5);
      console.log(`      no file for: ${unknown.join(", ")}${resolved < referencedImages.size - 5 ? " …" : ""}`);
    }
  }

  // The registry discovers games by game.json, so an import writes one. The native
  // variant writes it: the locale it detects is what the other variant is an
  // overlay on.
  const locale = variant.locale ?? guessLocale(allPages);
  if (translations.labels.size) {
    const lines = [...translations.labels.values()].reduce((sum, list) => sum + list.length, 0);
    console.log(`    ${locale} + patch ${patchLanguage}: ${translations.labels.size} blocks, ${lines} lines`);
  }
  if (skippedPatches.length) console.log(`    patches not applied: ${skippedPatches.join(", ")}`);
  const metaPath = join(outRoot, id, "game.json");
  if (!existsSync(metaPath) || variant.writeMeta) {
    // A re-import must not lose what only the game knows: the art's native size.
    let previous = {};
    try {
      previous = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      previous = {};
    }
    const design = args.design ? parseDesign(args.design) : previous.design;
    await mkdir(join(outRoot, id), { recursive: true });
    await writeFile(
      metaPath,
      `${JSON.stringify(
        { ...previous, id, title: game.name, sourceLocale: variant.writeMeta ? locale : previous.sourceLocale ?? locale, ...(design ? { design } : {}) },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  // One page file for the whole game: Ren'Py labels are global.
  const pageFile = {
    source: `${game.name} (story)`,
    slotOffsets: { l: -300, c: 0, r: 300 },
    captions: [],
    pages: allPages,
  };
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "story.pages.json"), JSON.stringify(pageFile), "utf8");

  // A locale that is no longer produced is stale: leaving it makes the reader
  // offer an old translation next to the new one. Only the variant that knows the
  // full set of locales may prune, otherwise writing Chinese deletes the native
  // text it is an overlay on.
  if (variant.prune) {
    const keep = new Set(variant.keep ?? [locale]);
    for (const entry of await readdir(contentDir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name !== "_pages" && !keep.has(entry.name)) {
        await rm(join(contentDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  const build = spawnSync(
    process.execPath,
    [
      "tools/build-content.mjs",
      "--src",
      work,
      "--out",
      join(outRoot, id, "content"),
      "--lang",
      locale,
      "--title",
      basename(game.name),
      "--start",
      "start",
    ],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    return { id, name: game.name, failed: (build.stderr || build.stdout || "").split("\n").slice(0, 4).join(" | ") };
  }

  await writeFile(
    join(contentDir, `import${variant.locale ? `-${variant.locale}` : ""}.json`),
    `${JSON.stringify(
      {
        game: game.name,
        locale,
        patch: patchLanguage,
        importedAt: new Date().toISOString(),
        files: storyFiles.map((path) => relative(game.gameDir, path).split(sep).join("/")),
        stats,
        warnings,
        build: build.stdout.split("\n").filter((line) => /nodes|texts|dangling|sources/.test(line)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rm(work, { recursive: true, force: true });

  return { id, name: game.name, locale, stats, warnings };
}

function prettify(stem) {
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/* ---------------------------------- main ---------------------------------- */

const games = await discover(args.root);
if (args.list) {
  for (const game of games) {
    console.log(`${gameId(game.name).padEnd(28)} ${game.name}  ${game.hasRpa && !game.hasRpy ? "[rpa only]" : ""}`);
  }
  process.exit(0);
}

const targets = args.only ? games.filter((game) => game.name === args.only || gameId(game.name) === args.only) : games;
if (targets.length === 0) {
  console.error(`no Ren'Py game matched in ${args.root}`);
  process.exit(1);
}

for (const game of targets) {
  const native = await importGame(game, outRoot, { writeMeta: true });
  if (native.skipped) {
    console.log(`skip  ${native.id.padEnd(24)} ${native.skipped}`);
    continue;
  }
  if (native.failed) {
    console.log(`FAIL  ${native.id.padEnd(24)} ${native.failed}`);
    continue;
  }

  const w = Object.entries(native.warnings).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(
    `ok    ${native.id.padEnd(24)} pages=${native.stats.pages} choices=${native.stats.choices} labels=${native.stats.labels} files=${native.stats.files} menu-joins=${native.stats.joined ?? 0}${w ? `  dropped: ${w}` : ""}`,
  );

  // A game keeps two languages: the one it was written in and Chinese.
  const chinese = await importGame(game, outRoot, { patch: "auto", locale: "zh-CN" });
  if (chinese.skipped || chinese.failed) {
    console.log(`      ${chinese.skipped ?? `FAIL ${chinese.failed}`}`);
  }

  const keep = new Set([native.locale, chinese.skipped || chinese.failed ? null : "zh-CN"]);
  for (const entry of await readdir(join(outRoot, native.id, "content"), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name !== "_pages" && !keep.has(entry.name)) {
      await rm(join(outRoot, native.id, "content", entry.name), { recursive: true, force: true });
    }
  }
}
