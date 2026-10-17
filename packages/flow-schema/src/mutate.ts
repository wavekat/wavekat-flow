// Structured edits to a flow document. The YAML text is the single source
// of truth, and everything in it that matters is in the model (doc 01:
// "the document is the whole truth"), so every op is
//
//   parseFlow → change the decoded flow → serializeFlow
//
// and the result is the canonical text, the same bytes the Rust crate's
// `Flow::to_yaml` writes. Comments carry no meaning and are not kept (the
// words belong in `note`); `parseFlow` reports them as `comment_ignored`
// so an editor can warn first.
//
// Every op is stateless: source in, source out. Documents are a few KB at
// most, so re-parsing per edit is well inside interaction budgets.

import { parseDocument } from 'yaml';

import type { ComponentKind, Flow, FlowNode } from './model.js';
import { SUPPORTED_SCHEMA_VERSIONS } from './model.js';
import { parseFlow } from './parse.js';
import { serializeFlow } from './serialize.js';

/**
 * Why an edit was refused:
 * - `parse_failed`: the text isn't YAML.
 * - `invalid_document`: it's YAML, but doesn't decode as a flow (a menu
 *   with no `options`, say); fix the YAML first. Validation problems, like
 *   a missing exit, don't count: those documents decode and can be edited.
 * - `unknown_field`: it has fields this version doesn't know, which a save
 *   would delete.
 * - `unsupported_version`: it declares a `schema_version` this version
 *   can't write back.
 */
export type EditError =
  | 'parse_failed'
  | 'invalid_document'
  | 'unknown_field'
  | 'unsupported_version'
  | 'invalid_node_id'
  | 'duplicate_node_id'
  | 'unknown_node';

export type EditResult = { ok: true; source: string } | { ok: false; error: EditError };

/**
 * What the editor accepts as a node id: plain-YAML-safe, so ids never
 * need quoting. (The schema itself allows any string; this constraint
 * is editorial, matching the doc 48 "human-meaningful node IDs" rule.)
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

type Json = { [key: string]: unknown };

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function withFlow(source: string, edit: (flow: Flow) => EditError | undefined): EditResult {
  const parsed = parseFlow(source);
  if (!parsed.flow) {
    const yaml = parsed.issues.some(
      (i) => i.severity === 'error' && (i.code === 'yaml_error' || i.code === 'yaml_unsupported'),
    );
    return { ok: false, error: yaml ? 'parse_failed' : 'invalid_document' };
  }
  // The version first: a newer document has fields this build can't know,
  // and "unsupported version" is the better answer (as in Rust's `load`).
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(parsed.flow.schema_version)) {
    return { ok: false, error: 'unsupported_version' };
  }
  if (parsed.issues.some((i) => i.code === 'unknown_field')) {
    return { ok: false, error: 'unknown_field' };
  }
  const flow = structuredClone(parsed.flow);
  const error = edit(flow);
  if (error) return { ok: false, error };
  return { ok: true, source: serializeFlow(flow) };
}

/** `nodes` with one key renamed in place, keeping every other key's order. */
function renameKey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[k === from ? to : k] = v;
  return out;
}

/** The `ui` block spots that may be keyed by node id. Opaque to the
 * engine, but a rename/delete that leaves stale ids behind would leak
 * one node's position onto another once the id is reused. */
function uiMaps(flow: Flow): Json[] {
  const ui = flow.ui as unknown;
  if (!isObject(ui)) return [];
  const maps = [ui];
  for (const key of ['nodes', 'positions']) {
    const sub = ui[key];
    if (isObject(sub)) maps.push(sub);
  }
  return maps;
}

/** Replace the contents of `target` with `next`, in `next`'s order. */
function replaceContents(target: Json, next: Json): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

function exitsOf(node: FlowNode): Record<string, string> {
  if (!node.exits) node.exits = {};
  return node.exits as Record<string, string>;
}

/**
 * Rename a node and every reference to it: the `nodes` key, `entry`,
 * every exit target, and `ui` position keys.
 */
