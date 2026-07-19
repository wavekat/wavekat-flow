// Hand-written model helpers + constants, layered on the SCHEMA-GENERATED
// types in `./generated/model.ts`. The schema owns the document *shape*
// (see CLAUDE.md "Structure vs. semantics"); the values and functions here
// are *logic*, not shape — the exit set a kind must wire, DTMF digit set,
// prompt-length cap, terminal-ness — so they live in code, one twin per
// language. The Rust twins are `crates/wavekat-flow/src/model_ext.rs`
// (helpers) and `validate.rs` / `lib.rs` (the shared constants). When you
// change anything here, update the Rust side to match.

import type { Flow, MessageTone, Node, Prompt } from './generated/model.js';

// ── Re-exported generated types (the public shape) ───────────────────────
export type {
  Exits,
  Flow,
  GreetingNode,
  HangupNode,
  HoursException,
  HoursNode,
  MenuNode,
  MessageNode,
  MessageTone,
  Node,
  Prompt,
  RingNode,
  TimeRange,
  TransferNode,
  WeeklySchedule,
} from './generated/model.js';

/**
 * A node = a component (kind + config) plus its wired exits. The schema
 * generates this as the internally-tagged `Node` union; `FlowNode` is kept
 * as a name alias for the hand-written logic and downstream consumers.
 */
export type FlowNode = Node;

/**
 * The component config carried by a node. In the generated union a node's
 * config and its (optional) `exits` live in the same object, so `Component`
 * and `Node` are the same type here — the decoder builds a config first,
 * then spreads `exits` in.
 */
export type Component = Node;

// ── Shared constants ─────────────────────────────────────────────────────
// Kept in lockstep with the Rust twins (per-const pointers below); the
// handful of values here don't justify a shared-codegen step. Component
// defaults live in the schema itself, so those are single-sourced already.

/** Schema versions this validator understands. Twin: `lib.rs`
 * `SUPPORTED_SCHEMA_VERSIONS`. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

/** Longest a spoken (text) prompt may be — see `validate.ts`. Twin:
 * `validate.rs` `MAX_PROMPT_CHARS`. */
export const MAX_PROMPT_CHARS = 2000;

/** The DTMF keys a `menu` option may be keyed by. Twin: `validate.rs`
 * `VALID_DIGITS`. */
export const VALID_DIGITS: readonly string[] = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '*',
  '#',
];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const COMPONENT_KINDS = [
  'greeting',
  'hours',
  'menu',
  'ring',
  'message',
  'transfer',
  'hangup',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * What a `message` node plays between its prompt and the start of
 * recording — the caller's "start talking now" cue. A closed set: the Rust
 * engine rejects values it doesn't know (the generated `MessageTone` enum).
 */
export const MESSAGE_TONES = ['beep', 'none'] as const;

export const DEFAULT_MENU_RETRIES = 1;
export const DEFAULT_MENU_TIMEOUT_SECS = 5;
export const DEFAULT_MESSAGE_MAX_SECS = 120;
export const DEFAULT_MESSAGE_TONE: MessageTone = 'beep';

// ── Helpers (logic layered on the generated types) ───────────────────────

/**
 * Whether a caller who reaches this component can have the call *end*
 * here. `ring` counts — its implicit `answered` hands the call to a
 * human, which ends the flow.
 */
export function isTerminal(kind: string): boolean {
  return kind === 'message' || kind === 'transfer' || kind === 'hangup' || kind === 'ring';
}

/**
 * The exit names a node **must** wire, given its config. Validation
 * checks `exits` keys are exactly this set — no missing exit (a dead
 * choice) and no stray exit (a typo the engine would never follow).
 */
export function requiredExits(node: Node): string[] {
  switch (node.kind) {
    case 'greeting':
      return ['next'];
    case 'hours':
      return ['open', 'closed'];
    case 'menu':
      return [...Object.keys(node.options), 'no_input', 'invalid'];
    case 'ring':
      return ['no_answer'];
    case 'message':
    case 'transfer':
    case 'hangup':
      return [];
    default:
      return [];
  }
}

/** The spoken text, or `null` for an audio-asset prompt. */
export function promptText(prompt: Prompt): string | null {
  return typeof prompt === 'string' ? prompt : null;
}

/** The audio asset ref, or `null` for a text prompt. */
export function promptAudio(prompt: Prompt): string | null {
  return typeof prompt === 'string' ? null : prompt.audio;
}

/**
 * A generated-clip ref is a `voice_prompts` id (`vprompt_<hex>`) — a clip the
 * platform produced and owns. Anything else in an `audio:` field is a ref the
 * platform does *not* own. Single source of truth for "a ref the platform
 * owns", shared by the API and the web editor.
 */
const GENERATED_CLIP_RE = /^vprompt_[a-z0-9]+$/i;

export function isGeneratedClipRef(ref: string): boolean {
  return GENERATED_CLIP_RE.test(ref);
}

function nodePrompt(node: Node): Prompt | undefined {
  switch (node.kind) {
    case 'greeting':
    case 'menu':
    case 'message':
    case 'hangup':
      return node.prompt;
    default:
      return undefined;
  }
}

/** Every audio asset ref the flow's prompts reference, sorted, unique. */
export function requiredAssets(flow: Flow): string[] {
  const refs = new Set<string>();
  for (const node of Object.values(flow.nodes)) {
    const prompt = nodePrompt(node);
    if (prompt !== undefined) {
      const audio = promptAudio(prompt);
      if (audio !== null) refs.add(audio);
    }
  }
  return [...refs].sort();
}
