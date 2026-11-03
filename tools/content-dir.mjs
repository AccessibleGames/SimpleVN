import { join } from "node:path";

/**
 * Resolve a game's content directory.
 *
 *   --content games/<id>/content
 *   --game <id>                      (short form for the line above)
 *   VN_CONTENT=games/<id>/content
 *
 * No default: the repo holds more than one game, so guessing would silently
 * write into the wrong one.
 */
export function resolveContentDir(args) {
  const explicit =
    args.content ?? (args.game ? join("games", args.game, "content") : undefined) ?? process.env.VN_CONTENT;

  if (!explicit) {
    console.error("need --content <dir> or --game <id> (for example --game <id>)");
    process.exit(1);
  }

  return explicit;
}