export function renameNode(source: string, from: string, to: string): EditResult {
  if (!NODE_ID_PATTERN.test(to)) return { ok: false, error: 'invalid_node_id' };
  return withFlow(source, (flow) => {
    if (!Object.hasOwn(flow.nodes, from)) return 'unknown_node';
    if (from !== to && Object.hasOwn(flow.nodes, to)) return 'duplicate_node_id';

    flow.nodes = renameKey(flow.nodes, from, to);
    if (flow.entry === from) flow.entry = to;
    for (const node of Object.values(flow.nodes)) {
      const exits = node.exits as Record<string, string> | undefined;
      if (!exits) continue;
      for (const [name, target] of Object.entries(exits)) {
        if (target === from) exits[name] = to;
      }
    }
    for (const map of uiMaps(flow)) {
      if (Object.hasOwn(map, from)) replaceContents(map, renameKey(map, from, to));
    }
    return undefined;
  });
}

/**
 * Remove a node, every exit that pointed at it (their absence is then
 * reported by validation as a missing required exit — the author must
 * rewire, not silently fall through), and its `ui` position. A dangling
 * `entry` is left for validation to flag.
 */
export function removeNode(source: string, id: string): EditResult {
  return withFlow(source, (flow) => {
    if (!Object.hasOwn(flow.nodes, id)) return 'unknown_node';
    delete flow.nodes[id];
    for (const node of Object.values(flow.nodes)) {
      const exits = node.exits as Record<string, string> | undefined;
      if (!exits) continue;
      for (const [name, target] of Object.entries(exits)) {
        if (target === id) delete exits[name];
      }
    }
    for (const map of uiMaps(flow)) delete map[id];
    return undefined;
  });
}

/** Insert a new node built from a plain JS shape (see `defaultNode`). */
export function addNode(source: string, id: string, node: Record<string, unknown>): EditResult {
  if (!NODE_ID_PATTERN.test(id)) return { ok: false, error: 'invalid_node_id' };
  return withFlow(source, (flow) => {
    if (Object.hasOwn(flow.nodes, id)) return 'duplicate_node_id';
    flow.nodes[id] = structuredClone(node) as unknown as FlowNode;
    return undefined;
  });
}

/** Point the flow's `entry` at an existing node. */
export function setEntry(source: string, id: string): EditResult {
  return withFlow(source, (flow) => {
    if (!Object.hasOwn(flow.nodes, id)) return 'unknown_node';
    flow.entry = id;
    return undefined;
  });
}

/** Wire (or rewire) one exit of a node. */
export function setExit(source: string, id: string, exit: string, target: string): EditResult {
  return withFlow(source, (flow) => {
    const node = flow.nodes[id];
    if (!node) return 'unknown_node';
    exitsOf(node)[exit] = target;
    return undefined;
  });
}

/** Remove one exit of a node. */
export function removeExit(source: string, id: string, exit: string): EditResult {
  return withFlow(source, (flow) => {
    const node = flow.nodes[id];
    if (!node) return 'unknown_node';
    delete exitsOf(node)[exit];
    return undefined;
  });
}

/**
 * Set (or with `value === undefined`, delete) one config field of a
 * node — `['prompt']`, `['options', '2']`, `['schedule', 'mon']`, …
 * Missing containers on the way are created: a map for a string key, a
 * list for a number.
 */
export function setNodeValue(
  source: string,
  id: string,
  path: (string | number)[],
  value: unknown,
): EditResult {
  return withFlow(source, (flow) => {
    const node = flow.nodes[id];
    if (!node) return 'unknown_node';
    if (path.length === 0) return undefined;
    let container: unknown = node;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i] as string | number;
      const holder = container as Record<string | number, unknown>;
      if (holder[key] === null || typeof holder[key] !== 'object') {
        if (value === undefined) return undefined;
        holder[key] = typeof path[i + 1] === 'number' ? [] : {};
      }
      container = holder[key];
    }
    const last = path[path.length - 1] as string | number;
    if (value === undefined) {
      if (Array.isArray(container) && typeof last === 'number') container.splice(last, 1);
      else delete (container as Record<string | number, unknown>)[last];
    } else {
      (container as Record<string | number, unknown>)[last] = structuredClone(value);
    }
    return undefined;
  });
}

/**
 * Where the editor's drag-to-arrange puts a node on the map, stored in
 * the engine-opaque `ui` block as `ui.positions.<id>: [x, y]` so a
 * hand-arranged map survives save/publish and travels with the
 * document. The engine never reads it; renameNode/removeNode keep the
 * keys in sync.
 */
export function setNodePosition(source: string, id: string, x: number, y: number): EditResult {
  return withFlow(source, (flow) => {
    if (!Object.hasOwn(flow.nodes, id)) return 'unknown_node';
    const ui: Json = isObject(flow.ui) ? (flow.ui as Json) : {};
    const positions: Json = isObject(ui['positions']) ? (ui['positions'] as Json) : {};
    positions[id] = [Math.round(x), Math.round(y)];
    ui['positions'] = positions;
    flow.ui = ui as Flow['ui'];
    return undefined;
  });
}

