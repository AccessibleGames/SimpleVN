import type { NodeRaw, StageEvent, Story, Vars } from "./types";

/**
 * Content model: `graph.json` holds everything structural and language
 * neutral, a *pack* holds the strings of one language. Switching language
 * therefore never touches the graph, the save data or the page ids.
 */

/** Synthetic node used when a link has nowhere to go. */
export const END_NODE = "__end";

export interface GraphNode {
  /** Line number in the original script (debugging aid). */
  line?: number;
  /** Speaker key, see Pack.names. */
  speaker?: string | null;
  /** Caption key, see Pack.captions. */
  caption?: string | null;
  /** Voice clip name from the original game. */
  voice?: string | null;
  /** Key of the choice prompt, see Pack.text. */
  prompt?: string | null;
  next?: string | null;
  /** Ren'Py-style call: jump here, then resume at `next` when the callee returns. */
  call?: string | null;
  /** Pop the call stack instead of continuing. */
  ret?: boolean;
  choices?: { text: string; next: string | null }[];
  /** Stage changes that fire when this page is reached. */
  stage?: StageEvent[];
}

export interface Graph {
  start: string;
  vars: Vars;
  /** Tachie slot offsets in design px, from the script's layer_init.ks. */
  slots?: { l: number; c: number; r: number };
  sources?: { fileKey: string; file: string; pages: number }[];
  /** Runs of one caption, in script order: the scene list for replay. */
  scenes?: { caption: string; node: string }[];
  nodes: Record<string, GraphNode>;
}

export interface Pack {
  locale?: string;
  title?: string;
  names: Record<string, string>;
  captions: Record<string, string>;
  text: Record<string, string>;
}

/** Overlay a (possibly partial) translation on top of the source language. */
export function mergePacks(source: Pack, over: Pack | undefined): Pack {
  if (!over) return source;
  return {
    locale: over.locale ?? source.locale,
    title: over.title ?? source.title,
    names: { ...source.names, ...over.names },
    captions: { ...source.captions, ...over.captions },
    text: { ...source.text, ...over.text },
  };
}

/** Expand a graph + pack into the flat story the engine consumes. */
export function materialize(graph: Graph, pack: Pack): Story {
  const nodes: Record<string, NodeRaw> = {};

  for (const id of Object.keys(graph.nodes)) {
    const node = graph.nodes[id];
    const text = pack.text[id] ?? "";
    const who = node.speaker ? pack.names[node.speaker] : null;

    const raw: NodeRaw = { lines: [] };
    if (text !== "") raw.lines = [who ? { who, text } : text];
    if (node.caption) raw.caption = pack.captions[node.caption];
    if (node.next) raw.next = node.next;
    if (node.call) raw.call = node.call;
    if (node.ret) raw.ret = true;
    if (node.stage) raw.stage = node.stage;

    if (node.choices && node.choices.length > 0) {
      raw.choices = node.choices.map((choice, index) => ({
        id: `${id}#${index + 1}`,
        label: pack.text[choice.text] ?? "",
        next: choice.next ?? END_NODE,
      }));
    }

    nodes[id] = raw;
  }

  nodes[END_NODE] = { lines: [] };

  return {
    title: pack.title,
    start: graph.nodes[graph.start] ? graph.start : END_NODE,
    vars: graph.vars ?? {},
    slots: graph.slots,
    varLabels: {},
    scenes: (graph.scenes ?? [])
      .filter((scene) => nodes[scene.node] !== undefined)
      .map((scene) => ({ caption: pack.captions[scene.caption] ?? scene.caption, node: scene.node })),
    nodes,
  };
}
