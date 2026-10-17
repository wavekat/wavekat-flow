// Twin of the `validate_outbound` tests in `crates/wavekat-flow/src/validate.rs`.
// The shared cases live in `conformance/vN/outbound/`; these pin the details
// the corpus's subset contract does not (which node, exact sets, ordering).

import { describe, expect, it } from 'vitest';

import { parseFlow } from '../src/parse.js';
import { validateFlow, validateOutbound } from '../src/validate.js';

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
