import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { materialize, mergePacks } from "./content";
import { run } from "./engine";
import { StageView } from "./stage-view";
import { useTilt } from "./tilt";
import { AUTO_SLOT, SAVE_SLOTS, formatSaveTime, listSaves, removeSave, writeSave } from "./game";
import type { GameContent, SaveState } from "./game";
import { LOCALES, NATIVE_NAMES, initialLocale, rememberLocale, setLocale, t } from "./i18n";
import type { Locale } from "./i18n";
import type { Bookmark, ChoiceBlock, Entry, Line, Mark, Point, Story, View } from "./types";

/**
 * Overlay the chosen language on the source language. A partially translated
 * pack only has to carry the strings it actually translated.
 */
export function buildStory(game: GameContent, locale: Locale): Story {
  const source = game.packs[game.sourceLocale] ?? Object.values(game.packs)[0];
  const over = game.packs[locale];
  return materialize(game.graph, mergePacks(source, over));
}

/**
 * Speaker column width in characters. Old lines are merged into plain text and
 * padded with ideographic spaces, so the column has to be a whole number of
 * characters. 4 covers every speaker name in the scripts this was built on; the
 * few longer group labels keep no padding.
 */
const NAME_COL = 4;

/** Extra spacing on top of the base line gap, in em. */
const SPACE_MAX = 1.1;
/** Distance from the bottom that still counts as "at the bottom", in px. */
const BOTTOM_GAP = 60;
/** How many temporary jump-back bookmarks the stack keeps. */
const BOOKMARK_MAX = 3;
/** Wide layout breakpoint; must match styles.css. */
const WIDE = 900;
/** Entries kept as individual rows near the reading position. */
const LIVE_ENTRIES = 160;
/** Lines the stage mode keeps on screen: a dialogue box, not a scrollable log. */
const STAGE_LINES = 1;
/** How many old lines are merged into one DOM node. */
const CHUNK_LINES = 40;

interface UiState {
  decisions: string[];
  limit: number;
  /** Line ranges produced by a bulk skip. */
  marks: Mark[];
  /** Temporary jump-back bookmarks (a stack). */
  temp: Bookmark[];
  /** Manually added bookmarks, kept for the whole session. */
  pinned: Bookmark[];
  /** Start node when replaying one scene instead of the whole script. */
  from?: string;
}

/** A new game already shows the first line, so the page is never blank. */
const initialState: UiState = { decisions: [], limit: 1, marks: [], temp: [], pinned: [] };

let bookmarkId = 0;

function stop(fn: () => void) {
  return (e: JSX.TargetedMouseEvent<HTMLElement>) => {
    e.stopPropagation();
    fn();
  };
}

/* ---------------------------- inline markup ----------------------------- */

const MARKUP = /\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|~~([^~]+)~~/g;

/** `**bold**`, `*italic*`, `__underline__`, `~~strike~~` */
function rich(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  MARKUP.lastIndex = 0;

  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = MARKUP.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));

    const body = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (match[1] !== undefined) out.push(<strong key={key++}>{body}</strong>);
    else if (match[2] !== undefined) out.push(<em key={key++}>{body}</em>);
    else if (match[3] !== undefined) out.push(<u key={key++}>{body}</u>);
    else out.push(<s key={key++}>{body}</s>);

    last = MARKUP.lastIndex;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------------------------- merged history ---------------------------- */

/**
 * Once a line is far enough behind, its extra line spacing is gone and it looks
 * exactly like plain text. Such lines are merged into one grid container: one
 * name cell + one text cell per line, no per-row wrapper. Wrapped lines stay in
 * the text column because the cell is a grid track, not a plain text run.
 */

interface FlatBlock {
  kind: "flat";
  key: string;
  firstLine: number;
  lines: { name: string; text: string }[];
}

interface SingleBlock {
  kind: "single";
  key: string;
  entry: Entry;
}

type Block = FlatBlock | SingleBlock;

/** A run of entries that starts at a heading; the unit the log collapses by. */
interface Chapter {
  title: string;
  entries: Entry[];
}

/**
 * Split the history into chapters at heading lines.
 *
 * Everything before the first heading is its own chapter so nothing is lost.
 */
function chapterize(entries: Entry[]): Chapter[] {
  const chapters: Chapter[] = [];

  for (const entry of entries) {
    const heading = entry.kind === "line" && entry.style === "head" ? entry.text : null;
    if (chapters.length === 0 || heading !== null) {
      chapters.push({ title: heading ?? "", entries: [] });
    }
    chapters[chapters.length - 1].entries.push(entry);
  }

  return chapters;
}

