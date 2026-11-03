/**
 * Story engine: replays a script into a list of printable entries.
 */

import type {
  ChoiceOption,
  Condition,
  Effect,
  Entry,
  Line,
  LineRaw,
  NodeRaw,
  Point,
  StageEvent,
  StageState,
  Story,
  Vars,
  View,
  Waiting,
} from "./types";

/** Replace `{variable}` placeholders with their current value. */
export function fillTemplate(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

function testCondition(cond: Condition, vars: Vars): boolean {
  const left = vars[cond.var];
  const right = cond.value;

  switch (cond.op) {
    case ">=":
      return Number(left) >= Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case "==":
      return left === right;
    case "!=":
      return left !== right;
  }
}

function conditionsPass(list: Condition[] | undefined, vars: Vars): boolean {
  if (!list) return true;
  return list.every((cond) => testCondition(cond, vars));
}

function applyEffects(vars: Vars, effects: Effect[] | undefined): void {
  if (!effects) return;

  for (const effect of effects) {
    if (effect.op === "set") {
      vars[effect.var] = effect.value;
      continue;
    }
    const current = Number(vars[effect.var] ?? 0);
    const delta = Number(effect.value);
    vars[effect.var] = effect.op === "+=" ? current + delta : current - delta;
  }
}

export function normalizeLine(raw: LineRaw, vars: Vars): Omit<Line, "kind" | "lineIndex"> {
  if (typeof raw === "string") {
    return { style: "narration", label: null, text: fillTemplate(raw, vars) };
  }
  if ("head" in raw) {
    return { style: "head", label: null, text: fillTemplate(raw.head, vars) };
  }
  if ("tag" in raw) {
    return { style: "tag", label: raw.tag, text: fillTemplate(raw.text, vars) };
  }
  return {
    style: "say",
    label: raw.who ? fillTemplate(raw.who, vars) : null,
    text: fillTemplate(raw.text, vars),
  };
}

/** Two tachie slots plus the left/centre/right positions the script declares. */
const SLOT_COUNT = 4;

function emptyStage(): StageState {
  return { bg: null, sprites: new Array(SLOT_COUNT).fill(null) };
}

function applyStage(state: StageState, events: StageEvent[] | undefined): void {
  if (!events) return;

  for (const event of events) {
    if (event.k === "bg") {
      state.bg = { bmp: event.bmp, tr: event.tr, ms: event.ms };
    } else if (event.k === "bgout") {
      state.bg = null;
    } else if (event.k === "show") {
      // The script moves a character by placing the same tachie at another
      // position without clearing the old one (a [FAID_OUT] only blanks the
      // whole screen), so the old slot has to give way or the character is
      // drawn twice. The image name carries the character: z_t001c -> z.
      const who = characterOf(event.bmp);
      for (let slot = 0; slot < state.sprites.length; slot++) {
        const current = state.sprites[slot];
        if (slot !== event.slot && current && characterOf(current) === who) {
          state.sprites[slot] = null;
        }
      }
      state.sprites[event.slot] = event.bmp;
    } else {
      state.sprites[event.slot] = null;
    }
  }
}

/** Tachie images are named <character>_t<pose><variant>; see lock/background.md. */
function characterOf(bmp: string): string {
  const cut = bmp.indexOf("_t");
  return cut > 0 ? bmp.slice(0, cut) : bmp;
}

/**
 * Pure interpreter: replay the script from the start for a given list of
 * decisions and a line budget.
 *
 * Nothing outside the arguments is touched, which is why rolling back
 * variables needs no snapshots: truncate `decisions` and replay.
 */
export function run(story: Story, decisions: string[], lineLimit = Infinity, from?: string): View {
  const vars: Vars = { ...story.vars };
  const entries: Entry[] = [];
  const points: Point[] = [];
  const stage = emptyStage();

  let nodeId: string | undefined = from && story.nodes[from] ? from : story.start;
  let depth = 0; // decisions consumed so far
  let lineCount = 0;
  let currentCaption: string | null = null;
  /** Return addresses for Ren'Py-style calls; replay rebuilds it every time. */
  const returns: string[] = [];
  // A hub that calls the same map over and over is legitimate, so loops are
  // bounded by work done rather than by revisiting a page.
  let steps = 0;

  const stop = (waiting: Waiting): View => ({ entries, points, vars, lineCount, waiting, stage });

  while (nodeId) {
    if (++steps > 400000) return stop({ type: "end" });

    const node: NodeRaw | undefined = story.nodes[nodeId];
    if (!node) {
      // A jump can name a label the importer never saw, because Ren'Py allows one to
      // be computed at runtime (`jump expression`, `renpy.random.choice`). Ending the
      // page is the honest outcome; throwing would take the reader down with it.
      if (import.meta.env?.DEV) console.warn(`unknown node in script: ${nodeId}`);
      return stop({ type: "end" });
    }

    applyEffects(vars, node.effects);
    applyStage(stage, node.stage);

    // A caption that differs from the previous page opens a new section.
    if (node.caption && node.caption !== currentCaption) {
      if (lineCount >= lineLimit) return stop({ type: "line" });
      entries.push({
        kind: "line",
        style: "head",
        label: null,
        text: node.caption,
        lineIndex: lineCount,
      });
      lineCount++;
      currentCaption = node.caption;
    }

    for (const raw of node.lines ?? []) {
      if (lineCount >= lineLimit) return stop({ type: "line" });
      entries.push({ ...normalizeLine(raw, vars), kind: "line", lineIndex: lineCount });
      lineCount++;
    }

    if (node.choices) {
      const options = node.choices.filter((choice) => conditionsPass(choice.when, vars));
      const picked = options.find((choice) => choice.id === decisions[depth]);
      const publicOptions: ChoiceOption[] = options.map((c) => ({ id: c.id, label: c.label }));

      entries.push({ kind: "choice", options: publicOptions, pickedId: picked ? picked.id : null });

      // no decision recorded for this choice yet -> stop and ask the player
      if (!picked) return stop({ type: "choice", depth, options: publicOptions });

      points.push({
        depth,
        local: node.local === true,
        picked: picked.label,
        options: options.map((c) => c.label),
        restoreLimit: lineCount,
      });

      depth++;
      applyEffects(vars, picked.effects);
      nodeId = picked.next;
      continue;
    }

    if (node.ret) {
      nodeId = returns.pop();
      continue;
    }

    if (node.call) {
      // return to what follows this page once the callee returns
      if (node.next) returns.push(node.next);
      nodeId = node.call;
      continue;
    }

    nodeId = node.next;
  }

  return stop({ type: "end" });
}
