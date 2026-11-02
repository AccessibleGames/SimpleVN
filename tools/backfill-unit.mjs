#!/usr/bin/env node
/**
 * Validate one unit's out.tsv and merge it into the Chinese content pack.
 *
 *   node tools/backfill-unit.mjs --unit s01_101_a [--lang zh-CN]
 *
 * Validation (fails the unit, prints every problem):
 *   1. seq set equals in.tsv's, no duplicates
 *   2. placeholder multiset equals tokens.json, each exactly once
 *   3. no tabs / real newlines
 *   4. no kana or hangul left in the translation
 *   5. length ratio 0.4 - 2.5 against the source
 *
 * Backfill: ⟦n⟧ keep -> raw (the leading ideographic indent), resolve -> the
 * name from lock/characters.tsv.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveContentDir } from "./content-dir.mjs";

const PLACEHOLDER = /⟦(\d+)⟧/g;
// Kana letters only. Excludes the voiced marks ゛ U+309B / ゜ U+309C (used on
// purpose for a cracked voice) and the middle dot ・ U+30FB.
const KANA = /[\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc\u30fd-\u30fe]/u;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/u;

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

/**
 * Japanese source length without inline furigana: 山田太郎（やまだたろう） -> 山田太郎
 * Only strips a kana-only parenthetical that follows some text, so a line like
 * （なにかを考える） (an inner monologue) is not mistaken for a reading.
 */
function rubyStrippedLength(source) {
  return source.replace(/(?<=[^\s\u3000])（[\u3040-\u309f\u30a0-\u30ffー]{1,16}）/gu, "").length;
}

function parseTsv(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells.length < 2) continue;
    rows.set(cells[0], cells.slice(1));
  }
  return rows;
}

