// Twin of the `validate_outbound` tests in `crates/wavekat-flow/src/validate.rs`.
// The shared cases live in `conformance/vN/outbound/`; these pin the details
// the corpus's subset contract does not (which node, exact sets, ordering).

import { describe, expect, it } from 'vitest';

import { requiredExits, requiredSchemaVersion } from '../src/model.js';
import { parseFlow } from '../src/parse.js';
import { outboundKinds, OUTBOUND_KINDS, validateFlow, validateOutbound } from '../src/validate.js';

function flowOf(source: string) {
  const parsed = parseFlow(source);
  if (!parsed.flow) throw new Error(`test flow should parse: ${JSON.stringify(parsed.issues)}`);
  return parsed.flow;
}

function outboundCodes(source: string): string[] {
  return validateOutbound(flowOf(source)).map((issue) => issue.code);
}

const REMINDER = `
schema_version: 1
id: f
name: n
entry: hello
nodes:
  hello:
    kind: greeting
    prompt: This is a reminder about your appointment tomorrow.
    exits: { next: ask }
  ask:
    kind: menu
    prompt: Press 1 to confirm, or 2 to hear this again.
    options: { "1": Confirm, "2": Repeat }
    exits: { "1": thanks, "2": hello, no_input: bye, invalid: ask }
  thanks:
    kind: hangup
    prompt: Thanks, see you then.
  bye:
    kind: hangup
`;

