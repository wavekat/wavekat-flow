// The TypeScript half of the shared conformance corpus. Every case in
// conformance/v1/{valid,invalid} is validated against the normative JSON
// Schema; its `structurallyValid` expectation must hold. The Rust crate
// runs the SAME corpus (crates/wavekat-flow/tests/conformance.rs), so a
// change that would break one language's acceptance set fails CI in the
// other too — this is the cross-language contract that replaces the old
// hand-ported test suites.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { validateStructure } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = resolve(here, '..', '..', '..', 'conformance', 'v1');

type Expectation = {
  description: string;
  structurallyValid: boolean;
  semantic: { ok: boolean; errors: string[] };
};

function casesIn(bucket: 'valid' | 'invalid'): string[] {
  const dir = resolve(corpusRoot, bucket);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length));
}

function load(bucket: string, name: string): { doc: unknown; expected: Expectation } {
  const dir = resolve(corpusRoot, bucket);
  const doc = parse(readFileSync(resolve(dir, `${name}.yaml`), 'utf8'));
  const expected = JSON.parse(
    readFileSync(resolve(dir, `${name}.expected.json`), 'utf8'),
  ) as Expectation;
  return { doc, expected };
}

describe('conformance corpus v1 — structural (JSON Schema)', () => {
  for (const bucket of ['valid', 'invalid'] as const) {
    for (const name of casesIn(bucket)) {
      it(`${bucket}/${name}`, () => {
        const { doc, expected } = load(bucket, name);
        const result = validateStructure(doc);
        expect(result.valid).toBe(expected.structurallyValid);
      });
    }
  }
});
