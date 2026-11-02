import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { games, loadGame } from "@games";
import { App } from "./app";
import { Gallery } from "./gallery";
import { Menu } from "./menu";
import { Scenes } from "./scenes";
import { StagePreview } from "./stage-preview";
import { t } from "./i18n";
import type { GameContent, GameSummary, SaveState } from "./game";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app container");

/**
 * Where a game's images live. In dev each game is served under /asset/<id>/;
 * a release build copies that game's public/ next to index.html instead.
 * Subdirectories are art/ (gallery CGs), bg/ (stage backgrounds) and sprites/.
 */
function assetBase(game: { id: string }): string {
  return import.meta.env.DEV ? `asset/${game.id}/` : "";
}

type Screen =
  | { kind: "menu" }
  | { kind: "player"; game: GameSummary; start: SaveState | null; from?: string; key: number }
  | { kind: "gallery"; game: GameSummary }
  | { kind: "scenes"; game: GameSummary };

/** Fetches the script and packs, then hands a fully loaded game to the reader. */
function Player({
  game,
  start,
  from,
  onExit,
}: {
  game: GameSummary;
  start: SaveState | null;
  from?: string;
  onExit: () => void;
}) {
  const [loaded, setLoaded] = useState<GameContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadGame(game.id)
      .then((content) => {
        if (!live) return;
        if (content) setLoaded(content);
        else setError(`no content for ${game.id}`);
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [game.id]);

  if (error) {
    return (
      <main class="menu">
        <p>{error}</p>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main class="menu">
        <p>{t("app.loading")}</p>
      </main>
    );
  }

  return <App game={loaded} assets={assetBase(loaded)} start={start} from={from} onExit={onExit} />;
}

function Root() {
  const [screen, setScreen] = useState<Screen>({ kind: "menu" });

  // Dev harness: ?stage renders the WebGL2 compositor directly.
  const preview = games.find((game) => game.gallery?.length);
  if (import.meta.env.DEV && window.location.search.includes("stage") && preview) {
    return <StagePreview game={preview} assets={assetBase(preview)} />;
  }

  if (screen.kind === "player") {
    return (
      <Player
        key={screen.key}
        game={screen.game}
        start={screen.start}
        from={screen.from}
        onExit={() => setScreen({ kind: "menu" })}
      />
    );
  }

  if (screen.kind === "scenes") {
    const picked = screen.game;
    return (
      <Scenes
        game={picked}
        onPick={(node) =>
          setScreen({ kind: "player", game: picked, start: null, from: node, key: Date.now() })
        }
        onExit={() => setScreen({ kind: "menu" })}
      />
    );
  }

  if (screen.kind === "gallery") {
    return (
      <Gallery
        title={screen.game.title}
        entries={screen.game.gallery ?? []}
        assets={assetBase(screen.game)}
        onExit={() => setScreen({ kind: "menu" })}
      />
    );
  }

  return (
    <Menu
      games={games}
      onStart={(game, start) => setScreen({ kind: "player", game, start, key: Date.now() })}
      onGallery={(game) => setScreen({ kind: "gallery", game })}
      onScenes={(game) => setScreen({ kind: "scenes", game })}
    />
  );
}

render(<Root />, root);
