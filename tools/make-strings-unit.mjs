#!/usr/bin/env node
/**
 * Cut one "strings" unit: scene captions + choice prompts + choice labels.
 *
 *   node tools/make-strings-unit.mjs [--unit _strings] [--out .pi/translation/units]
 *
 * Same in.tsv / out.tsv contract as the story units, but each row maps to a
 * pack key instead of a page id, so the backfill has to know where it goes:
 *   items: [{ seq, key, where: "captions" | "text" }]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveContentDir } from "./content-dir.mjs";
import { createHash } from "node:crypto";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unit = args.unit ?? "_strings";
  const outDir = args.out ?? join(".pi", "translation", "units");
  const contentDir = resolveContentDir(args);

  const graph = JSON.parse(await readFile(join(contentDir, "graph.json"), "utf8"));
  const ja = JSON.parse(await readFile(join(contentDir, "ja", "pack.json"), "utf8"));

  const items = [];
  const rows = [];
  const seen = new Set();

  const add = (source, key, where) => {
    if (!source || seen.has(`${where}:${key}`)) return;
    seen.add(`${where}:${key}`);
    const seq = items.length + 1;
    items.push({ seq, key, where });
    rows.push(`${seq}\t\t${source}`);
  };

  // Scene captions, in script order.
  for (const id of Object.keys(graph.nodes)) {
    const node = graph.nodes[id];
    if (!node.caption) continue;
    add(ja.captions[node.caption], node.caption, "captions");
  }

  // Choice prompts and options.
  for (const id of Object.keys(graph.nodes)) {
    const node = graph.nodes[id];
    if (!node.choices) continue;
    if (node.prompt) add(ja.text[node.prompt], node.prompt, "text");
    for (const choice of node.choices) add(ja.text[choice.text], choice.text, "text");
  }

  await mkdir(outDir, { recursive: true });
  const inTsv = rows.join("\n") + "\n";

  await writeFile(join(outDir, `${unit}.in.tsv`), inTsv, "utf8");
  await writeFile(join(outDir, `${unit}.tokens.json`), "{}\n", "utf8");
  await writeFile(
    join(outDir, `${unit}.json`),
    `${JSON.stringify(
      {
        unit,
        kind: "strings",
        atomic: true,
        caption: "åœºæ™¯æ ‡é¢˜ + é€‰æ‹©æ”¯æ–‡æœ¬",
        source: "graph captions/choices",
        pages: items.length,
        chars: rows.reduce((sum, row) => sum + row.split("\t")[2].length, 0),
        source_sha256: createHash("sha256").update(inTsv, "utf8").digest("hex"),
        control_flow: { entry: "(ç‹¬ç«‹å­—ç¬¦ä¸²é›†)", exit: "(ç‹¬ç«‹å­—ç¬¦ä¸²é›†)" },
        characters_expected: [],
        items,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(outDir, `${unit}.brief.md`),
    [
      `# ${unit} â€” åœºæ™¯æ ‡é¢˜ä¸Žé€‰æ‹©æ”¯æ–‡æœ¬`,
      "",
      `å…± ${items.length} æ¡ï¼šåœºæ™¯æ ‡é¢˜ï¼ˆchapter captionï¼Œå½¢å¦‚ã€Œâ€•åºç« ã€€é«˜å±¤ã®å¯¾é­”å¿â€•ã€ï¼‰+ é€‰æ‹©æ”¯æé—®ä¸Žé€‰é¡¹ã€‚`,
      "",
      "## è¦æ±‚",
      "- åœºæ™¯æ ‡é¢˜ä¿ç•™ `â€•â€¦â€¦â€•` çš„ç ´æŠ˜å·åŒ…è£¹å½¢å¼ï¼Œä¸­è¯‘æ”¾ä¸­é—´ï¼Œä¾‹ï¼š`â€•åºç«  é«˜å±‚å¯¹é­”å¿â€•`",
      "- æ ‡é¢˜é‡Œçš„å…¨è§’ç©ºæ ¼æ¢æˆæ™®é€šå…¨è§’ç©ºæ ¼æˆ–ç›´æŽ¥è¿žå†™ï¼Œä¸è¦ç”¨åŠè§’ç©ºæ ¼",
      "- é€‰æ‹©æ”¯æ–‡æ¡ˆæ˜¯çŽ©å®¶çœ‹çš„ä¸€å¥è¯ï¼Œè¦çŸ­ã€è¦èƒ½å½“æŒ‰é’®æ–‡æœ¬",
      "- å…¶ä½™è§„åˆ™åŒ `lock/rules.md`",
    ].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    join(outDir, `${unit}.state.json`),
    `${JSON.stringify({ status: "pending", range: [1, items.length], runs: 0 }, null, 1)}\n`,
    "utf8",
  );

  console.log(`unit ${unit}: ${items.length} strings`);
  for (const row of rows.slice(0, 6)) console.log("  " + row.replace(/\t/g, " | "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