describe('validateOutbound', () => {
  it('accepts an outbound flow with a menu loop', () => {
    expect(validateOutbound(flowOf(REMINDER))).toEqual([]);
  });

  it('refuses ring, book and transfer, naming the node and kind', () => {
    const issues = validateOutbound(
      flowOf(`
schema_version: 2
id: f
name: n
entry: r
nodes:
  r:
    kind: ring
    timeout_secs: 20
    exits: { no_answer: t }
  t:
    kind: transfer
    target: "100"
  b:
    kind: book
    prompt: When suits you?
    confirm_prompt: You're booked for
    timezone: UTC
    schedule:
      tue: [{ open: "09:00", close: "17:00" }]
    duration_mins: 30
    exits: { booked: t, no_slots: t, no_input: t, unavailable: t }
`),
    ).filter((issue) => issue.code === 'outbound_node_not_allowed');
    expect(issues.map((issue) => [issue.node, issue.params?.kind])).toEqual([
      ['b', 'book'],
      ['r', 'ring'],
      ['t', 'transfer'],
    ]);
  });

  it('runs the base validation too', () => {
    const codes = outboundCodes(REMINDER.replace('next: ask', 'next: ghost'));
    expect(codes).toContain('unknown_target');
  });

  it('catches a loop the base validator accepts', () => {
    const src = `
schema_version: 1
id: f
name: n
entry: check
nodes:
  check:
    kind: hours
    timezone: UTC
    schedule:
      mon: [{ open: "09:00", close: "17:00" }]
    exits: { open: say, closed: bye }
  say:
    kind: greeting
    prompt: Still here.
    exits: { next: check }
  bye:
    kind: hangup
`;
    expect(validateFlow(flowOf(src))).toEqual([]);
    expect(
      validateOutbound(flowOf(src)).map((issue) => [issue.code, issue.node]),
    ).toEqual([
      ['outbound_unbounded_loop', 'check'],
      ['outbound_unbounded_loop', 'say'],
    ]);
  });

  it('flags a menu whose no_input leads back into the loop', () => {
    // Into voicemail, every attempt times out: hello -> ask -> hello ...
    // `thanks` and `bye` can still end it, so the base check passes.
    const src = REMINDER.replace('no_input: bye, invalid: ask', 'no_input: hello, invalid: bye');
    expect(validateFlow(flowOf(src))).toEqual([]);
    expect(
      validateOutbound(flowOf(src)).map((issue) => [issue.code, issue.node]),
    ).toEqual([
      ['outbound_unbounded_loop', 'ask'],
      ['outbound_unbounded_loop', 'hello'],
    ]);
  });

  it('flags a menu retrying itself on no_input', () => {
    const src = REMINDER.replace('no_input: bye, invalid: ask', 'no_input: ask, invalid: bye');
    expect(outboundCodes(src)).toEqual(['outbound_unbounded_loop']);
  });

  it('flags a greeting looping on itself', () => {
    const codes = outboundCodes(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: again
    exits: { next: g }
`);
    expect(codes).toContain('outbound_unbounded_loop');
    expect(codes).toContain('trapped');
  });

  it('does not report an unreachable loop as unbounded', () => {
    const codes = outboundCodes(`
schema_version: 1
id: f
name: n
entry: bye
nodes:
  bye:
    kind: hangup
  g:
    kind: greeting
    prompt: again
    exits: { next: g }
`);
    expect(codes).toContain('unreachable');
    expect(codes).not.toContain('outbound_unbounded_loop');
  });
});

// ── screened transfer (schema_version 3) ─────────────────────────────────
// Twins of the screened-transfer tests in `validate.rs`.

const SCREENED = `
schema_version: 3
id: f
name: n
entry: t
nodes:
  t:
    kind: transfer
    target: "+15551234567"
    whisper: Press 1 to accept this call.
    timeout_secs: 20
    exits: { no_answer: bye }
  bye:
    kind: hangup
`;

const codes = (source: string): string[] => validateFlow(flowOf(source)).map((i) => i.code);
const without = (source: string, ...lines: string[]): string =>
  lines.reduce((acc, line) => acc.replace(line, ''), source);
const WHISPER = '    whisper: Press 1 to accept this call.\n';
const TIMEOUT = '    timeout_secs: 20\n';
const NO_ANSWER = '    exits: { no_answer: bye }\n';

describe('screened transfer', () => {
  it('validates', () => {
    expect(validateFlow(flowOf(SCREENED))).toEqual([]);
  });

  it('requires no_answer', () => {
    expect(codes(without(SCREENED, NO_ANSWER))).toContain('missing_exits');
  });

  it('has no exits when blind, in v3', () => {
    const blind = without(SCREENED, WHISPER, TIMEOUT);
    expect(codes(blind)).toEqual(['unexpected_exits']);
    expect(codes(without(blind, NO_ANSWER))).not.toContain('unexpected_exits');
  });

  it('needs v3 for whisper', () => {
    const issues = validateFlow(
      flowOf(without(SCREENED, TIMEOUT).replace('schema_version: 3', 'schema_version: 2')),
    ).filter((i) => i.code === 'field_requires_newer_schema');
    expect(issues.map((i) => i.params)).toEqual([{ field: 'whisper', required: 3, declared: 2 }]);
  });

  it('needs v3 for timeout_secs', () => {
    const v1 = without(SCREENED, WHISPER, NO_ANSWER).replace('schema_version: 3', 'schema_version: 1');
    const found = codes(v1);
    expect(found).toContain('field_requires_newer_schema');
    expect(found).toContain('timeout_without_whisper');
  });

  it('refuses timeout_secs without whisper', () => {
    expect(codes(without(SCREENED, WHISPER, NO_ANSWER))).toContain('timeout_without_whisper');
  });

  it('bounds timeout_secs to 5..120', () => {
    for (const [value, ok] of [
      [4, false],
      [5, true],
      [120, true],
      [121, false],
    ] as const) {
      const issues = validateFlow(
        flowOf(SCREENED.replace('timeout_secs: 20', `timeout_secs: ${value}`)),
      );
      expect(issues.length === 0, `timeout_secs ${value}`).toBe(ok);
      if (!ok) {
        expect(issues.map((i) => [i.code, i.params])).toEqual([
          ['transfer_timeout_out_of_range', { value, min: 5, max: 120 }],
        ]);
      }
    }
  });

  it('applies the prompt-length cap to the whisper', () => {
    const long = SCREENED.replace('Press 1 to accept this call.', 'a'.repeat(2001));
    expect(codes(long)).toEqual(['prompt_too_long']);
  });

  it('needs schema_version 3 only when it uses the new fields', () => {
    expect(requiredSchemaVersion(flowOf(SCREENED))).toBe(3);
    const timeoutOnly = without(SCREENED, WHISPER);
    expect(requiredSchemaVersion(flowOf(timeoutOnly))).toBe(3);
    expect(requiredSchemaVersion(flowOf(without(timeoutOnly, TIMEOUT)))).toBe(1);
  });

  it('does not count as a way to end the call', () => {
    expect(codes(SCREENED.replace('no_answer: bye', 'no_answer: t'))).toContain('trapped');
  });

  it('wires no_answer in requiredExits', () => {
    const flow = flowOf(SCREENED);
    expect(requiredExits(flow.nodes.t as never)).toEqual(['no_answer']);
  });
});

const HANDOFF = `
schema_version: 3
id: f
name: n
entry: hello
nodes:
  hello:
    kind: greeting
    prompt: This is a reminder about your appointment.
    exits: { next: ask }
  ask:
    kind: menu
    prompt: Press 1 to talk to someone, or 2 to confirm.
    options: { "1": Talk, "2": Confirm }
    exits: { "1": connect, "2": thanks, no_input: bye, invalid: ask }
  connect:
    kind: transfer
    target: "+15551234567"
    whisper: Press 1 to accept this call.
    exits: { no_answer: sorry }
  sorry:
    kind: message
    prompt: Nobody is free right now. Leave a message.
  thanks:
    kind: hangup
    prompt: Thanks.
  bye:
    kind: hangup
`;

describe('validateOutbound, version 3', () => {
  it('lists the kinds by version', () => {
    expect(outboundKinds(1)).toEqual(OUTBOUND_KINDS);
    expect(outboundKinds(2)).toEqual(OUTBOUND_KINDS);
    expect(outboundKinds(3)).toEqual([
      'greeting',
      'menu',
      'message',
      'hangup',
      'hours',
      'ring',
      'transfer',
    ]);
  });

  it('allows ring and a screened transfer', () => {
    expect(validateOutbound(flowOf(HANDOFF))).toEqual([]);
    const withRing = HANDOFF.replace(
      '    exits: { no_answer: sorry }\n',
      '    exits: { no_answer: desk }\n  desk:\n    kind: ring\n    timeout_secs: 20\n    exits: { no_answer: sorry }\n',
    );
    expect(validateOutbound(flowOf(withRing))).toEqual([]);
  });

  it('refuses a blind transfer', () => {
    const blind = without(
      HANDOFF,
      '    whisper: Press 1 to accept this call.\n',
      '    exits: { no_answer: sorry }\n',
    );
    const found = outboundCodes(blind);
    expect(found).toContain('outbound_blind_transfer');
    expect(found).not.toContain('outbound_node_not_allowed');
  });

  it('still refuses ring and transfer in version 2', () => {
    const v2 = HANDOFF.replace('schema_version: 3', 'schema_version: 2');
    expect(outboundCodes(v2)).toContain('outbound_node_not_allowed');
  });

  it('treats a no_answer loop as unbounded', () => {
    const loop = `
schema_version: 3
id: f
name: n
entry: r
nodes:
  r:
    kind: ring
    timeout_secs: 20
    exits: { no_answer: again }
  again:
    kind: greeting
    prompt: Trying again.
    exits: { next: r }
  bye:
    kind: hangup
`;
    expect(outboundCodes(loop)).toContain('outbound_unbounded_loop');

    const viaMenu = HANDOFF.replace('no_answer: sorry', 'no_answer: hello')
      .replace('no_input: bye, invalid: ask', 'no_input: connect, invalid: sorry')
      .replace('  bye:\n    kind: hangup\n', '');
    expect(validateFlow(flowOf(viaMenu))).toEqual([]);
    expect(outboundCodes(viaMenu)).toEqual([
      'outbound_unbounded_loop',
      'outbound_unbounded_loop',
      'outbound_unbounded_loop',
    ]);
  });

  it('treats a loop that needs a keypress as bounded', () => {
    const src = HANDOFF.replace('no_answer: sorry', 'no_answer: hello')
      .replace('no_input: bye', 'no_input: sorry')
      .replace('  bye:\n    kind: hangup\n', '');
    expect(validateOutbound(flowOf(src))).toEqual([]);
  });
});