/** Drop every stored position — the map falls back to auto layout. */
export function clearNodePositions(source: string): EditResult {
  return withFlow(source, (flow) => {
    const ui = flow.ui as unknown;
    if (!isObject(ui)) return undefined;
    delete ui['positions'];
    if (Object.keys(ui).length === 0) delete flow.ui;
    return undefined;
  });
}

/**
 * The stored positions of a parsed flow's `ui` block, dropping anything
 * that isn't a `[number, number]` pair — the block is author-editable
 * text, so junk shapes are expected, not errors.
 */
export function nodePositions(ui: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (ui === null || typeof ui !== 'object') return out;
  const positions = (ui as { positions?: unknown }).positions;
  if (positions === null || typeof positions !== 'object' || Array.isArray(positions)) return out;
  for (const [id, value] of Object.entries(positions as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const [x, y] = value as unknown[];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    out[id] = { x, y };
  }
  return out;
}

/**
 * Stamp platform-assigned identity into the document — the row id at
 * create time, the bumped `version` at publish (doc 48: both are
 * platform-assigned; authors never maintain them by hand).
 *
 * A new draft usually has no `id` (and may have no `name`) yet, so it
 * can't be decoded as a flow until these are in. They are set on the
 * parsed YAML first; the document then goes through the model like every
 * other edit, and comes out canonical.
 */
export function stampIdentity(
  source: string,
  identity: { id?: string; version?: number; name?: string },
): EditResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, error: 'parse_failed' };
  if (!isObject(doc.toJS())) return { ok: false, error: 'invalid_document' };
  if (identity.id !== undefined) doc.set('id', identity.id);
  if (identity.version !== undefined) doc.set('version', identity.version);
  if (identity.name !== undefined) doc.set('name', identity.name);
  return withFlow(doc.toString(), () => undefined);
}

/**
 * Restate the document's declared `schema_version`.
 *
 * Machine-managed, like the identity fields above: an authoring tool sets
 * it from {@link requiredSchemaVersion} so the number tracks the steps the
 * author actually placed, rather than being a thing they have to know
 * about. It lowers as readily as it raises — a draft that no longer needs
 * the newer component goes back to the widest version that can run it.
 *
 * This does not migrate a document. Nothing here rewrites a stored flow's
 * *contents* to suit another version; the format's promise that an old
 * document keeps working is untouched.
 */
export function setSchemaVersion(source: string, version: number): EditResult {
  return withFlow(source, (flow) => {
    flow.schema_version = version as Flow['schema_version'];
    return undefined;
  });
}

/**
 * A freshly-added node's starting shape, per kind. English placeholder
 * copy — the web editor passes its own localized shape instead; this is
 * the fallback and the tests' fixture. Exits are deliberately unwired:
 * validation's "missing required exits" is what walks the author
 * through connecting the new node.
 */
export function defaultNode(kind: ComponentKind): Record<string, unknown> {
  switch (kind) {
    case 'greeting':
      return { kind, prompt: 'Hello!' };
    case 'hours':
      return { kind, timezone: 'UTC', schedule: {} };
    case 'menu':
      return { kind, prompt: 'Press 1.', options: { '1': 'Option 1' } };
    case 'ring':
      return { kind, timeout_secs: 25 };
    case 'message':
      return { kind, prompt: 'Please leave a message after the tone.' };
    case 'transfer':
      return { kind, target: '' };
    case 'hangup':
      return { kind };
    // Opens with a plausible working week rather than an empty schedule:
    // `book`'s empty state is a node that can never offer anything, and
    // an author who has just added a booking step should hear the
    // validator complain about wiring, not about arithmetic.
    case 'book':
      return {
        kind,
        prompt: 'I can book you in. Here are the next available times.',
        confirm_prompt: "You're booked for",
        timezone: 'UTC',
        schedule: {
          mon: [{ open: '09:00', close: '17:00' }],
          tue: [{ open: '09:00', close: '17:00' }],
          wed: [{ open: '09:00', close: '17:00' }],
          thu: [{ open: '09:00', close: '17:00' }],
          fri: [{ open: '09:00', close: '17:00' }],
        },
        duration_mins: 30,
      };
  }
}
