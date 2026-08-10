// The `book` component: the vocabulary it needs rendered, and the rules
// that keep an unbookable booking step from being published.
//
// The vocabulary tests are the load-bearing ones. This set is computed
// twice — here, and in Rust by the daemon that plays it — and if the two
// disagree the caller hears silence where a time should be. The
// conformance corpus pins the cross-language half; these pin the
// arithmetic.

import { describe, expect, it } from 'vitest';

import {
  BOOK_GRANULARITY_MINS,
  BOOK_TAKEN_REF,
  bookVocabularyRefs,
  parseBookVocabularyRef,
  requiredAssets,
  validateFlow,
  type BookNode,
  type Flow,
} from '../src/index.js';

function bookNode(overrides: Partial<BookNode> = {}): BookNode {
  return {
    kind: 'book',
    prompt: 'I can book you in.',
    confirm_prompt: "You're booked for",
    timezone: 'UTC',
    schedule: { tue: [{ open: '09:00', close: '11:00' }] },
    duration_mins: 30,
    exits: {
      booked: 'bye',
      no_slots: 'bye',
      no_input: 'bye',
      unavailable: 'bye',
    },
    ...overrides,
  } as BookNode;
}

function flowWith(node: BookNode, schemaVersion = 2): Flow {
  return {
    schema_version: schemaVersion,
    id: 'flow_t',
    name: 'test',
    version: 1,
    entry: 'book_it',
    nodes: { book_it: node, bye: { kind: 'hangup' } },
  } as unknown as Flow;
}

const times = (node: BookNode): string[] =>
  bookVocabularyRefs(node).filter((ref) => parseBookVocabularyRef(ref)?.kind === 'time');

