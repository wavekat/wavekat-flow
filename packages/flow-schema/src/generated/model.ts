// GENERATED from schema/flow.v{1,2,3,4}.schema.json by scripts/generate.mjs — do not edit.
// Run `pnpm gen` after changing a schema; CI fails on drift.

/**
 * One node: a component (kind + its config) plus its wired exits. An internally-tagged union on `kind`.
 */
export type Node = GreetingNode | HoursNode | MenuNode | RingNode | MessageNode | TransferNode | HangupNode | BookNode;
/**
 * What a component speaks: TTS text (a bare string) or a reference to a pre-rendered audio asset shipped alongside the flow.
 */
export type Prompt = Text | Audio;
export type Text = string;
/**
 * The cue a message node plays between its prompt and the start of recording.
 */
export type MessageTone = 'beep' | 'none';

/**
 * The WaveKat call-flow ("Receptionist") document, schema_version 4. Version 4 is version 3 plus flow variables: a top-level `variables` map declares details filled in per call. Every version-3 document is a valid version-4 document once its `schema_version` is bumped, and nothing else changed. This file is the single source of truth for the document SHAPE, and — being the newest version — it is also the file both consumers generate their model types from, so one model covers every supported version. Semantic rules that a JSON Schema cannot express (graph reachability, exit-set exactness, hours/timezone math, DTMF digit validity, prompt length, per-component numeric bounds, and which components a given schema_version may use) are NOT encoded here — they live in each language's validator and are pinned by the shared conformance corpus. Unknown fields are permitted structurally, matching both implementations (Rust serde ignores them; the TS parser surfaces a non-blocking warning).
 */
export interface Flow {
  /**
   * Document format version. This file describes version 4 only; a document declaring another version validates against that version's schema file, not this one. (The type generators relax this constant to a plain integer so the generated model can hold any supported version — see scripts/generate.mjs and build.rs.) (Relaxed from a constant to a plain integer for type generation: one model type covers every supported version.)
   */
  schema_version: number;
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
   * The author's note about the whole flow: free text for people reading it, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  /**
   * Details a caller of this flow fills in per call, declared by name (a lowercase letter, then up to 31 lowercase letters, digits or underscores; the validators check the form, not the schema, so a reader never has to compile a pattern). A text prompt, an audio prompt's `template` and a menu option label refer to them with `{{name}}` placeholders and `{{#name}}…{{/name}}` blocks (the block's text is kept only when the value is non-empty; blocks do not nest). The validators check that every placeholder is well formed and names a declared variable, and refuse `{{` in any other field; a `note` is a comment and is never scanned. Before a call runs, the flow is filled: each placeholder becomes the call's value, or the default when the call gives none or a blank one, and the result is a schema_version 3 document with no variables. Needs schema_version 4: a reader that ignored the map would speak the placeholders as written.
   */
  variables?: {
    [k: string]: Variable;
  };
  /**
   * Node id where execution begins.
   */
  entry: string;
  /**
   * The flat node set, keyed by human-meaningful node id and string-referenced by exits. Order is irrelevant to execution, but it is the author's reading order and is kept on save.
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
 * One declared variable.
 */
export interface Variable {
  /**
   * What the value is, shown to whoever fills it in.
   */
  description?: string;
  /**
   * The value used when a call supplies none, so a flow always plays with no values given. May be an empty string, for a slot that is optional.
   */
  default: string;
  /**
   * Longest a value may be, in Unicode characters.
   */
  max_len?: number;
  [k: string]: unknown;
}
/**
 * Speak a prompt, then continue. Exit: next.
 */
