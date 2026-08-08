// The `book` component (schema_version 2): its bounds, and the
// vocabulary that lets a caller be told a time.
//
// ── Why a vocabulary exists at all ───────────────────────────────────────
//
// Every sound a flow makes is a clip. The daemon runs no text-to-speech:
// prompts are rendered when the flow is published and frozen as version
// assets, and playback is a file read. That is what makes a flow work
// with no network, and it is why `book` cannot simply "say the time" —
// the time is not known until a caller is on the line, hours or days
// after the last thing was rendered.
//
// So the times a flow can *ever* offer are enumerated at publish and
// rendered then, exactly like its prompts. Two things make that a small
// finite set rather than an impossible one:
//
//   * starts snap to a quarter hour ({@link BOOK_GRANULARITY_MINS}), and
//   * the node already declares the only hours it books in.
//
// A business open 9–5 on weekdays therefore needs 32 time clips, not
// 1440 — and it needs them regardless of which week the caller rings in,
// because "nine thirty" is the same two words on every one of those days.
//
// ── Why it is split day + time, and not one clip per utterance ───────────
//
// An utterance is two clips: a day phrase then a time phrase ("Tuesday"
// + "ten thirty a.m."). One clip per (day, time) pair would be the
// simplest thing to play and multiplies the render count by nine for no
// gain. Going finer the other way — one clip per word, composing
// "ten" + "thirty" + "a.m." — is what a naive reading suggests and is
// wrong: word order and grammar are not shared across the languages this
// platform ships, and an engine that concatenates fragments in English
// order produces something between odd and unintelligible elsewhere.
// Rendering whole phrases keeps every language's grammar inside the
// phrase, where the translator can see it; day-before-time is the one
// ordering assumption left, and it holds across all of them.
//
// ── The contract ─────────────────────────────────────────────────────────
//
// The refs below are the contract between the two sides: the platform
// renders exactly this set at publish and stores it with the version's
// frozen assets; the daemon plays these refs and never asks what they
// mean. Both sides compute the set from the same node config with this
// function, so neither can render one thing and expect another. The refs
// join {@link requiredAssets}, which means the daemon's existing
// "don't arm a flow whose audio hasn't synced" gate covers them with no
// new machinery.
//
// Twin: `crates/wavekat-flow/src/book.rs`. Keep the two in lockstep —
// the conformance corpus pins the ref sets they produce.

import type { BookNode, TimeRange } from './generated/model.js';

// ── Defaults (mirroring the schema's own, which typify reads for Rust) ───

export const DEFAULT_BOOK_BUFFER_MINS = 0;
export const DEFAULT_BOOK_LEAD_MINS = 120;
export const DEFAULT_BOOK_HORIZON_DAYS = 14;
export const DEFAULT_BOOK_MAX_OFFERS = 3;
export const DEFAULT_BOOK_RETRIES = 1;
export const DEFAULT_BOOK_TIMEOUT_SECS = 5;

// ── Bounds (the validator's, per "schema owns shape, validators own
//    semantics" — see CLAUDE.md) ─────────────────────────────────────────

/** Shortest and longest one appointment may run. */
export const MIN_BOOK_DURATION_MINS = 5;
export const MAX_BOOK_DURATION_MINS = 480;
/** Widest clear time that may be kept on each side of an appointment. */
export const MAX_BOOK_BUFFER_MINS = 240;
/** Furthest ahead a caller may be pushed before the first offer (30 days). */
export const MAX_BOOK_LEAD_MINS = 60 * 24 * 30;
/**
 * Furthest ahead a `book` node may look. Bounds the platform's day walk
 * as well; twin: its `MAX_HORIZON_DAYS`.
 */
export const MAX_BOOK_HORIZON_DAYS = 31;
/**
 * How many times one caller may be offered. Bounded by the keypad digits
 * the vocabulary carries — and by how much a person can hold in their
 * head with a phone against their ear.
 */
export const MAX_BOOK_OFFERS = 5;

/**
 * Every candidate appointment start lands on a quarter hour.
 *
 * Load-bearing, not cosmetic: this is what bounds the vocabulary above.
 * Widening it widens every published flow's render. Twin: the platform's
 * `SLOT_GRANULARITY_MINS`, which must agree — if the server offers a
 * time the vocabulary has no clip for, the caller hears silence where
 * the time should be.
 */
export const BOOK_GRANULARITY_MINS = 15;

// ── Vocabulary refs ──────────────────────────────────────────────────────

/** Prefix every vocabulary ref carries, so nothing collides with a
 * platform-generated clip ref (`vprompt_…`) or an author's own file. */
const PREFIX = 'bk';

/**
 * The day phrases, always required. `today` and `tomorrow` are how a
 * person says a date this close to now, and a caller told "Monday" on a
 * Monday has to work out which Monday.
 */
