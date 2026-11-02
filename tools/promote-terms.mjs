#!/usr/bin/env node
/**
 * Move provisional terms from the working glossary into the confirmed one.
 *
 *   node tools/promote-terms.mjs [--unit <unit>] [--all]
 *
 * The working file (`glossary.tsv`) is written by the translator subagent; the
 * confirmed table (`lock/glossary.tsv`) belongs to the parent. Promoting means:
 * append to lock, drop the row from the working file. Nothing is guessed here —
 * conflicts (same src, different dst) are reported and left alone.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

function parseTsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = line.split("\t");
    if (cells.length < 2) continue;
    rows.push({ src: cells[0], dst: cells[1], note: cells[2] ?? "", raw: line });
  }
  return rows;
}

const HEADER = "src\tdst\tnote";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = join(".pi", "translation");
  const workingPath = join(root, "glossary.tsv");
  const lockPath = join(root, "lock", "glossary.tsv");

  let working;
  let lock;
  try {
    working = parseTsv(await readFile(workingPath, "utf8"));
  } catch {
    console.log("no working glossary");
    return;
  }
  lock = parseTsv(await readFile(lockPath, "utf8"));

  const lockedBySrc = new Map(lock.map((row) => [row.src, row]));
  const promoted = [];
  const conflicts = [];
  const remaining = [];

  for (const row of working) {
    if (row.src === "src") continue; // header row
    const existing = lockedBySrc.get(row.src);
    if (existing && existing.dst === row.dst) continue; // already confirmed -> drop
    if (existing && existing.dst !== row.dst) {
      conflicts.push(`${row.src}: lock=${existing.dst} work=${row.dst}`);
      remaining.push(row);
      continue;
    }
    promoted.push(row);
    lockedBySrc.set(row.src, row);
  }

  if (promoted.length > 0) {
    const lockText =
      lock.map((row) => row.raw).join("\n") +
      "\n" +
      promoted.map((row) => `${row.src}\t${row.dst}\t${row.note}`).join("\n") +
      "\n";
    await writeFile(lockPath, lockText.replace(/^\n/, ""), "utf8");
  }

  const workingText = [HEADER, ...remaining.map((row) => row.raw)].join("\n") + "\n";
  await writeFile(workingPath, workingText, "utf8");

  console.log(`promoted ${promoted.length}, conflicts ${conflicts.length}, left ${remaining.length}`);
  for (const row of promoted.slice(0, 20)) console.log(`  + ${row.src} -> ${row.dst}`);
  for (const conflict of conflicts) console.log(`  ! ${conflict}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