describe('bookVocabularyRefs', () => {
  it('always carries the nine day phrases and the taken line', () => {
    const refs = bookVocabularyRefs(bookNode());
    for (const day of ['today', 'tomorrow', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(refs).toContain(`bkday_${day}`);
    }
    expect(refs).toContain(BOOK_TAKEN_REF);
  });

  it('carries one keypad clip per offer it may make, and no more', () => {
    expect(bookVocabularyRefs(bookNode({ max_offers: 2 }))).toEqual(
      expect.arrayContaining(['bkpress_1', 'bkpress_2']),
    );
    expect(bookVocabularyRefs(bookNode({ max_offers: 2 }))).not.toContain('bkpress_3');
    // Unset means the schema's default of three.
    expect(bookVocabularyRefs(bookNode())).toContain('bkpress_3');
  });

  it('puts starts on the half hour and leaves room for the whole appointment', () => {
    // 09:00–11:00, 30-minute appointments: the last start that still
    // finishes by close is 10:30.
    expect(times(bookNode())).toEqual([
      'bktime_0900',
      'bktime_0930',
      'bktime_1000',
      'bktime_1030',
    ]);
  });

  it('starts at the first half hour at or after opening', () => {
    // 09:10 opens onto a 09:30 grid — never 09:10, and no longer 09:15.
    // 10:30 is dropped because a 30-minute appointment starting there
    // runs past the 10:40 close.
    const node = bookNode({ schedule: { tue: [{ open: '09:10', close: '10:40' }] } });
    expect(times(node)).toEqual(['bktime_0930', 'bktime_1000']);
  });

  it('is the union over every day and every window, without duplicates', () => {
    const node = bookNode({
      schedule: {
        mon: [
          { open: '09:00', close: '10:00' },
          { open: '14:00', close: '15:00' },
        ],
        // Same window on another day contributes the same clips once.
        tue: [{ open: '09:00', close: '10:00' }],
      },
    });
    expect(times(node)).toEqual([
      'bktime_0900',
      'bktime_0930',
      'bktime_1400',
      'bktime_1430',
    ]);
  });

  it('includes the special hours a holiday opens, and nothing from a closed one', () => {
    const node = bookNode({
      schedule: { tue: [{ open: '09:00', close: '10:00' }] },
      exceptions: [
        { date: '2026-12-24', ranges: [{ open: '18:00', close: '19:00' }] },
        // A closed day offers nothing — including any ranges left on it.
        { date: '2026-12-25', closed: true, ranges: [{ open: '23:00', close: '23:30' }] },
      ],
    });
    expect(times(node)).toContain('bktime_1800');
    expect(times(node)).not.toContain('bktime_2300');
  });

  it('offers nothing from a window the appointment cannot fit in', () => {
    // Exactly filling the window is fine (09:00–11:00 takes a two-hour
    // appointment at 09:00); overflowing it by any amount is not.
    expect(times(bookNode({ duration_mins: 120 }))).toEqual(['bktime_0900']);
    expect(times(bookNode({ duration_mins: 135 }))).toEqual([]);
  });

  it('ignores a range it cannot read rather than failing', () => {
    const node = bookNode({
      schedule: {
        tue: [
          { open: 'nine', close: 'five' },
          { open: '17:00', close: '09:00' }, // backwards
          { open: '09:00', close: '09:30' }, // the only usable one
        ],
      },
    });
    expect(times(node)).toEqual(['bktime_0900']);
  });

  it('does not depend on when it is asked', () => {
    // The set is rendered at publish and played months later; nothing in
    // it may come from a clock.
    const node = bookNode();
    expect(bookVocabularyRefs(node)).toEqual(bookVocabularyRefs(node));
  });
});

// Asking for a grid other than this build's own.
//
// A device decides whether it can run a flow by computing this set from
// the constant compiled into *it*, so a renderer that only knows its own
// grid can only ever satisfy devices that agree with it. The parameter
// exists so the platform can render the union of every grid still
// installed and stop being pinned to its oldest device's opinion — see
// the platform's docs/36. The default is what every existing caller,
// including that arming check, keeps getting.
describe('bookVocabularyRefs — an explicit grid', () => {
  const timesOn = (node: BookNode, granularityMins: number): string[] =>
    bookVocabularyRefs(node, { granularityMins }).filter(
      (ref) => parseBookVocabularyRef(ref)?.kind === 'time',
    );

  it("walks the grid it was given, not this build's", () => {
    expect(timesOn(bookNode(), 15)).toEqual([
      'bktime_0900',
      'bktime_0915',
      'bktime_0930',
      'bktime_0945',
      'bktime_1000',
      'bktime_1015',
      'bktime_1030',
    ]);
  });

  it("reproduces the default exactly when handed this build's own grid", () => {
    const node = bookNode({ schedule: { tue: [{ open: '09:10', close: '16:40' }] } });
    expect(bookVocabularyRefs(node, { granularityMins: BOOK_GRANULARITY_MINS })).toEqual(
      bookVocabularyRefs(node),
    );
  });

  it('leaves the non-time refs alone', () => {
    // Day phrases, keypad clips and the taken line have nothing to do
    // with the grid; a caller unioning two grids must not find them
    // duplicated or dropped.
    const coarse = bookVocabularyRefs(bookNode(), { granularityMins: 60 });
    for (const ref of ['bkday_mon', 'bkpress_1', BOOK_TAKEN_REF]) {
      expect(coarse).toContain(ref);
    }
  });

  it('makes a finer grid a superset of a coarser one', () => {
    // The property the union rests on: widening never loses a ref, so a
    // device on the finer grid finds everything it computes inside what
    // a renderer covering both froze.
    const node = bookNode({ schedule: { mon: [{ open: '09:00', close: '17:00' }] } });
    const fine = new Set(bookVocabularyRefs(node, { granularityMins: 15 }));
    for (const ref of bookVocabularyRefs(node, { granularityMins: 30 })) {
      expect(fine).toContain(ref);
    }
  });

  it('refuses a grid that is not a positive whole number of minutes', () => {
    // A zero would not terminate and a fraction would produce refs no
    // renderer can name; both are a caller's bug, and silently falling
    // back to the default would hide it.
    for (const bad of [0, -30, 7.5, Number.NaN]) {
      expect(() => bookVocabularyRefs(bookNode(), { granularityMins: bad })).toThrow();
    }
  });
});

describe('parseBookVocabularyRef', () => {
  it('reads a ref back into what it says', () => {
    expect(parseBookVocabularyRef('bktime_0930')).toEqual({ kind: 'time', hour: 9, minute: 30 });
    expect(parseBookVocabularyRef('bkday_tue')).toEqual({ kind: 'day', day: 'tue' });
    expect(parseBookVocabularyRef('bkpress_2')).toEqual({ kind: 'press', digit: 2 });
    expect(parseBookVocabularyRef('bktaken')).toEqual({ kind: 'taken' });
  });

  it('returns null for anything that is not vocabulary', () => {
    // An author's own clip, and refs shaped like vocabulary that say
    // nothing sayable — so a caller can filter a mixed asset list.
    expect(parseBookVocabularyRef('vprompt_ab12cd34')).toBeNull();
    expect(parseBookVocabularyRef('bkday_funday')).toBeNull();
    expect(parseBookVocabularyRef('bktime_2599')).toBeNull();
    expect(parseBookVocabularyRef('bktime_930')).toBeNull();
    expect(parseBookVocabularyRef('bkpress_9')).toBeNull();
  });
});

describe('requiredAssets with a book node', () => {
  it('includes both of the node’s prompts and its whole vocabulary', () => {
    const node = bookNode({
      prompt: { audio: 'vprompt_intro01' },
      confirm_prompt: { audio: 'vprompt_confirm1' },
      max_offers: 1,
    });
    const assets = requiredAssets(flowWith(node));
    expect(assets).toContain('vprompt_intro01');
    expect(assets).toContain('vprompt_confirm1');
    for (const ref of bookVocabularyRefs(node)) expect(assets).toContain(ref);
  });

  it('needs the vocabulary even when the prompts are plain text', () => {
    // The daemon has no text-to-speech: a text prompt is unplayable
    // either way, but the times still are not sayable without clips.
    const assets = requiredAssets(flowWith(bookNode()));
    expect(assets).toContain('bkday_mon');
    expect(assets).toContain('bktime_0900');
  });
});

describe('validateFlow on a book node', () => {
  const codes = (flow: Flow): string[] => validateFlow(flow).map((issue) => issue.code);

  it('accepts a wired, bookable node', () => {
    expect(validateFlow(flowWith(bookNode()))).toEqual([]);
  });

  it('requires every exit, including the two that only fire when things break', () => {
    const node = bookNode({ exits: { booked: 'bye' } });
    const issue = validateFlow(flowWith(node)).find((i) => i.code === 'missing_exits');
    expect(issue?.params?.missing).toEqual(['no_input', 'no_slots', 'unavailable']);
  });

  it('rejects a node that can never offer an appointment', () => {
    expect(codes(flowWith(bookNode({ duration_mins: 135 })))).toContain('book_never_open');
  });

  it('rejects numbers outside the component’s bounds', () => {
    expect(codes(flowWith(bookNode({ max_offers: 9 })))).toContain('book_out_of_range');
    expect(codes(flowWith(bookNode({ duration_mins: 1 })))).toContain('book_out_of_range');
    expect(codes(flowWith(bookNode({ horizon_days: 400 })))).toContain('book_out_of_range');
  });

  it('rejects a booking step in a version-1 document', () => {
    // Not a typo the author should fix — a version they have to bump.
    const issue = validateFlow(flowWith(bookNode(), 1)).find(
      (i) => i.code === 'kind_requires_newer_schema',
    );
    expect(issue?.params).toMatchObject({ kind: 'book', required: 2, declared: 1 });
  });

  it('leaves version-1 components alone in a version-1 document', () => {
    const flow = {
      schema_version: 1,
      id: 'flow_t',
      name: 'test',
      version: 1,
      entry: 'bye',
      nodes: { bye: { kind: 'hangup' } },
    } as unknown as Flow;
    expect(codes(flow)).not.toContain('kind_requires_newer_schema');
  });
});
