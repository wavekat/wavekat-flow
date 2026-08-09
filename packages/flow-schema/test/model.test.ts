// The version a document *needs*, as opposed to the one it declares.
// An authoring tool asks this to keep the two in step: the author adds a
// step, and the number follows on its own rather than becoming something
// they have to know about.

import { describe, expect, it } from 'vitest';

import { checkFlow } from '../src/check.js';
import { requiredSchemaVersion } from '../src/model.js';
import type { Flow } from '../src/model.js';

function parsed(source: string): Flow {
  const { flow, issues } = checkFlow(source);
  if (!flow) throw new Error(`fixture failed to parse: ${JSON.stringify(issues)}`);
  return flow;
}

const V1_ONLY = `schema_version: 1
id: flow_1
name: Test
entry: welcome
nodes:
  welcome:
    kind: greeting
    prompt: Hi!
    exits: { next: bye }
  bye:
    kind: hangup
`;

const WITH_BOOK = `schema_version: 2
id: flow_1
name: Test
entry: appointment
nodes:
  appointment:
    kind: book
    prompt: When suits you?
    confirm_prompt: You're booked for
    timezone: UTC
    duration_mins: 30
    schedule:
      mon: [{ open: "09:00", close: "17:00" }]
    exits: { booked: bye, no_slots: bye, no_input: bye, unavailable: bye }
  bye:
    kind: hangup
`;

describe('requiredSchemaVersion', () => {
  it('is 1 for a document built only from components v1 had', () => {
    expect(requiredSchemaVersion(parsed(V1_ONLY))).toBe(1);
  });

  it('rises to the newest version any one component needs', () => {
    expect(requiredSchemaVersion(parsed(WITH_BOOK))).toBe(2);
  });

  it('falls back again once the component that raised it is gone', () => {
    const flow = parsed(WITH_BOOK);
    delete flow.nodes.appointment;
    expect(requiredSchemaVersion(flow)).toBe(1);
  });

  it('is 1 for a document with no steps at all', () => {
    // The starter document an author lands on. `Math.max()` of nothing is
    // -Infinity, so the floor is load-bearing, not decorative.
    expect(requiredSchemaVersion({ ...parsed(V1_ONLY), nodes: {} })).toBe(1);
  });
});
