import { join } from "node:path";

/**
 * Resolve a game's content directory.
 *
 *   --content games/yukikaze1/content
 *   --game yukikaze1                 (short form for the line above)
 *   VN_CONTENT=games/yukikaze1/content
 *
 * No default: the repo holds more than one game, so guessing would silently
 * write into the wrong one.
 */
export function resolveContentDir(args) {
  const explicit =
    args.content ?? (args.game ? join("games", args.game, "content") : undefined) ?? process.env.VN_CONTENT;

  if (!explicit) {
    console.error("need --content <dir> or --game <id> (for example --game yukikaze1)");
    process.exit(1);
  }

  return explicit;
}
