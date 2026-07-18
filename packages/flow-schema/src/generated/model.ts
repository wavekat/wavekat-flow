// GENERATED from schema/flow.v1.schema.json by scripts/generate.mjs — do not edit.
// Run `pnpm gen` after changing the schema; CI fails on drift.

/**
 * One node: a component (kind + its config) plus its wired exits. An internally-tagged union on `kind`.
 */
export type Node = GreetingNode | HoursNode | MenuNode | RingNode | MessageNode | TransferNode | HangupNode;
/**
 * What a component speaks: TTS text (a bare string) or a reference to a pre-rendered audio asset shipped alongside the flow.
 */
export type Prompt =
  | string
  | {
      /**
       * Audio asset ref. A generated-clip ref is a voice_prompts id matching ^vprompt_[a-z0-9]+$.
       */
      audio: string;
      [k: string]: unknown;
    };
/**
 * The cue a message node plays between its prompt and the start of recording.
 */
export type MessageTone = 'beep' | 'none';

/**
 * The WaveKat call-flow ("Receptionist") document, schema_version 1. This file is the single source of truth for the document SHAPE: every consumer (the @wavekat/flow-schema npm package, the wavekat-flow Rust crate) generates its model types from this file. Semantic rules that a JSON Schema cannot express (graph reachability, exit-set exactness, hours/timezone math, DTMF digit validity, prompt length) are NOT encoded here — they live in each language's validator and are pinned by the shared conformance corpus. Unknown fields are permitted structurally, matching both implementations (Rust serde ignores them; the TS parser surfaces a non-blocking warning).
 */
export interface Flow {
  /**
   * Document format version. This file describes version 1 only; a document declaring another version validates against that version's schema file, not this one.
   */
  schema_version: 1;
  /**
   * Opaque platform-assigned id (flow_…). Treated as a label; appears in traces.
   */
  id: string;
  /**
   * Human name shown in the editor and the read-only viewer.
   */
  name: string;
  /**
   * Platform-assigned publish counter, bumped on publish. Defaults to 1 for a hand-written or generated pre-publish document. Distinct from schema_version.
   */
  version?: number;
  /**
   * Node id where execution begins.
   */
  entry: string;
  /**
   * The flat node set, keyed by human-meaningful node id and string-referenced by exits. Order is irrelevant to execution.
   */
  nodes: {
    [k: string]: Node;
  };
  /**
   * Presentation metadata (canvas positions, annotations). Preserved on round-trip, never read by the engine. Opaque by design so a canvas editor can add layout fields without a schema bump.
   */
  ui?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * Speak a prompt, then continue. Exit: next.
 */
export interface GreetingNode {
  kind: 'greeting';
  prompt: Prompt;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Wired exits: exit name → target node id. Which names are valid is a property of the node's kind and is checked by the validator, not by this schema.
 */
export interface Exits {
  [k: string]: string;
}
/**
 * Branch on the business's weekly schedule + holiday overrides. Exits: open, closed.
 */
export interface HoursNode {
  kind: 'hours';
  schedule: WeeklySchedule;
  /**
   * IANA zone (America/New_York). Validated to resolve at load.
   */
  timezone: string;
  exceptions?: HoursException[];
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Open ranges per weekday; a missing or empty day means closed all day.
 */
export interface WeeklySchedule {
  mon?: TimeRange[];
  tue?: TimeRange[];
  wed?: TimeRange[];
  thu?: TimeRange[];
  fri?: TimeRange[];
  sat?: TimeRange[];
  sun?: TimeRange[];
  [k: string]: unknown;
}
/**
 * One open window: open–close as "HH:MM" (24-hour). Ordering and overnight rules are enforced by the validator.
 */
export interface TimeRange {
  open: string;
  close: string;
  [k: string]: unknown;
}
/**
 * A single-date override of the weekly schedule (holiday / special hours).
 */
export interface HoursException {
  /**
   * "YYYY-MM-DD" in the flow's timezone.
   */
  date: string;
  /**
   * Closed all day regardless of ranges.
   */
  closed?: boolean;
  ranges?: TimeRange[];
  [k: string]: unknown;
}
/**
 * Speak a prompt and collect a DTMF choice. Exits: one per digit in options, plus no_input and invalid.
 */
export interface MenuNode {
  kind: 'menu';
  prompt: Prompt;
  /**
   * Digit key → human label. The exit for a digit is exits[digit]. Valid digit keys are enforced by the validator.
   */
  options: {
    [k: string]: string;
  };
  retries?: number;
  timeout_secs?: number;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Ring the human for a window. answered is an implicit terminal; the only wired exit is no_answer.
 */
export interface RingNode {
  kind: 'ring';
  timeout_secs: number;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Voicemail: speak a prompt, record, transcribe, notify. Terminal.
 */
export interface MessageNode {
  kind: 'message';
  prompt: Prompt;
  max_secs?: number;
  tone?: MessageTone & string;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Blind-transfer to an external number. Terminal.
 */
export interface TransferNode {
  kind: 'transfer';
  target: string;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Speak an optional goodbye and end the call. Terminal.
 */
export interface HangupNode {
  kind: 'hangup';
  prompt?: Prompt;
  exits?: Exits;
  [k: string]: unknown;
}