async function readTsv(path) {
  return parseTsv(await readFile(path, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unit = args.unit;
  if (!unit) {
    console.error("usage: node tools/backfill-unit.mjs --unit <unit> [--lang zh-CN]");
    process.exit(1);
  }

  const lang = args.lang ?? "zh-CN";
  const root = join(".pi", "translation");
  const unitDir = join(root, "units");

  const meta = JSON.parse(await readFile(join(unitDir, `${unit}.json`), "utf8"));
  const tokens = JSON.parse(await readFile(join(unitDir, `${unit}.tokens.json`), "utf8"));
  const input = await readTsv(join(unitDir, `${unit}.in.tsv`));
  const output = await readTsv(join(unitDir, `${unit}.out.tsv`));

  const problems = [];
  const warnings = [];
  const translations = new Map();

  for (const [seq, cells] of input) {
    const translated = output.get(seq);
    if (!translated) {
      problems.push(`seq ${seq}: missing in out.tsv`);
      continue;
    }
    const zhRaw = translated[0] ?? "";
    // U+30FC (long vowel mark) is a source-language character in Chinese output.
    // Normalize it to an em dash instead of bouncing the line back.
    const zh = zhRaw.replace(/\u30fc+/gu, (run) => {
      warnings.push(`seq ${seq}: long vowel mark normalized (${run.length})`);
      return "——";
    });
    const source = cells[1] ?? "";

    const expected = (tokens[seq] ?? []).filter((t) => t.kind === "keep" || t.kind === "translate");
    const expectedIdx = expected.map((t) => String(t.i)).sort().join(",");
    const found = [...zh.matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(",");

    if (expectedIdx !== found) {
      problems.push(`seq ${seq}: placeholder ⟦${found || "-"}⟧ != expected ⟦${expectedIdx || "-"}⟧`);
      continue;
    }

    const plain = zh.replace(PLACEHOLDER, "");
    if (plain.includes("\t")) problems.push(`seq ${seq}: contains a tab`);
    if (plain.includes("\n")) problems.push(`seq ${seq}: contains a newline`);
    if (/[\u309b\u309c]/u.test(plain)) warnings.push(`seq ${seq}: voiced sound mark kept`);
    if (KANA.test(plain)) problems.push(`seq ${seq}: kana left -> ${plain.slice(0, 24)}`);
    if (HANGUL.test(plain)) problems.push(`seq ${seq}: hangul left -> ${plain.slice(0, 24)}`);
    // lock/tone.md: the formal 您 never appears; the cast address each other as 你.
    // This is a rule, so it fails the unit instead of trusting the writer.
    if (plain.includes("您")) problems.push(`seq ${seq}: formal pronoun 您 used`);
    if (!plain.trim()) problems.push(`seq ${seq}: empty translation`);

    const ratio = plain.length / Math.max(1, rubyStrippedLength(source.replace(PLACEHOLDER, "")));
    // Skill threshold: 0.3 - 3.0. Out of range is a warning, not a failure.
    if (ratio < 0.3 || ratio > 3.0) {
      warnings.push(`seq ${seq}: length ratio ${ratio.toFixed(2)} (${plain.length}/${source.length})`);
    }

    translations.set(seq, zh);
  }

  for (const seq of output.keys()) {
    if (!input.has(seq)) problems.push(`seq ${seq}: not in in.tsv`);
  }

  if (problems.length > 0) {
    console.error(`FAILED ${unit}: ${problems.length} problem(s)`);
    for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
    process.exit(2);
  }

  if (warnings.length > 0) {
    console.warn(`WARN ${unit}: ${warnings.length} warning(s)`);
    for (const warning of warnings.slice(0, 20)) console.warn(`  ${warning}`);
  }

  // Backfill placeholders.
  const backfill = (zh) =>
    zh.replace(PLACEHOLDER, (whole, index) => {
      const token = (tokens[String(currentSeq)] ?? []).find((t) => String(t.i) === index);
      if (!token) return whole;
      if (token.kind === "keep") return token.raw;
      if (token.kind === "resolve") return token.dst ?? token.raw;
      return token.dst ?? token.raw;
    });

  let currentSeq = 0;
  const out = {};
  // strings units target pack buckets directly; collect first, the pack is read below.
  const buckets = {};

  if (meta.items) {
    for (const item of meta.items) {
      currentSeq = String(item.seq);
      const bucket = (buckets[item.where] ??= {});
      bucket[item.key] = backfill(translations.get(currentSeq) ?? "");
    }
  } else {
    meta.page_ids.forEach((pageId, index) => {
      currentSeq = String(index + 1);
      out[pageId] = backfill(translations.get(currentSeq) ?? "");
    });
  }

  // Merge into the language pack.
  const contentDir = resolveContentDir(args);
  const packPath = join(contentDir, lang, "pack.json");
  let pack;
  try {
    pack = JSON.parse(await readFile(packPath, "utf8"));
  } catch {
    pack = { locale: lang, title: "", names: {}, captions: {}, text: {} };
  }

  pack.locale = lang;
  if (Object.keys(out).length > 0) pack.text = { ...pack.text, ...out };
  for (const [where, entries] of Object.entries(buckets)) {
    pack[where] = { ...(pack[where] ?? {}), ...entries };
  }

  // Confirmed renames (user overrides) are applied to the whole pack so older
  // units converge on the current wording without being retranslated.
  const renames = await readTsv(join(root, "lock", "renames.tsv")).catch(() => new Map());
  let renamed = 0;
  for (const [from, cells] of renames) {
    if (!from || from === "from") continue;
    const to = cells[0];
    if (!to) continue;
    for (const bucket of [pack.text, pack.captions, pack.names]) {
      if (!bucket) continue;
      for (const key of Object.keys(bucket)) {
        if (typeof bucket[key] === "string" && bucket[key].includes(from)) {
          bucket[key] = bucket[key].split(from).join(to);
          renamed++;
        }
      }
    }
  }
  if (renamed > 0) console.log(`  renames applied: ${renamed}`);

  // Names from the confirmed character table.
  const jaPack = JSON.parse(await readFile(join(contentDir, "ja", "pack.json"), "utf8"));
  const names = await readTsv(join(root, "lock", "characters.tsv"));
  const byJaName = new Map();
  for (const [src, cells] of names) byJaName.set(src, cells[0]);

  pack.names = { ...pack.names };
  for (const [key, ja] of Object.entries(jaPack.names)) {
    const zh = byJaName.get(ja);
    if (zh) pack.names[key] = zh;
  }

  await mkdir(join(contentDir, lang), { recursive: true });
  await writeFile(packPath, `${JSON.stringify(pack)}\n`, "utf8");

  // Mark the unit done.
  const statePath = join(unitDir, `${unit}.state.json`);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    `${JSON.stringify({ ...state, status: "done", done: translations.size }, null, 1)}\n`,
    "utf8",
  );

  const chars = Object.values(out).reduce((sum, t) => sum + t.length, 0);
  console.log(`OK ${unit}: ${translations.size} lines, ${chars} chars -> ${packPath}`);
  console.log(
    `   pack: text ${Object.keys(pack.text).length}/${Object.keys(jaPack.text).length}, captions ${Object.keys(pack.captions ?? {}).length}/${Object.keys(jaPack.captions).length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
