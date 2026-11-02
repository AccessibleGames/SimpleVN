#!/usr/bin/env node
/**
 * Print the next unit to translate, with the exact seq range from state.json.
 *
 *   node tools/next-unit.mjs [--after s10a_0000]
 *
 * Guards against hand-typing a range: the range always comes from state.json,
 * and the row count of in.tsv is verified against it.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const afterIndex = args.indexOf("--after");
const after = afterIndex >= 0 ? args[afterIndex + 1] : null;

const dir = join(".pi", "translation", "units");
const files = (await readdir(dir)).filter((name) => name.endsWith(".state.json")).sort();

let started = after === null;
const rows = [];

for (const file of files) {
  const unit = file.replace(/\.state\.json$/, "");
  if (!started) {
    if (unit === after) started = true;
    continue;
  }

  const state = JSON.parse(await readFile(join(dir, file), "utf8"));
  if (state.status !== "pending") continue;

  const inTsv = await readFile(join(dir, `${unit}.in.tsv`), "utf8");
  const lines = inTsv.trim().split("\n").filter(Boolean);

  rows.push({
    unit,
    range: state.range,
    lines: lines.length,
    consistent: lines.length === state.range[1] - state.range[0] + 1,
    status: state.status,
  });
}

const pending = rows.length;
console.log(`pending units: ${pending}`);
for (const row of rows.slice(0, 5)) {
  const warn = row.consistent ? "" : "  <-- in.tsv size != state.range";
  console.log(`  ${row.unit.padEnd(14)} seq ${row.range[0]}-${row.range[1]}  (${row.lines} rows)${warn}`);
}
if (rows[0]) {
  console.log(`\nnext: ${rows[0].unit} lines ${rows[0].range[0]}-${rows[0].range[1]}`);
}
