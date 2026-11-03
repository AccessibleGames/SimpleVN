/** Story variables. Numbers, strings and booleans are all allowed. */
export type Vars = Record<string, number | string | boolean>;

/** A condition that must hold for a choice to be offered. */
export interface Condition {
  var: string;
  op: ">=" | "<=" | ">" | "<" | "==" | "!=";
  value: number | string | boolean;
}

/** A variable mutation: `set` assigns, `+=` / `-=` only work on numbers. */
export interface Effect {
  var: string;
  op: "set" | "+=" | "-=";
  value: number | string | boolean;
}

/** A raw script line, exactly as it appears in story.json. */
export type LineRaw =
  | string
  | { who: string; text: string }
  | { tag: string; text: string }
  | { head: string };

export interface ChoiceRaw {
  id: string;
  label: string;
  when?: Condition[];
  effects?: Effect[];
  next: string;
}

export interface NodeRaw {
  lines?: LineRaw[];
  next?: string;
  effects?: Effect[];
  /** Stage changes that happen when this page starts. */
  stage?: StageEvent[];
  /** Ren'Py-style call: run this node, then resume at `next`. */
  call?: string;
  /** Pop the call stack; ends the story when the stack is empty. */
  ret?: boolean;
  /** Section title, shown as a heading whenever it changes along the path. */
  caption?: string;
  /** Local choice: flavour only, it does not affect the ending (indented in the contents list). */
  local?: boolean;
  choices?: ChoiceRaw[];
}

/* ---------------- stage ---------------- */

/**
 * One visual change read from the script: a background swap or a tachie slot
 * being filled/cleared. Deltas are enough because the interpreter replays the
 * whole path, so the on-screen state is always derivable.
 */
export type StageEvent =
  | { k: "bg"; bmp: string; tr: string | null; ms: number }
  | { k: "bgout"; ms: number }
  | { k: "show"; slot: number; bmp: string; fade: boolean }
  | { k: "clear"; slot: number };

export interface StageState {
  bg: { bmp: string; tr: string | null; ms: number } | null;
  /** Image name per tachie slot; null means the slot is empty. */
  sprites: (string | null)[];
}

export interface Story {
  title?: string;
  start: string;
  vars: Vars;
  /** Horizontal offsets of the left/centre/right tachie slots, in design px. */
  slots?: { l: number; c: number; r: number };
  /** Display names for variables, keyed by variable name. */
  varLabels?: Record<string, string>;
  /** Section starts in script order; the scene replay list reads this. */
  scenes?: { caption: string; node: string }[];
  nodes: Record<string, NodeRaw>;
}

/* ---------------- interpreter output ---------------- */

export type LineStyle = "say" | "narration" | "tag" | "head";

export interface Line {
  kind: "line";
  style: LineStyle;
  /** Left column: speaker name or note label; null leaves it blank. */
  label: string | null;
  text: string;
  /** Position on the timeline, also used as the scroll anchor. */
  lineIndex: number;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface ChoiceBlock {
  kind: "choice";
  options: ChoiceOption[];
  /** null while the player has not picked anything. */
  pickedId: string | null;
}

export type Entry = Line | ChoiceBlock;

/** A choice that has already been made. */
export interface Point {
  depth: number;
  local: boolean;
  picked: string;
  options: string[];
  /** Line count to restore when jumping back to this choice. */
  restoreLimit: number;
}

export type Waiting =
  | { type: "line" }
  | { type: "choice"; depth: number; options: ChoiceOption[] }
  | { type: "end" };

export interface View {
  entries: Entry[];
  points: Point[];
  vars: Vars;
  lineCount: number;
  waiting: Waiting;
  /** What the stage shows after the last replayed page. */
  stage: StageState;
}

/* ---------------- UI state ---------------- */

/** A line range produced by a bulk skip: [from, to). */
export interface Mark {
  from: number;
  to: number;
}

/** A saved reading position. */
export interface Bookmark {
  id: number;
  line: number;
  /** Pixel offset from the top of the log, so the same spot is restored exactly. */
  delta: number;
  text: string;
}