export interface GreetingNode {
  kind: 'greeting';
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  prompt: Prompt;
  exits?: Exits;
  [k: string]: unknown;
}
export interface Audio {
  /**
   * Audio asset ref. A generated-clip ref is a voice_prompts id matching ^vprompt_[a-z0-9]+$.
   */
  audio: string;
  /**
   * The words this pre-rendered clip speaks — the text it was synthesized from — carried so a viewer can show what a caller hears, and for traces. Advisory only: playback always uses `audio`, never this. Optional and forward-added: absent on older documents and on refs the platform did not generate from text.
   */
  transcript?: string;
  /**
   * The text with `{{name}}` placeholders that `audio` was voiced from using the variables' defaults. A call that overrides a variable speaks the filled template instead of the clip; a call that does not plays `audio`. Only on an audio prompt, and only from schema_version 4: an older reader ignores it and plays the clip.
   */
  template?: string;
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
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
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
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  prompt: Prompt;
  /**
   * Digit key → human label. The exit for a digit is exits[digit]. Valid digit keys are enforced by the validator. A label may hold placeholders; one that is exactly a bare `{{name}}` whose filled value is empty removes the option, and its exit, from the call.
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
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  timeout_secs: number;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Voicemail: speak a prompt, record, transcribe, notify. Terminal.
 */
export interface MessageNode {
  kind: 'message';
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  prompt: Prompt;
  max_secs?: number;
  tone?: MessageTone & string;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Hand the call to an external number. With `whisper`, a screened transfer: call the target first, play the whisper, and connect only when they accept; otherwise take `no_answer`. Without it, a blind transfer (terminal). `whisper` is spoken to the person at the target before they are connected, and `timeout_secs` is how long to let the target ring or decide. Both apply only to a screened transfer.
 */
export interface TransferNode {
  kind: 'transfer';
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  target: string;
  whisper?: Prompt;
  timeout_secs?: number;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Speak an optional goodbye and end the call. Terminal.
 */
export interface HangupNode {
  kind: 'hangup';
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  prompt?: Prompt;
  exits?: Exits;
  [k: string]: unknown;
}
/**
 * Offer the caller open appointment times and book the one they choose, before the call ends. New in schema_version 2. The bookable grid is described here (weekly schedule + timezone + how long an appointment is); which times are actually free comes from the connected calendar at call time, and the engine never sees a credential. Exits: booked, no_slots, no_input, unavailable. Three fields carry more meaning than their types show, and are described here because a `$ref` with a sibling description makes the type generators emit a duplicate type instead of reusing the named one. `prompt` is spoken once before the open times are offered ("I can book you in — here are the next available times"); the times themselves are never part of it, since they are not known until the call. `confirm_prompt` is spoken immediately after a successful booking and directly BEFORE the booked time ("You're booked for" → "Tuesday" → "ten thirty a.m."); it deliberately takes no placeholder, because a prompt is frozen audio by the time a call runs and nothing can be interpolated into the middle of it — anything that should follow the time belongs on the booked exit. `schedule` is when this business takes appointments, the `hours` node's weekly shape reused verbatim; it is not the same question `hours` answers, because a business can answer the phone at times it will not book.
 */
export interface BookNode {
  kind: 'book';
  /**
   * The author's note about this step: free text for people reading the flow, in place of a YAML comment. Never read by the engine.
   */
  note?: string;
  prompt: Prompt;
  confirm_prompt: Prompt;
  schedule: WeeklySchedule;
  /**
   * IANA zone (America/New_York) the schedule is written in. Validated to resolve at load.
   */
  timezone: string;
  /**
   * Single-date overrides of the weekly schedule (holidays, one-off clinics), as on `hours`.
   */
  exceptions?: HoursException[];
  /**
   * How long one appointment runs. Bounds are the validator's (see each language's validate module), not this schema's.
   */
  duration_mins: number;
  /**
   * Clear time kept on BOTH sides of an appointment, so a slot is not offered flush against a busy interval.
   */
  buffer_mins?: number;
  /**
   * Nothing sooner than this many minutes from now is offered — the caller cannot book the next five minutes.
   */
  lead_mins?: number;
  /**
   * How far ahead to look for open times.
   */
  horizon_days?: number;
  /**
   * How many times to offer the caller. Each offered time gets one keypad digit, counting from 1.
   */
  max_offers?: number;
  /**
   * Extra attempts to collect a keypress after the first, as on `menu`.
   */
  retries?: number;
  /**
   * How long to wait for a keypress on each attempt, as on `menu`.
   */
  timeout_secs?: number;
  exits?: Exits;
  [k: string]: unknown;
}
