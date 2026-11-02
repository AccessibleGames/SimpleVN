import { useEffect, useState } from "preact/hooks";
import { buildStory } from "./app";
import { loadGame } from "@games";
import { initialLocale, setLocale, t } from "./i18n";
import type { Locale } from "./i18n";
import type { Story } from "./types";
import type { GameSummary } from "./game";

/**
 * Scene replay: every caption run in the script, in script order, as a list.
 *
 * Opening a scene starts a detached session at that node. Variables start from
 * the script's initial values, which is what a replay means — the point is to
 * watch the scene again, not to reproduce the exact flag state of a past visit.
 */
export function Scenes({
  game,
  onPick,
  onExit,
}: {
  game: GameSummary;
  onPick: (node: string) => void;
  onExit: () => void;
}) {
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadGame(game.id)
      .then((content) => {
        if (!live) return;
        if (!content) {
          setError(`no content for ${game.id}`);
          return;
        }
        const locale = initialLocale();
        setLocale(locale);
        setStory(buildStory(content, locale as Locale));
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [game.id]);

  const scenes = story?.scenes ?? [];

  return (
    <main class="scenes">
      <div class="scene-head">
        <h1 class="scene-title">{game.title}</h1>
        <button class="btn-text" type="button" onClick={onExit}>
          {t("scenes.close")}
        </button>
      </div>

      {error && <p class="scene-note">{error}</p>}
      {!error && !story && <p class="scene-note">{t("app.loading")}</p>}
      {story && scenes.length === 0 && <p class="scene-note">{t("scenes.empty")}</p>}

      {scenes.length > 0 && (
        <>
          <p class="scene-note">{t("scenes.hint")}</p>
          <ol class="scene-list">
            {scenes.map((scene, index) => (
              <li key={`${scene.node}#${index}`}>
                <button type="button" class="scene-item" onClick={() => onPick(scene.node)}>
                  <span class="scene-num">{index + 1}</span>
                  <span class="scene-name">{scene.caption}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
