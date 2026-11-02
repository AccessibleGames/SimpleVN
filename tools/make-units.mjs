#!/usr/bin/env node
/**
 * Cut the page graph into translation units (one scene per unit) and emit the
 * files the translator subagent reads.
 *
 *   node tools/make-units.mjs [--source newgame] [--out .pi/translation/units]
 *
 * Per unit:
 *   <unit>.json        unit descriptor + page id map        (parent owns)
 *   <unit>.in.tsv      seq â‡¥ speaker â‡¥ source text          (parent owns)
 *   <unit>.tokens.json seq -> [{ i, kind, raw }]            (parent owns)
 *   <unit>.brief.md    <=80 lines of context                (parent owns)
 *   <unit>.state.json  status / range                       (parent owns)
 *
 * The subagent only writes <unit>.out.tsv / .progress.tsv / .rejects.tsv.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveContentDir } from "./content-dir.mjs";
import { createHash } from "node:crypto";

const LEADING_INDENT = /^\u3000+/u;

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

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source ?? "newgame";
  const outDir = args.out ?? join(".pi", "translation", "units");
  const contentDir = resolveContentDir(args);

  const graph = JSON.parse(await readFile(join(contentDir, "graph.json"), "utf8"));
  const pack = JSON.parse(await readFile(join(contentDir, "ja", "pack.json"), "utf8"));

  // Scene = consecutive pages sharing one caption, in script order.
  const scenes = [];
  let current = null;

  for (const id of Object.keys(graph.nodes)) {
    if (!id.startsWith(`${source}:`)) continue;
    const node = graph.nodes[id];
    const caption = node.caption ? pack.captions[node.caption] : null;

    if (!current || current.caption !== caption) {
      current = { caption, ids: [] };
      scenes.push(current);
    }
    current.ids.push(id);
  }

  await mkdir(outDir, { recursive: true });

  // Scene boundaries can move when the source is re-extracted. Any story unit
  // that is no longer a scene start is stale: its pages are covered by the
  // merged unit, and leaving it behind means translating the same pages twice.
  const validUnits = new Set(scenes.map((scene) => scene.ids[0].split(":")[1]));
  const unitFiles = await readdir(outDir);
  const stale = new Set();
  for (const file of unitFiles) {
    if (!file.endsWith(".json") || file.endsWith(".state.json") || file.endsWith(".tokens.json")) continue;
    const name = file.slice(0, -5);
    if (validUnits.has(name)) continue;
    try {
      const meta = JSON.parse(await readFile(join(outDir, file), "utf8"));
      if (meta.kind === "story") stale.add(name);
    } catch {
      // unreadable unit file, leave it alone
    }
  }
  if (stale.size > 0) {
    const { unlink } = await import("node:fs/promises");
    for (const name of stale) {
      for (const file of unitFiles) {
        if (file === name || file.startsWith(`${name}.`)) {
          await unlink(join(outDir, file)).catch(() => {});
        }
      }
    }
    console.log(`removed ${stale.size} stale unit(s): ${[...stale].join(", ")}`);
  }
  const existing = new Set((await readdir(outDir)).filter((n) => n.endsWith(".json")));

  const summary = [];

  for (const scene of scenes) {
    const unit = scene.ids[0].split(":")[1];
    const speakers = new Set();
    const rows = [];
    const tokens = {};
    let chars = 0;

    scene.ids.forEach((id, index) => {
      const node = graph.nodes[id];
      const seq = index + 1;
      const raw = pack.text[id] ?? "";
      const speaker = node.speaker ? pack.names[node.speaker] ?? "" : "";
      if (speaker) speakers.add(speaker);

      // The only formatting that survives translation is the leading ideographic
      // indent, so it becomes an inline keep-placeholder for the subagent and is
      // restored by the backfill step.
      const indent = LEADING_INDENT.exec(raw);
      const list = [];
      let body = raw;
      if (indent) {
        list.push({ i: 0, kind: "keep", raw: indent[0] });
        body = `\u27e60\u27e7${raw.slice(indent[0].length)}`;
      }
      tokens[String(seq)] = list;

      chars += raw.length - (indent ? indent[0].length : 0);
      rows.push(`${seq}\t${speaker}\t${body}`);
    });

    const last = graph.nodes[scene.ids[scene.ids.length - 1]];
    const exits = last.choices
      ? last.choices.map((c) => pack.text[c.text] ?? "").slice(0, 4)
      : [last.next ? last.next.split(":")[1] : "ï¼ˆåœºæ™¯ç»“æŸï¼‰"];

    const inTsv = rows.join("\n") + "\n";
    const stateFile = join(outDir, `${unit}.state.json`);

    // Never clobber work in progress.
    if (existing.has(`${unit}.state.json`)) {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      if (state.status !== "pending") {
        summary.push({ unit, pages: scene.ids.length, skipped: state.status });
        continue;
      }
    }

    await writeFile(join(outDir, `${unit}.in.tsv`), inTsv, "utf8");
    await writeFile(join(outDir, `${unit}.tokens.json`), `${JSON.stringify(tokens)}\n`, "utf8");

    await writeFile(
      join(outDir, `${unit}.json`),
      `${JSON.stringify(
        {
          unit,
          kind: "story",
          atomic: true,
          caption: scene.caption,
          source,
          pages: scene.ids.length,
          chars,
          source_sha256: sha256(inTsv),
          control_flow: {
            entry: "ä¸Šä¸€ä¸ªåœºæ™¯é¡ºåºæµå…¥",
            exit: last.choices ? { type: "choice", labels: exits } : exits,
          },
          characters_expected: [...speakers],
          page_ids: scene.ids,
        },
        null,
        1,
      )}\n`,
      "utf8",
    );

    const brief = [
      `# ${unit} â€” ${scene.caption ?? "(æ— æ ‡é¢˜)"}`,
      "",
      `åŽŸä½œï¼šå¯¾é­”å¿ãƒ¦ã‚­ã‚«ã‚¼ Animation / ${source}.ksã€€${scene.ids.length} é¡µ / ${chars} å­—`,
      "",
      "## å‡ºåœºè¯´è¯äºº",
      ...[...speakers].map((s) => `- ${s}`),
      "",
      "## èƒŒæ™¯",
      "- è¿‘æœªæ¥æ—¥æœ¬ï¼Œå¦–é­”æ¨ªè¡Œï¼›æ”¿åºœç»„ç»‡ã€Œå¯¹é­”å¿ã€å¯¹æŠ—é­”ç•ŒåŠ¿åŠ›ã€‚",
      "- äº”è½¦å­¦å›­ä¸€å¹´çº§ã€Œé›·å‡»å¯¹é­”å¿ã€æ°´åŸŽé›ªé£Žï¼Œä¸ºå¯»æ‰¾å¤±è¸ªçš„æ¯äº²ï¼ˆå¯¹é­”å¿ä¸çŸ¥ç«ï¼‰ï¼Œä¸Žå­¦å§ã€Œæ–©é¬¼å¯¹é­”å¿ã€ç§‹å±±å‡›å­æ½œå…¥åœ°ä¸‹çŠ¯ç½ªéƒ½å¸‚é»„æ³‰åŽŸã€‚",
      "- é›ªé£Žçš„é’æ¢…ç«¹é©¬ã€å‡›å­çš„å¼Ÿå¼Ÿç§‹å±±è¾¾éƒŽä¸ºä¸»è§’è§†è§’ï¼Œæœ¬ä½œæ˜¯ NTR é¢˜æã€‚",
      "",
      "## ç¡¬è§„åˆ™æ‘˜è¦",
      "- in.tsv ä¸‰åˆ—ï¼š`åºå· â‡¥ è¯´è¯äºº â‡¥ åŽŸæ–‡`ï¼›è¯´è¯äººä¸ºç©ºå³æ—ç™½ã€‚out.tsv åªå†™ `åºå· â‡¥ è¯‘æ–‡`ã€‚",
      "- ä¸€è¡Œå¯¹ä¸€è¡Œï¼Œä¸åˆå¹¶ä¸æ‹†åˆ†ï¼›è¯‘æ–‡å•è¡Œï¼Œä¸å« tab ä¸ŽçœŸæ¢è¡Œï¼›ä¸åŠ è¡Œé¦–ç¼©è¿›ã€‚",
      "- æ ‡ç‚¹å…¨è§’ï¼š`ã€Œã€ã€Žã€ï¼ˆï¼‰â€œâ€â€•â€•â€¦â€¦ã€ã€‚ï¼ï¼Ÿ`ã€‚",
      "- äººåæŒ‰ `lock/characters.tsv`ï¼Œæœ¯è¯­æŒ‰ `lock/glossary.tsv`ï¼Œè¡¨é‡Œæ²¡æœ‰çš„å…ˆè®°æš‚å®šå¹¶åœ¨ PROVISIONAL æŠ¥å‡ºã€‚",
      "- è¯­æ°”ï¼šæ—¥è½»è¯‘æœ¬è…”ï¼ˆè§ `lock/tone.md`ï¼‰ï¼›R18 æ®µè½ç…§è¯‘ä¸åˆ å‡ã€‚",
      "",
      "## é¡ºåº",
      `- èµ·ç‚¹ ${scene.ids[0]}ã€€ç»ˆç‚¹ ${scene.ids[scene.ids.length - 1]}`,
      `- å‡ºå£ï¼š${JSON.stringify(exits)}`,
      "",
      "## ä¸è¦åš",
      "- ä¸è¦æ”¹ `lock/`ã€ä¸è¦æ”¹ `units/*.json|in.tsv|tokens.json|brief.md|state.json`",
      "- ä¸è¦è‡ªå·±é€ å•å…ƒã€ä¸è¦å›žå¡«ã€ä¸è¦å†™é¡µé¢ id",
    ].join("\n");

    await writeFile(join(outDir, `${unit}.brief.md`), `${brief}\n`, "utf8");
    await writeFile(
      stateFile,
      `${JSON.stringify({ status: "pending", range: [1, scene.ids.length], runs: 0 }, null, 1)}\n`,
      "utf8",
    );

    summary.push({ unit, pages: scene.ids.length, chars, caption: scene.caption });
  }

  console.log(`units: ${summary.length}`);
  for (const s of summary) {
    console.log(
      `  ${s.unit.padEnd(14)} ${String(s.pages).padStart(5)}p ${String(s.chars ?? "").padStart(6)}c  ${s.caption ?? ""}${s.skipped ? `  [${s.skipped}]` : ""}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
