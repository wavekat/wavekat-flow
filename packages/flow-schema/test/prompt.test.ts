// Prompt accessors — the split between "text to synthesize" and "words the
// caller hears". `promptText`/`promptAudio` drive playback (synthesize vs.
// play a clip); `promptTranscript` is display/trace text that both kinds
// carry. Twin of the Rust `Prompt::as_text` / `Prompt::transcript` tests in
// `crates/wavekat-flow/src/model_ext.rs`.

import { describe, expect, it } from 'vitest';

import { promptAudio, promptText, promptTranscript } from '../src/model.js';
import type { Prompt } from '../src/model.js';

const textPrompt: Prompt = 'We are open Tuesday to Sunday, eleven to ten.';
const audioWithText: Prompt = {
  audio: 'vprompt_ab12cd34',
  transcript: 'We are open Tuesday to Sunday, eleven to ten.',
};
const audioWithoutText: Prompt = { audio: 'vprompt_ff00ee11' };

describe('promptText / promptAudio (playback branching)', () => {
  it('a text prompt is synthesizable, has no audio ref', () => {
    expect(promptText(textPrompt)).toBe(textPrompt);
    expect(promptAudio(textPrompt)).toBeNull();
  });

  it('an audio prompt is a clip, never synthesizable — even with a transcript', () => {
    expect(promptText(audioWithText)).toBeNull();
    expect(promptAudio(audioWithText)).toBe('vprompt_ab12cd34');
    expect(promptText(audioWithoutText)).toBeNull();
    expect(promptAudio(audioWithoutText)).toBe('vprompt_ff00ee11');
  });
});

describe('promptTranscript (display / trace text)', () => {
  it('a text prompt is its own transcript', () => {
    expect(promptTranscript(textPrompt)).toBe(textPrompt);
  });

  it('an audio prompt surfaces the text it was synthesized from', () => {
    expect(promptTranscript(audioWithText)).toBe(
      'We are open Tuesday to Sunday, eleven to ten.',
    );
  });

  it('is null when an audio prompt carries no transcript', () => {
    expect(promptTranscript(audioWithoutText)).toBeNull();
  });
});
