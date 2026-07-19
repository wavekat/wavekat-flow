// `isGeneratedClipRef` — the shared "a ref the platform owns" predicate
// (docs/16 §7). Moved here from apps/web so the API's freeze-on-publish and
// missing-asset warnings resolve exactly the same refs the editor does.
//
// Migrated from wavekat-platform/packages/flow-schema/src/refs.test.ts.

import { describe, expect, it } from 'vitest';

import { isGeneratedClipRef } from '../src/model.js';

describe('isGeneratedClipRef', () => {
  it('accepts a voice_prompts id, case-insensitively', () => {
    expect(isGeneratedClipRef('vprompt_ab12cd34')).toBe(true);
    expect(isGeneratedClipRef('vprompt_ABCDEF')).toBe(true);
    expect(isGeneratedClipRef('vprompt_f2ce45ddd3034d2d91969e2ad385c522')).toBe(true);
  });

  it('rejects manual / device refs and junk', () => {
    // A user-typed filename or a daemon-recorded clip — refs we don't own.
    expect(isGeneratedClipRef('bye.wav')).toBe(false);
    expect(isGeneratedClipRef('welcome')).toBe(false);
    expect(isGeneratedClipRef('')).toBe(false);
    // No slashes: the daemon's asset store would reject a traversal-shaped
    // ref, and it isn't a clip we own.
    expect(isGeneratedClipRef('vprompt_a/b')).toBe(false);
    expect(isGeneratedClipRef('vprompt_')).toBe(false);
  });
});