export const BOOK_DAY_KEYS = [
  'today',
  'tomorrow',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type BookDayKey = (typeof BOOK_DAY_KEYS)[number];

/** `bkday_tue` — the day half of an utterance. */
export function bookDayRef(day: BookDayKey): string {
  return `${PREFIX}day_${day}`;
}

/** `bktime_0930` — the time half, in the flow's own timezone. */
export function bookTimeRef(minutesOfDay: number): string {
  const hh = Math.floor(minutesOfDay / 60);
  const mm = minutesOfDay % 60;
  return `${PREFIX}time_${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
}

/** `bkpress_2` — "press two", the digit that takes the offer. */
export function bookPressRef(digit: number): string {
  return `${PREFIX}press_${digit}`;
}

/**
 * The one fixed line the component speaks on its own account: the slot
 * the caller chose was taken between hearing it and pressing the key.
 * Everything else a caller hears is either the author's prompt or a time.
 */
export const BOOK_TAKEN_REF = `${PREFIX}taken`;

/** What a vocabulary ref means — so the side that *renders* it can look
 * up the words without re-deriving the ref format. */
export type BookVocabularyRef =
  | { kind: 'day'; day: BookDayKey }
  | { kind: 'time'; hour: number; minute: number }
  | { kind: 'press'; digit: number }
  | { kind: 'taken' };

/**
 * Read a ref back into what it says. `null` for anything that is not a
 * vocabulary ref (an author's clip, a filename), so a caller can filter
 * a mixed asset list with it.
 */
export function parseBookVocabularyRef(ref: string): BookVocabularyRef | null {
  if (ref === BOOK_TAKEN_REF) return { kind: 'taken' };

  const day = ref.startsWith(`${PREFIX}day_`) ? ref.slice(`${PREFIX}day_`.length) : null;
  if (day !== null) {
    return (BOOK_DAY_KEYS as readonly string[]).includes(day)
      ? { kind: 'day', day: day as BookDayKey }
      : null;
  }

  if (ref.startsWith(`${PREFIX}time_`)) {
    const digits = ref.slice(`${PREFIX}time_`.length);
    if (!/^\d{4}$/.test(digits)) return null;
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2));
    if (hour > 23 || minute > 59) return null;
    return { kind: 'time', hour, minute };
  }

  if (ref.startsWith(`${PREFIX}press_`)) {
    const digits = ref.slice(`${PREFIX}press_`.length);
    if (!/^\d+$/.test(digits)) return null;
    const digit = Number(digits);
    return digit >= 1 && digit <= MAX_BOOK_OFFERS ? { kind: 'press', digit } : null;
  }

  return null;
}

// ── Enumerating a node's vocabulary ──────────────────────────────────────

/** `"HH:MM"` → minutes since midnight, or `null` if it isn't one. Lenient
 * in the same direction as the runtime: a range this can't read is a
 * range that offers nothing, not a document that fails to load. */
function minutesOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * The starts a single open range can produce: on the quarter-hour grid,
 * from the first grid point at or after `open`, while the whole
 * appointment still finishes by `close`.
 *
 * Mirrors the platform's slot walk exactly — including that the walk
 * uses real instants and so may drop a candidate this misses on a
 * daylight-saving boundary. That direction is safe: the vocabulary is
 * allowed to be a superset (a clip nobody plays), never a subset (a time
 * nobody can say).
 */
function startsInRange(range: TimeRange, durationMins: number): number[] {
  const open = minutesOf(range.open);
  const close = minutesOf(range.close);
  if (open === null || close === null || close <= open) return [];

  const first = Math.ceil(open / BOOK_GRANULARITY_MINS) * BOOK_GRANULARITY_MINS;
  const starts: number[] = [];
  for (let mins = first; mins < close; mins += BOOK_GRANULARITY_MINS) {
    if (mins + durationMins <= close) starts.push(mins);
  }
  return starts;
}

/**
 * Every asset ref a `book` node needs in order to speak: the nine day
 * phrases, one clip per bookable time of day, one "press N" per offer it
 * may make, and the taken line. Sorted and unique, so two callers of this
 * compare equal.
 *
 * Reads only the node's own config, never a clock — the answer must be
 * the same at publish (when it is rendered) and on a call months later
 * (when it is played).
 */
export function bookVocabularyRefs(node: BookNode): string[] {
  const refs = new Set<string>();

  for (const day of BOOK_DAY_KEYS) refs.add(bookDayRef(day));
  refs.add(BOOK_TAKEN_REF);

  const offers = Math.min(node.max_offers ?? DEFAULT_BOOK_MAX_OFFERS, MAX_BOOK_OFFERS);
  for (let digit = 1; digit <= offers; digit++) refs.add(bookPressRef(digit));

  // A duration outside the bounds is a document the validator rejects;
  // clamping here keeps a bad draft from asking for an unbounded render
  // while the editor is still showing the error.
  const duration = Math.min(
    Math.max(node.duration_mins, MIN_BOOK_DURATION_MINS),
    MAX_BOOK_DURATION_MINS,
  );

  // Named fields rather than `Object.values`: the schedule type carries
  // an index signature for unknown keys (documents accept them, the
  // parser warns), and a stray `funday:` must not add times the Rust
  // twin — which deserializes into seven named fields — would never see.
  const { mon, tue, wed, thu, fri, sat, sun } = node.schedule;
  const ranges: TimeRange[] = [];
  for (const day of [mon, tue, wed, thu, fri, sat, sun]) {
    if (day) ranges.push(...day);
  }
  for (const exception of node.exceptions ?? []) {
    // A closed day offers nothing; its `ranges`, if any, are ignored by
    // the runtime too.
    if (exception.closed) continue;
    ranges.push(...(exception.ranges ?? []));
  }

  for (const range of ranges) {
    for (const start of startsInRange(range, duration)) refs.add(bookTimeRef(start));
  }

  return [...refs].sort();
}