function buildBlocks(entries: Entry[], live: number): Block[] {
  const split = Math.max(0, entries.length - live);
  const blocks: Block[] = [];
  let chunk: FlatBlock | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const mergeable = i < split && entry.kind === "line" && entry.style !== "head";

    if (!mergeable) {
      chunk = null;
      blocks.push({ kind: "single", key: `e${i}`, entry });
      continue;
    }

    if (!chunk || chunk.lines.length >= CHUNK_LINES) {
      chunk = { kind: "flat", key: `f${entry.lineIndex}`, firstLine: entry.lineIndex, lines: [] };
      blocks.push(chunk);
    }
    chunk.lines.push({ name: entry.label ?? "", text: entry.text.replace(/\n/g, " ") });
  }

  return blocks;
}

/** The text cell of a merged line, used for scrolling and anchors. */
function chunkCells(chunk: HTMLElement): HTMLElement[] {
  return Array.from(chunk.querySelectorAll<HTMLElement>(":scope > .txt"));
}

/** Which merged line sits at `clientY`, and where it is on screen. */
function chunkLineAt(chunk: HTMLElement, clientY: number): { index: number; top: number } | null {
  const cells = chunkCells(chunk);
  if (cells.length === 0) return null;

  let index = 0;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.bottom > clientY) return { index, top: rect.top };
    index++;
  }

  const last = cells[cells.length - 1];
  return { index: cells.length - 1, top: last.getBoundingClientRect().top };
}

/* ---------------------------- line spacing ------------------------------ */

/**
 * Line spacing is derived from the distance to the bottom of the log, not
 * from the age of a line:
 *   - content still fits in one screen -> give every line the full spacing
 *   - content overflows                -> fade the spacing out over one screen
 * Measurements always happen with the plain spacing applied, so the result
 * is stable and a window resize just re-distributes it.
 */
function applySpacing(log: HTMLElement, marks: Mark[], fill: boolean): void {
  const rows = Array.from(log.querySelectorAll<HTMLElement>(".row"));
  if (rows.length === 0) return;

  for (const row of rows) row.style.marginTop = "";
  // The stage box hugs its lines, so there is no room to distribute.
  if (!fill) return;

  const style = getComputedStyle(log);
  const viewHeight = log.clientHeight;
  const room = viewHeight - log.scrollHeight; // > 0 means the content still fits
  const maxPx = SPACE_MAX * (parseFloat(style.fontSize) || 15);

  const isBulk = (line: number) => marks.some((m) => line >= m.from && line < m.to);
  const targets = rows.filter((row, i) => i > 0 && !isBulk(Number(row.dataset.line)));

  if (room > 0) {
    const per = Math.min(room / Math.max(1, targets.length), maxPx);
    for (const row of targets) row.style.marginTop = `${per.toFixed(2)}px`;
    return;
  }

  const last = rows[rows.length - 1];
  const lastBottom = last.offsetTop + last.offsetHeight;

  for (const row of targets) {
    const bottom = row.offsetTop + row.offsetHeight;
    const t01 = Math.min(Math.max((lastBottom - bottom) / viewHeight, 0), 1);
    const extra = maxPx * (1 - t01) * (1 - t01);
    row.style.marginTop = extra > 0.5 ? `${extra.toFixed(2)}px` : "";
  }
}

/* ---------------------------- reading anchors --------------------------- */

/** Line currently at the top of the viewport, plus its pixel offset. */
function currentAnchor(log: HTMLElement): Bookmark | null {
  const box = log.getBoundingClientRect();
  const items = log.querySelectorAll<HTMLElement>("[data-line]");
  if (items.length === 0) return null;

  let row = items[items.length - 1];
  for (const item of items) {
    if (item.getBoundingClientRect().bottom > box.top + 6) {
      row = item;
      break;
    }
  }

  let line = Number(row.dataset.line);
  let top = row.getBoundingClientRect().top;
  let text = (row.textContent ?? "").trim();

  if (row.classList.contains("flat")) {
    const hit = chunkLineAt(row, box.top + 10);
    if (hit) {
      line += hit.index;
      top = hit.top;
      const cells = chunkCells(row);
      text = (cells[hit.index]?.textContent ?? text).trim();
    }
  }

  return { id: ++bookmarkId, line, delta: Math.round(top - box.top), text };
}

function scrollToAnchor(log: HTMLElement, anchor: Bookmark): boolean {
  const logBox = log.getBoundingClientRect();
  const row = log.querySelector<HTMLElement>(`[data-line="${anchor.line}"]`);

  if (row && !row.classList.contains("flat")) {
    log.scrollTop += row.getBoundingClientRect().top - logBox.top - anchor.delta;
    return true;
  }

  // The line lives inside a merged block: find its position in the text.
  for (const chunk of log.querySelectorAll<HTMLElement>(".flat")) {
    const first = Number(chunk.dataset.line);
    const count = Number(chunk.dataset.count);
    if (!(anchor.line >= first && anchor.line < first + count)) continue;

    const cell = chunkCells(chunk)[anchor.line - first];
    if (!cell) continue;

    log.scrollTop += cell.getBoundingClientRect().top - logBox.top - anchor.delta;
    return true;
  }

  return false;
}

