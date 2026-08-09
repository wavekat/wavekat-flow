// Hand-written model helpers + constants, layered on the SCHEMA-GENERATED
// types in `./generated/model.ts`. The schema owns the document *shape*
// (see CLAUDE.md "Structure vs. semantics"); the values and functions here
// are *logic*, not shape — the exit set a kind must wire, DTMF digit set,
// prompt-length cap, terminal-ness — so they live in code, one twin per
// language. The Rust twins are `crates/wavekat-flow/src/model_ext.rs`
// (helpers) and `validate.rs` / `lib.rs` (the shared constants). When you
// change anything here, update the Rust side to match.

import type { BookNode, Flow, MessageTone, Node, Prompt } from './generated/model.js';
import { bookVocabularyRefs } from './book.js';

// ── Re-exported generated types (the public shape) ───────────────────────
export type {
  BookNode,
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
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/** The newest version this build authors — what a new document should
 * declare. Reading stays broad ({@link SUPPORTED_SCHEMA_VERSIONS});
 * writing is deliberately one number. Twin: `lib.rs`
 * `CURRENT_SCHEMA_VERSION`. */
export const CURRENT_SCHEMA_VERSION = 2;

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
  'book',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * The oldest `schema_version` that may carry each component — the whole
 * of what "a version bump" means in this format, since versions grow by
 * gaining components and nothing else so far.
 *
 * A record rather than a list of new kinds per version: adding a kind is
 * then one entry the compiler demands, and the check reads as a
 * comparison instead of a search.
 *
 * The format never migrates a document: a v1 flow keeps working forever,
 * it simply may not use `book`. That is a promise about *stored*
 * documents and is not in tension with an authoring tool raising a draft
 * it is editing — see {@link requiredSchemaVersion}.
 *
 * Twin: `validate.rs` `kind_min_schema_version`.
 */
export const KIND_MIN_SCHEMA_VERSION: Record<ComponentKind, number> = {
  greeting: 1,
  hours: 1,
  menu: 1,
  ring: 1,
  message: 1,
  transfer: 1,
  hangup: 1,
  book: 2,
};

/**
 * The lowest `schema_version` that can carry this document's components —
 * the version it *needs*, as against the one it declares.
 *
 * For an authoring tool, this is the whole of what a version bump means:
 * the author adds a step and the number follows, instead of becoming
 * something they have to know about and set by hand. Pairing it with
 * {@link setSchemaVersion} keeps a draft at the lowest version that can
 * run it, which is also the widest — a document that needs nothing newer
 * stays runnable by every engine in the field.
 *
 * The floor of 1 is load-bearing: `Math.max()` of nothing is `-Infinity`,
 * and a document with no steps yet is exactly what a new draft is.
 *
 * Twin: `validate.rs` `required_schema_version`.
 */
export function requiredSchemaVersion(flow: Flow): number {
  return Math.max(1, ...Object.values(flow.nodes).map((node) => KIND_MIN_SCHEMA_VERSION[node.kind]));
}

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

// The `book` component's constants and its spoken-time vocabulary live
// in `./book.ts` — one file per language for the whole component, so the
// TS/Rust pair stays easy to diff (`book.rs`). They are re-exported from
// the package barrel alongside these.

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
    // Every way out of `book` is wired, including the two nobody wants
    // to think about: a calendar with nothing free, and a calendar we
    // couldn't reach. An unwired `unavailable` would be a dead line on
    // the day Google has an outage.
    case 'book':
      return ['booked', 'no_slots', 'no_input', 'unavailable'];
    case 'message':
    case 'transfer':
    case 'hangup':
      return [];
    default:
      return [];
  }
}

/**
 * The *synthesizable* text: the string for a bare-text prompt the engine
 * speaks with TTS, or `null` for an audio-asset prompt it plays as a clip.
 * Drives playback branching and the length cap. An audio prompt's transcript
 * is display text, not something to synthesize — for the human-readable words
 * either kind speaks, use {@link promptTranscript}. Twin: `model_ext.rs`
 * `Prompt::as_text`.
 */
export function promptText(prompt: Prompt): string | null {
  return typeof prompt === 'string' ? prompt : null;
}

/** The audio asset ref, or `null` for a text prompt. */
export function promptAudio(prompt: Prompt): string | null {
  return typeof prompt === 'string' ? null : prompt.audio;
}

/**
 * The human-readable words this prompt speaks, for display (a "what the
 * caller hears" transcript) and traces, regardless of how it is voiced. A
 * text prompt is its own transcript; an audio prompt carries the text it was
 * synthesized from in `transcript`, `null` when the document omits it (older
 * flows, or a ref not generated from text). Unlike {@link promptText}, never
 * used to decide playback or enforce the length cap. Twin: `model_ext.rs`
 * `Prompt::transcript`.
 */
export function promptTranscript(prompt: Prompt): string | null {
  if (typeof prompt === 'string') return prompt;
  return typeof prompt.transcript === 'string' ? prompt.transcript : null;
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

/** The prompts a node speaks. Most kinds have one; `book` has two (its
 * intro and its confirmation), and `hangup`'s is optional. */
export function nodePrompts(node: Node): Prompt[] {
  switch (node.kind) {
    case 'greeting':
    case 'menu':
    case 'message':
      return [node.prompt];
    case 'hangup':
      return node.prompt === undefined ? [] : [node.prompt];
    case 'book':
      return [node.prompt, node.confirm_prompt];
    default:
      return [];
  }
}

/**
 * Every audio asset the flow needs on the device, sorted and unique:
 * the refs its prompts point at, plus — for a `book` node — the
 * vocabulary it speaks times with (see `book.ts`, which explains why
 * that is an asset and not a sentence).
 *
 * "Needs on the device", not "is written in the document": the daemon
 * asks this to decide whether a flow can be armed yet, and a `book`
 * flow whose vocabulary hasn't synced can no more run than one whose
 * greeting hasn't.
 */
export function requiredAssets(flow: Flow): string[] {
  const refs = new Set<string>();
  for (const node of Object.values(flow.nodes)) {
    for (const prompt of nodePrompts(node)) {
      const audio = promptAudio(prompt);
      if (audio !== null) refs.add(audio);
    }
    if (node.kind === 'book') {
      for (const ref of bookVocabularyRefs(node)) refs.add(ref);
    }
  }
  return [...refs].sort();
}
