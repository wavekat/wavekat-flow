// The TypeScript half of the shared conformance corpus. Every case in
// conformance/vN/{valid,invalid} is validated against the normative JSON
// Schema; its `structurallyValid` expectation must hold. The Rust crate
// runs the SAME corpus (crates/wavekat-flow/tests/conformance.rs), so a
// change that would break one language's acceptance set fails CI in the
// other too — this is the cross-language contract that replaces the old
// hand-ported test suites.
//
// One directory per format version. A case lives under the version its
// document *declares*, not the version that can read it: the v1 case
// that uses a `book` node belongs to v1, because what it pins is how a
// version-1 document is treated.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { checkFlow } from '../src/index.js';
import { validateStructure } from '../src/structure.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = resolve(here, '..', '..', '..', 'conformance');

/** Every `vN` directory present, so a new version's cases run the moment
 * the directory exists rather than when someone remembers this list. */
const CORPUS_VERSIONS = readdirSync(corpusRoot)
  .filter((entry) => /^v\d+$/.test(entry))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

type Expectation = {
  description: string;
  structurallyValid: boolean;
  semantic: { ok: boolean; errors: string[] };
  /** TS-only, optional: non-blocking warning codes this case must surface —
   * the deliberate cross-language divergence (unknown fields warn in TS,
   * are silently ignored by Rust serde; both still accept the document). */
  tsWarnings?: string[];
};

function casesIn(version: string, bucket: 'valid' | 'invalid'): string[] {
  const dir = resolve(corpusRoot, version, bucket);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length));
}

function source(version: string, bucket: string, name: string): string {
  return readFileSync(resolve(corpusRoot, version, bucket, `${name}.yaml`), 'utf8');
}

function expectation(version: string, bucket: string, name: string): Expectation {
  return JSON.parse(
    readFileSync(resolve(corpusRoot, version, bucket, `${name}.expected.json`), 'utf8'),
  ) as Expectation;
}

describe.each(CORPUS_VERSIONS)('conformance corpus %s — structural (JSON Schema)', (version) => {
  for (const bucket of ['valid', 'invalid'] as const) {
    for (const name of casesIn(version, bucket)) {
      it(`${bucket}/${name}`, () => {
        const doc = parse(source(version, bucket, name));
        const expected = expectation(version, bucket, name);
        const result = validateStructure(doc);
        expect(result.valid).toBe(expected.structurallyValid);
      });
    }
  }
});

// The semantic half: the full `checkFlow` gate (safe-subset parse + decode +
// validate) run over the raw YAML, asserted against each case's `semantic`
// expectation. The Rust crate runs the SAME corpus (Phase 2 step 4), so the
// two validators cannot disagree on acceptance.
//
// `errors` lists a case's *characteristic* codes, not its exhaustive set — a
// single defect can cascade (a dangling exit also traps the caller). So the
// contract is: overall acceptance matches (`valid === semantic.ok`), and every
// listed code is reported (subset), never exact-set equality — which would
// force the frozen corpus to enumerate incidental cascade errors.
describe.each(CORPUS_VERSIONS)('conformance corpus %s — semantic (checkFlow)', (version) => {
  for (const bucket of ['valid', 'invalid'] as const) {
    for (const name of casesIn(version, bucket)) {
      it(`${bucket}/${name}`, () => {
        const expected = expectation(version, bucket, name);
        const result = checkFlow(source(version, bucket, name));
        expect(result.valid).toBe(expected.semantic.ok);
        const reported = new Set(result.issues.map((issue) => issue.code));
        for (const code of expected.semantic.errors) {
          expect(reported, `expected semantic error "${code}" for ${bucket}/${name}`).toContain(
            code,
          );
        }
        // The TS-only divergence: non-blocking warnings the case must surface.
        const warnings = new Set(
          result.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
        );
        for (const code of expected.tsWarnings ?? []) {
          expect(warnings, `expected TS warning "${code}" for ${bucket}/${name}`).toContain(code);
        }
      });
    }
  }
});