/* ---------------------------- components -------------------------------- */

function Row({ line }: { line: Line }) {
  if (line.style === "head") {
    return (
      <div class="row--head" data-line={line.lineIndex}>
        {rich(line.text)}
      </div>
    );
  }

  return (
    <div class={`row row--${line.style}`} data-line={line.lineIndex}>
      <span class="who">{line.label ?? ""}</span>
      <span class="txt">{rich(line.text)}</span>
    </div>
  );
}

function Choices({ block, onPick }: { block: ChoiceBlock; onPick: (id: string) => void }) {
  const pending = block.pickedId === null;

  return (
    <ul class="choices">
      {block.options.map((option) => {
        const picked = !pending && option.id === block.pickedId;
        const className =
          "choice " + (pending ? "choice--pending" : "choice--record") + (picked ? " is-picked" : "");

        return (
          <li key={option.id}>
            <button
              type="button"
              class={className}
              tabIndex={pending ? undefined : -1}
              aria-disabled={pending ? undefined : true}
              onClick={(e) => {
                e.stopPropagation();
                if (pending) onPick(option.id);
              }}
            >
              <span class="caret">{">"}</span>
              <span class="label">{option.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type TocItem =
  | { kind: "choice"; point: Point }
  | { kind: "mark"; mark: Mark }
  | { kind: "temp"; mark: Bookmark }
  | { kind: "pinned"; mark: Bookmark };

interface TocProps {
  view: View;
  state: UiState;
  onJumpDepth: (depth: number) => void;
  onScrollMark: (from: number) => void;
  onUseTemp: (id: number) => void;
  onJumpPinned: (mark: Bookmark) => void;
  onRemovePinned: (id: number) => void;
}

function Toc(props: TocProps) {
  const groups: TocItem[][] = [
    props.view.points.map((point): TocItem => ({ kind: "choice", point })),
    props.state.marks.map((mark): TocItem => ({ kind: "mark", mark })),
    props.state.temp.map((mark): TocItem => ({ kind: "temp", mark })),
    props.state.pinned.map((mark): TocItem => ({ kind: "pinned", mark })),
  ].filter((group) => group.length > 0);

  const items = groups.flatMap((group, groupIndex) =>
    group.map((item, i) => ({ item, gap: groupIndex > 0 && i === 0 })),
  );

  if (items.length === 0) {
    return (
      <ol class="toc-list">
        <li>{t("contents.empty")}</li>
      </ol>
    );
  }

  return (
    <ol class="toc-list">
      {items.map(({ item, gap }) => {
        const gapClass = gap ? "toc-gap" : "";

        if (item.kind === "choice") {
          const point = item.point;
          return (
            <li key={`choice-${point.depth}`} class={gapClass}>
              <button
                type="button"
                class={`toc-btn${point.local ? " toc-btn--local" : ""}`}
                title={t("contents.jumpChoice")}
                onClick={() => props.onJumpDepth(point.depth)}
              >
                <span class="n">{point.depth + 1}</span>
                {point.picked}
                <span class="toc-alt">
                  {t("contents.otherOptions", {
                    options: point.options.filter((option) => option !== point.picked).join(" / "),
                  })}
                </span>
              </button>
            </li>
          );
        }

        if (item.kind === "mark") {
          const { from, to } = item.mark;
          const label =
            from + 1 === to
              ? t("contents.line", { line: from + 1 })
              : t("contents.lineRange", { from: from + 1, to });

          return (
            <li key={`mark-${from}`} class={gapClass}>
              <button
                type="button"
                class="toc-btn toc-btn--jump"
                title={t("contents.jumpSkipped")}
                onClick={() => props.onScrollMark(from)}
              >
                <span class="n">↓</span>
                {t("contents.skipped", { label })}
              </button>
            </li>
          );
        }

        if (item.kind === "temp") {
          const mark = item.mark;
          return (
            <li key={`temp-${mark.id}`} class={gapClass}>
              <button
                type="button"
                class="toc-btn toc-btn--jump"
                title={t("contents.jumpPosition")}
                onClick={() => props.onUseTemp(mark.id)}
              >
                <span class="n">←</span>
                {t("contents.line", { line: mark.line + 1 })}
                <span class="toc-snippet">{mark.text}</span>
              </button>
            </li>
          );
        }

        const mark = item.mark;
        return (
          <li key={`pinned-${mark.id}`} class={`toc-item--pinned ${gapClass}`.trim()}>
            <button
              type="button"
              class="toc-btn toc-btn--jump"
              title={t("contents.jumpBookmark")}
              onClick={() => props.onJumpPinned(mark)}
            >
              <span class="n">★</span>
              {t("contents.line", { line: mark.line + 1 })}
              <span class="toc-snippet">{mark.text}</span>
            </button>
            <button
              type="button"
              class="toc-del"
              title={t("contents.removeBookmark")}
              aria-label={t("contents.removeBookmark")}
              onClick={() => props.onRemovePinned(mark.id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ol>
  );
}

interface StatusProps {
  view: View;
  labels: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  language: string;
  mode: "novel" | "galgame";
  canSwitchMode: boolean;
  onToggleMode: () => void;
  auto: boolean;
  onToggleAuto: () => void;
  onSwitchLanguage: () => void;
  onExit: () => void;
}

function StatusBar({
  view,
  labels,
  open,
  onToggle,
  language,
  mode,
  canSwitchMode,
  onToggleMode,
  auto,
  onToggleAuto,
  onSwitchLanguage,
  onExit,
}: StatusProps) {
  const entries = Object.entries(view.vars);
  const separator = t("status.separator");
  const summary = entries.length
    ? entries.map(([key, value]) => `${labels[key] ?? key} ${String(value)}`).join(separator)
    : t("status.none");

  const rows: ComponentChildren[] = [];
  for (const [key, value] of entries) {
    rows.push(<dt key={`${key}:k`}>{labels[key] ?? key}</dt>);
    rows.push(<dd key={`${key}:v`}>{String(value)}</dd>);
  }
  rows.push(<dt key="__lines:k">{t("status.lines")}</dt>);
  rows.push(<dd key="__lines:v">{view.lineCount}</dd>);
  rows.push(<dt key="__choices:k">{t("status.choices")}</dt>);
  rows.push(<dd key="__choices:v">{t("status.times", { count: view.points.length })}</dd>);

  return (
    <footer class="status">
      {open && (
        <div class="status-panel">
          <dl class="status-list">{rows}</dl>
        </div>
      )}
      <button class="status-bar" type="button" aria-expanded={open} onClick={stop(onToggle)}>
        <span class="status-label">{t("status.label")}</span>
        <span class="status-sum">{summary}</span>
        <span class="status-arrow">{open ? "▾" : "▴"}</span>
      </button>
      {canSwitchMode && (
        <button class="lang" type="button" title={t("mode.switch")} onClick={stop(onToggleMode)}>
          {/* Names the mode the click goes to, not the one it leaves. */}
          {mode === "galgame" ? t("mode.novel") : t("mode.galgame")}
        </button>
      )}
      <button
        class={`lang${auto ? " is-on" : ""}`}
        type="button"
        title={t("auto.hint")}
        onClick={stop(onToggleAuto)}
      >
        {t("auto.label")}
      </button>
      <button
        class="lang"
        type="button"
        title={t("lang.switch")}
        aria-label={t("lang.switch")}
        onClick={stop(onSwitchLanguage)}
      >
        {language}
      </button>
      <button class="lang" type="button" title={t("app.title")} onClick={stop(onExit)}>
        {t("status.exit")}
      </button>
    </footer>
  );
}

/* ---------------------------- main component ---------------------------- */

export function App({
  game,
  assets,
  start,
  from,
  onExit,
}: {
  game: GameContent;
  /** Base path for art/, bg/ and sprites/. */
  assets: string;
  start: SaveState | null;
  /** Replay this node as the beginning of the session (scene replay). */
  from?: string;
  onExit: () => void;
}) {
  const [state, setState] = useState<UiState>(() =>
    start
      ? {
          decisions: start.decisions,
          limit: start.limit,
          marks: start.marks,
          temp: start.temp,
          pinned: start.pinned,
          from: start.from,
        }
      : { ...initialState, from },
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saves, setSaves] = useState<{ slot: string; state: SaveState }[]>([]);
  /** Chapters the reader opened by hand; all others stay unmounted. */
  const [openChapters, setOpenChapters] = useState<Set<number>>(() => new Set());
  /** A jump that had to mount a folded chapter first. */
  const pendingScroll = useRef<Bookmark | null>(null);
  /** Auto-read: advance on a timer sized to the line being read. */
  const [auto, setAuto] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [showToBottom, setShowToBottom] = useState(false);
  const [mode, setMode] = useState<"novel" | "galgame">(() => {
    try {
      return window.localStorage.getItem("vn.mode") === "galgame" ? "galgame" : "novel";
    } catch {
      return "novel";
    }
  });
  const [lang, setLang] = useState<Locale>(initialLocale);
  /** Measured once the stage mounts; drives both the tilt range and its clamp. */
  const [panRoom, setPanRoom] = useState({ x: 0, y: 0 });
  const onPanRoom = useCallback((room: { x: number; y: number }) => {
    setPanRoom((current) =>
      Math.abs(current.x - room.x) < 0.5 && Math.abs(current.y - room.y) < 0.5 ? current : room,
    );
  }, []);

  const tilt = useTilt(mode === "galgame", panRoom);

  // A game without stage art would show a black rectangle, so the switch only
  // exists where the assets do.
  const hasStageArt = (game.bg?.length ?? 0) > 0 || (game.gallery?.length ?? 0) > 0;
  const showStage = mode === "galgame" && hasStageArt;
  const showStageRef = useRef(showStage);
  showStageRef.current = showStage;

  // iOS hands over orientation events only during a gesture, and the saved mode
  // can land here without one, so the first touch anywhere arms the camera.
  useEffect(() => {
    if (!showStage || !tilt.supported) return;
    const arm = () => void tilt.enable();
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, [showStage, tilt.supported, tilt.enable]);

  useEffect(() => {
    try {
      window.localStorage.setItem("vn.mode", mode);
    } catch {
      // ignore
    }
  }, [mode]);

  // The active message catalog follows this render; `t()` reads it directly.
  setLocale(lang);
  const story = useMemo(() => buildStory(game, lang), [game, lang]);

  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // whether the view follows the bottom
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Synchronous state commit. Preact batches renders, so reading `state` from
   * a closure would be stale when several actions fire before the next render
   * (fast clicking, key repeat). Reading stateRef keeps every action exact.
   */
  function commit(update: (s: UiState) => UiState) {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }

  /** Fresh view of the latest committed state. */
  function viewOf(s: UiState, limit = s.limit): View {
    return run(story, s.decisions, limit, s.from);
  }

  function currentView(s: UiState = stateRef.current): View {
    return viewOf(s);
  }

  const view = useMemo(
    () => run(story, state.decisions, state.limit, state.from),
    [story, state.decisions, state.limit, state.from],
  );
  const waiting = view.waiting;

  /**
   * What goes into the DOM: the reading tail stays as one row per line (it is
   * where spacing varies), everything older is merged into text blocks.
   */
  const blocks = buildBlocks(
    showStage ? view.entries.slice(-STAGE_LINES) : view.entries,
    showStage ? STAGE_LINES : LIVE_ENTRIES,
  );

  /** Chapter boundaries over the whole history; folded ones are not mounted. */
  const chapters = useMemo(() => chapterize(view.entries), [view.entries]);

  /** Name to file for the stage, when a manifest knows better than the name. */
  const stagePaths = useMemo(() => {
    const index = (list?: { id: string; full: string }[]) => {
      if (!list?.length) return undefined;
      const map: Record<string, string> = {};
      for (const entry of list) map[entry.id] = entry.full;
      return map;
    };
    return { bg: index(game.bg), sprites: index(game.sprites) };
  }, [game.bg, game.sprites]);

  /* ---------- actions ---------- */

  function nextLine() {
    commit((s) => {
      const current = currentView(s);
      if (current.waiting.type !== "line") return s;
      return { ...s, limit: current.lineCount + 1 };
    });
  }

  /** Step back one printed line; the view is a replay, so this is a shorter budget. */
  function backLine() {
    commit((s) => {
      const current = currentView(s);
      if (current.waiting.type !== "line" || current.lineCount <= 1) return s;
      return { ...s, limit: current.lineCount - 1 };
    });
  }

  /**
   * Print everything up to the next choice: do not scroll to the bottom, mark
   * the printed range for the contents list, and keep its spacing compact.
   */
  function skipToChoice() {
    commit((s) => {
      const current = currentView(s);
      if (current.waiting.type !== "line") return s;

      const from = current.lineCount;
      const to = viewOf(s, Infinity).lineCount;
      if (to <= from) return s;

      stickRef.current = false;
      return { ...s, limit: to, marks: [...s.marks, { from, to }] };
    });
  }

  function pick(id: string) {
    commit((s) => {
      const current = currentView(s);
      if (current.waiting.type !== "choice") return s;

      const depth = current.waiting.depth;
      return {
        ...s,
        decisions: [...s.decisions.slice(0, depth), id],
        limit: current.lineCount + 1,
      };
    });
  }

  function jumpToDepth(depth: number) {
    const point = currentView().points.find((p) => p.depth === depth);
    if (!point) return;
    const limit = point.restoreLimit;

    stickRef.current = true; // stick to the bottom so the restored choice is visible
    setSheetOpen(false);

    commit((s) => ({
      ...s,
      decisions: s.decisions.slice(0, depth),
      limit,
      marks: s.marks.filter((m) => m.to <= limit),
      temp: s.temp.filter((b) => b.line < limit),
      pinned: s.pinned.filter((b) => b.line < limit),
    }));
  }

  /** Jump to the latest line; keep the current position as a temporary bookmark. */
  function toBottom() {
    const log = logRef.current;
    if (!log) return;

    const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
    const anchor = gap >= BOTTOM_GAP ? currentAnchor(log) : null;

    stickRef.current = true;
    commit((s) => {
      if (!anchor || s.temp.some((b) => b.line === anchor.line)) return { ...s };
      return { ...s, temp: [...s.temp, anchor].slice(-BOOKMARK_MAX) };
    });
  }

  function useTempBookmark(id: number) {
    const mark = stateRef.current.temp.find((b) => b.id === id);
    if (!mark) return;

    stickRef.current = false;
    commit((s) => ({ ...s, temp: s.temp.filter((b) => b.id !== id) })); // popped once used
    revealAndScroll(mark);
    setSheetOpen(false);
  }

  function scrollToMark(from: number) {
    const log = logRef.current;
    if (!log) return;
    revealAndScroll({ id: -1, line: from, delta: 4, text: "" });
    setSheetOpen(false);
  }

  /**
   * Jumping into a folded chapter means mounting it first. The scroll happens in
   * a layout effect, once the rows that the anchor points at exist.
   */
  function revealAndScroll(anchor: Bookmark) {
    const index = chapterIndexOfLine(anchor.line);
    const current = index === chapters.length - 1;

    if (current || openChapters.has(index)) {
      const log = logRef.current;
      if (log && scrollToAnchor(log, anchor)) stickRef.current = false;
      return;
    }

    setOpenChapters((prev) => new Set(prev).add(index));
    pendingScroll.current = anchor;
    stickRef.current = false;
  }

  function chapterIndexOfLine(line: number): number {
    for (let index = chapters.length - 1; index >= 0; index--) {
      const first = chapters[index].entries[0];
      const start = first && first.kind === "line" ? first.lineIndex : 0;
      if (line >= start) return index;
    }
    return 0;
  }

  /** Swap between the plain log and the stage. */
  function toggleMode() {
    setMode((current) => (current === "galgame" ? "novel" : "galgame"));
  }

  /** Sections are the only natural chapter marker the imported scripts carry. */
  function currentCaption(): string | undefined {
    for (let i = view.entries.length - 1; i >= 0; i--) {
      const entry = view.entries[i];
      if (entry.kind === "line" && entry.style === "head") return entry.text;
    }
    return undefined;
  }

  function saveTo(slot: string) {
    const current = stateRef.current;
    writeSave(game.id, slot, {
      decisions: current.decisions,
      limit: current.limit,
      marks: current.marks,
      temp: current.temp,
      pinned: current.pinned,
      caption: currentCaption(),
      from: current.from,
      savedAt: Date.now(),
    });
    setSaves(listSaves(game.id));
  }

  function deleteSlot(slot: string) {
    removeSave(game.id, slot);
    setSaves(listSaves(game.id));
  }

  function addPinnedBookmark() {
    const log = logRef.current;
    if (!log) return;

    const anchor = currentAnchor(log);
    if (!anchor) return;

    commit((s) => ({ ...s, pinned: [...s.pinned, anchor] }));
    if (window.innerWidth < WIDE) setSheetOpen(true); // give feedback on narrow screens
  }

  function jumpToPinned(mark: Bookmark) {
    revealAndScroll(mark);
    setSheetOpen(false);
  }

  function removePinned(id: number) {
    commit((s) => ({ ...s, pinned: s.pinned.filter((b) => b.id !== id) }));
  }

  /** Cycle through the interface languages; the text follows when it can. */
  function switchLanguage() {
    const index = LOCALES.indexOf(lang);
    const next = LOCALES[(index + 1) % LOCALES.length];
    rememberLocale(next);
    setLang(next);
  }

  /* ---------- layout and scrolling after every render ---------- */

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;

    applySpacing(log, stateRef.current.marks, !showStage);
    if (stickRef.current) log.scrollTop = log.scrollHeight;

    const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
    stickRef.current = gap < BOTTOM_GAP;
    setShowToBottom(gap >= BOTTOM_GAP);
  });

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
        stickRef.current = gap < BOTTOM_GAP;
        setShowToBottom(gap >= BOTTOM_GAP);
      });
    };

    log.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      log.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingScroll.current;
    const log = logRef.current;
    if (!anchor || !log) return;
    if (scrollToAnchor(log, anchor)) pendingScroll.current = null;
  });

  useEffect(() => {
    const onResize = () => {
      const log = logRef.current;
      if (!log) return;

      applySpacing(log, stateRef.current.marks, !showStageRef.current);
      if (stickRef.current) log.scrollTop = log.scrollHeight;
      setSheetOpen((open) => (window.innerWidth >= WIDE ? false : open));
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = game.title ?? t("app.title");
  }, [lang, game]);

  /** Autosave: the menu's "continue" entry restores this snapshot. */
  useEffect(() => {
    // A scene replay is detached viewing, not progress; writing it would move
    // the reader's real position in the story.
    if (state.from) return;
    const handle = window.setTimeout(() => {
      writeSave(game.id, AUTO_SLOT, { ...state, savedAt: Date.now() });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [state, game.id]);

  /**
   * Auto-read advances on a timer sized to the line, and stops at a choice: the
   * reader has to decide there, and guessing would silently pick an ending.
   */
  useEffect(() => {
    if (!auto || waiting.type !== "line") return;
    const last = view.entries[view.entries.length - 1];
    const text = last && last.kind === "line" ? last.text : "";
    const delay = Math.min(9000, 1200 + text.length * 60);
    const timer = window.setTimeout(() => nextLine(), delay);
    return () => window.clearTimeout(timer);
  }, [auto, waiting.type, view.lineCount]);

  /* ---------- keyboard ---------- */

  const actionsRef = useRef({ nextLine, skipToChoice, backLine });
  actionsRef.current = { nextLine, skipToChoice, backLine };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSheetOpen(false);
        setStatusOpen(false);
        return;
      }

      const active = document.activeElement;
      if (active instanceof HTMLElement && active.tagName === "BUTTON") return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        actionsRef.current.skipToChoice();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        actionsRef.current.backLine();
        return;
      }
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        actionsRef.current.nextLine();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- clicking the log advances; wheel and swipes only scroll ---------- */

  const selectedRef = useRef(false);
  const ignoreClickRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const touchRef = useRef<{ x: number; y: number; time: number } | null>(null);

  function onStageClick(e: JSX.TargetedMouseEvent<HTMLElement>) {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false;
      return;
    }
    if (selectedRef.current) {
      selectedRef.current = false;
      return;
    }

    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    if (target.closest(".status")) return;
    nextLine();
  }

  function onStageMouseDown(e: JSX.TargetedMouseEvent<HTMLElement>) {
    pressRef.current = { x: e.clientX, y: e.clientY };
  }

  /**
   * Only a real drag counts as "the reader is selecting text". A double or
   * triple click also leaves a selection behind, and treating that as a drag
   * silently ate the click, which broke fast repeated clicking.
   */
  function onStageMouseUp(e: JSX.TargetedMouseEvent<HTMLElement>) {
    const press = pressRef.current;
    pressRef.current = null;

    const selection = window.getSelection();
    const hasSelection = !!(selection && !selection.isCollapsed && String(selection).length > 0);
    const dragged = !press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8;
    selectedRef.current = hasSelection && dragged;
  }

  function onLogTouchStart(e: JSX.TargetedTouchEvent<HTMLDivElement>) {
    const touch = e.touches[0];
    touchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }

  function onLogTouchEnd(e: JSX.TargetedTouchEvent<HTMLDivElement>) {
    const origin = touchRef.current;
    if (!origin) return;

    const touch = e.changedTouches[0];
    const moved = Math.abs(touch.clientX - origin.x) > 12 || Math.abs(touch.clientY - origin.y) > 12;
    const longPress = Date.now() - origin.time > 800;
    touchRef.current = null;

    if (moved || longPress) {
      ignoreClickRef.current = true;
      setTimeout(() => {
        ignoreClickRef.current = false;
      }, 350);
    }
  }

  /* ---------- output ---------- */

  /** One rendered block; shared by the current chapter and any opened one. */
  function renderBlock(block: Block) {
    if (block.kind === "flat") {
      return (
        <div key={block.key} class="flat" data-line={block.firstLine} data-count={block.lines.length}>
          {block.lines.flatMap((line, i) => [
            <span key={`w${i}`} class="who">
              {line.name}
            </span>,
            <span key={`t${i}`} class="txt">
              {line.text}
            </span>,
          ])}
        </div>
      );
    }
    return block.entry.kind === "line" ? (
      <Row key={block.key} line={block.entry} />
    ) : (
      <Choices key={block.key} block={block.entry} onPick={pick} />
    );
  }

  /**
   * The log in novel mode: the current chapter is live, older chapters collapse
   * into one row each and are not mounted until opened. A long session otherwise
   * keeps thousands of rows in the document for no benefit.
   */
  function renderChapters() {
    return chapters.map((chapter, index) => {
      const current = index === chapters.length - 1;
      const expanded = current || openChapters.has(index);
      const title = chapter.title || t("fold.untitled");
      const count = t("fold.lines", { count: chapter.entries.length });

      if (!expanded) {
        return (
          <button
            key={`fold${index}`}
            class="fold"
            type="button"
            onClick={stop(() => setOpenChapters((prev) => new Set(prev).add(index)))}
          >
            <span class="fold-mark">▸</span>
            <span class="fold-text">{title}</span>
            <span class="fold-count">{count}</span>
          </button>
        );
      }

      // An opened older chapter shows its heading as the fold row; the chapter
      // being read has no fold row, so its heading is printed like any other.
      const body = current || !chapter.title ? chapter.entries : chapter.entries.slice(1);
      const live = current ? LIVE_ENTRIES : Math.min(LIVE_ENTRIES, body.length);

      return (
        <section key={`chapter${index}`} class="chapter">
          {!current && (
            <button
              class="fold is-open"
              type="button"
              onClick={stop(() =>
                setOpenChapters((prev) => {
                  const next = new Set(prev);
                  next.delete(index);
                  return next;
                }),
              )}
            >
              <span class="fold-mark">▾</span>
              <span class="fold-text">{title}</span>
              <span class="fold-count">{count}</span>
            </button>
          )}
          {buildBlocks(body, live).map(renderBlock)}
        </section>
      );
    });
  }

  const tocProps = {
    view,
    state,
    onJumpDepth: jumpToDepth,
    onScrollMark: scrollToMark,
    onUseTemp: useTempBookmark,
    onJumpPinned: jumpToPinned,
    onRemovePinned: removePinned,
  };

  return (
    <div class={`app app--${showStage ? "galgame" : "novel"}`} style={{ "--name-col": `${NAME_COL}em` }}>
      {showStage && (
        <StageView
          assets={assets}
          design={game.design}
          paths={stagePaths}
          stage={view.stage}
          slots={story.slots}
          offset={tilt.offset}
          enabled={tilt.supported}
          onClick={() => actionsRef.current.nextLine()}
          onRecenter={tilt.recenter}
          onPanRoom={onPanRoom}
        />
      )}
      <div class="stage-head">
        <span class="title">{story.title ?? t("app.title")}</span>
          <span class="head-right">
            {showStage && (
              <button class="btn-text" type="button" onClick={stop(toggleMode)}>
                {t("mode.novel")}
              </button>
            )}
            {waiting.type === "line" && (
              <button class="btn-text" type="button" onClick={stop(skipToChoice)}>
                {t("head.skip")}
              </button>
            )}
            <button class="btn-text" type="button" onClick={stop(addPinnedBookmark)}>
              {t("head.bookmark")}
            </button>
            <button
              class="btn-text"
              type="button"
              onClick={stop(() => {
                setSaves(listSaves(game.id));
                setSaveOpen(true);
              })}
            >
              {t("head.save")}
            </button>
            <button
              class="btn-text toc-toggle"
              type="button"
              onClick={stop(() => setSheetOpen(true))}
            >
              {t("head.contents")}
            </button>
          </span>
      </div>

      <main
        class={`stage${waiting.type === "line" ? "" : " is-choosing"}`}
        onClick={onStageClick}
        onMouseDown={onStageMouseDown}
        onMouseUp={onStageMouseUp}
      >
        <div class="log" ref={logRef} onTouchStart={onLogTouchStart} onTouchEnd={onLogTouchEnd}>
          {showStage ? blocks.map(renderBlock) : renderChapters()}
        </div>

        {showToBottom && (
          <button
            class="to-bottom"
            type="button"
            aria-label={t("a11y.toLatest")}
            onClick={stop(toBottom)}
          >
            ↓
          </button>
        )}
      </main>

      <StatusBar
        view={view}
        labels={story.varLabels ?? {}}
        open={statusOpen}
        onToggle={() => setStatusOpen((open) => !open)}
        language={NATIVE_NAMES[lang]}
        mode={showStage ? "galgame" : "novel"}
        canSwitchMode={hasStageArt}
        auto={auto}
        onToggleAuto={() => setAuto((value) => !value)}
        onToggleMode={() => {
          // iOS needs a gesture before it will hand over orientation events.
          void tilt.enable();
          toggleMode();
        }}
        onSwitchLanguage={switchLanguage}
        onExit={onExit}
      />

      <aside class="toc-panel">
        <p class="toc-head">{t("contents.title")}</p>
        <p class="toc-note">{t("contents.hint")}</p>
        <Toc {...tocProps} />
      </aside>

      {sheetOpen && (
        <div
          class="sheet"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div class="card" role="dialog" aria-label={t("a11y.contents")}>
            <div class="card-head">
              <span class="h">{t("contents.title")}</span>
              <button class="btn-text" type="button" onClick={stop(() => setSheetOpen(false))}>
                {t("contents.close")}
              </button>
            </div>
            <div class="card-body">
              <p class="toc-note">{t("contents.hint")}</p>
              <Toc {...tocProps} />
            </div>
          </div>
        </div>
      )}

      {saveOpen && (
        <div
          class="sheet"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSaveOpen(false);
          }}
        >
          <div class="card" role="dialog" aria-label={t("head.save")}>
            <div class="card-head">
              <span class="h">{t("head.save")}</span>
              <button class="btn-text" type="button" onClick={stop(() => setSaveOpen(false))}>
                {t("contents.close")}
              </button>
            </div>
            <div class="card-body">
              <p class="toc-note">{t("save.hint")}</p>
              <ul class="save-list">
                {SAVE_SLOTS.map((slot) => {
                  const saved = saves.find((entry) => entry.slot === slot);
                  return (
                    <li key={slot}>
                      <button type="button" class="save-slot" onClick={stop(() => saveTo(slot))}>
                        <span class="save-num">{slot}</span>
                        <span class="save-when">
                          {saved ? formatSaveTime(saved.state.savedAt) : t("save.empty")}
                        </span>
                        {saved?.state.caption && <span class="save-cap">{saved.state.caption}</span>}
                      </button>
                      {saved && (
                        <button
                          type="button"
                          class="btn-text save-del"
                          aria-label={t("save.delete")}
                          onClick={stop(() => deleteSlot(slot))}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
