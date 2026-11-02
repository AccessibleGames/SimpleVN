import { useEffect, useState } from "preact/hooks";
import { AUTO_SLOT, formatSaveTime, listSaves, readSave } from "./game";
import type { GameSummary, SaveState } from "./game";
import { LOCALES, NATIVE_NAMES, setLocale, t } from "./i18n";
import type { Locale } from "./i18n";

interface MenuProps {
  games: GameSummary[];
  onStart: (game: GameSummary, start: SaveState | null) => void;
  onGallery: (game: GameSummary) => void;
  onScenes: (game: GameSummary) => void;
}

export function Menu({ games, onStart, onGallery, onScenes }: MenuProps) {
  const [lang, setLang] = useState<Locale>(() => {
    try {
      const saved = window.localStorage.getItem("vn.locale");
      if (saved && (LOCALES as string[]).includes(saved)) return saved as Locale;
    } catch {
      // ignore
    }
    return LOCALES[0];
  });
  const [gameIndex, setGameIndex] = useState(() => {
    try {
      const last = window.localStorage.getItem("vn.game");
      const found = games.findIndex((entry) => entry.id === last);
      if (found >= 0) return found;
    } catch {
      // ignore
    }
    return 0;
  });
  const [saves, setSaves] = useState<{ slot: string; state: SaveState }[]>([]);
  const [showSaves, setShowSaves] = useState(false);

  setLocale(lang);
  const game = games[gameIndex] ?? games[0];

  useEffect(() => {
    if (!game) return;
    setSaves(listSaves(game.id));
    setShowSaves(false);
    // A game without a pack for the current UI language falls back to the
    // language its script is written in, instead of silently mixing two.
    if (!game.locales.includes(lang)) setLang(game.sourceLocale as Locale);
  }, [game?.id, lang]);

  useEffect(() => {
    try {
      window.localStorage.setItem("vn.locale", lang);
    } catch {
      // ignore
    }
    document.documentElement.lang = lang;
    if (game) document.title = game.title;
  }, [lang, game?.id]);

  /** Remember the game the reader actually works with, not just the menu focus. */
  function rememberGame(id: string): void {
    try {
      window.localStorage.setItem("vn.game", id);
    } catch {
      // ignore
    }
  }

  function pickGame(index: number): void {
    setGameIndex(index);
    const picked = games[index];
    if (picked) rememberGame(picked.id);
  }

  function start(state: SaveState | null): void {
    rememberGame(game.id);
    onStart(game, state);
  }

  function openGallery(): void {
    rememberGame(game.id);
    onGallery(game);
  }

  if (!game) {
    return (
      <main class="menu">
        <p>{t("menu.empty")}</p>
      </main>
    );
  }

  const auto = saves.find((entry) => entry.slot === AUTO_SLOT);
  const manual = saves.filter((entry) => entry.slot !== AUTO_SLOT);

  return (
    <main class="menu">
      <div class="menu-head">
        <h1 class="menu-title">{game.title}</h1>
        <div class="menu-lang">
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              class={`menu-lang-btn${locale === lang ? " is-active" : ""}`}
              onClick={() => setLang(locale)}
            >
              {NATIVE_NAMES[locale]}
            </button>
          ))}
        </div>
      </div>

      {games.length > 1 && (
        <div class="menu-games">
          <span class="menu-games-label">{t("menu.games")}</span>
          <div class="menu-game-list">
            {games.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                class={`menu-game${index === gameIndex ? " is-active" : ""}`}
                onClick={() => pickGame(index)}
              >
                {entry.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="menu-actions">
        <button type="button" class="menu-action" onClick={() => start(null)}>
          {t("menu.new")}
        </button>
        <button
          type="button"
          class="menu-action"
          disabled={!auto}
          onClick={() => auto && start(readSave(game.id, AUTO_SLOT))}
        >
          {t("menu.continue")}
          {auto && <span class="menu-note">{formatSaveTime(auto.state.savedAt)}</span>}
        </button>
        <button
          type="button"
          class="menu-action"
          disabled={manual.length === 0}
          onClick={() => setShowSaves((open) => !open)}
        >
          {t("menu.load")}
          <span class="menu-note">{t("menu.saves", { count: manual.length })}</span>
        </button>
        <button
          type="button"
          class="menu-action"
          disabled={!game.gallery?.length}
          onClick={() => openGallery()}
        >
          {t("menu.gallery")}
          <span class="menu-note">
            {game.gallery?.length
              ? t("menu.cgCount", { count: game.gallery.length })
              : t("menu.noAssets")}
          </span>
        </button>
        <button type="button" class="menu-action" onClick={() => onScenes(game)}>
          {t("menu.scenes")}
        </button>
      </div>

      {showSaves && manual.length > 0 && (
        <ul class="menu-saves">
          {manual.map((entry) => (
            <li key={entry.slot}>
              <button type="button" onClick={() => start(entry.state)}>
                {entry.slot} · {formatSaveTime(entry.state.savedAt)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
