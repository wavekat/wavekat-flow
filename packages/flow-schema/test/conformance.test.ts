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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  checkFlow,
  fill,
  hasErrors,
  parseFlow,
  requiredAssets,
  serializeFlow,
  validateOutbound,
} from '../src/index.js';
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
  /** Optional: the exact asset set the daemon must have on disk before it
   * will arm this flow. See the describe block below for why it is pinned
   * here rather than in either language's own tests. */
  requiredAssets?: string[];
};

function casesIn(version: string, bucket: string): string[] {
  const dir = resolve(corpusRoot, version, bucket);
  // A version may have no cases in a bucket yet; a missing directory is empty.
  if (!existsSync(dir)) return [];
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

// The asset set, pinned across both languages.
//
// This is the one place a `book` node's vocabulary arithmetic is checked
// against something outside the language that computed it. Both sides
// derive the set from their own copy of `BOOK_GRANULARITY_MINS`, and a
// daemon refuses to arm a flow whose required assets are not all on disk
// — so if the two constants ever drift, the symptom is not a failing
// test but a customer's phone line going quiet, on the devices that
// happened to update late.
//
// Exact-set equality, unlike the error expectations above: this set is
// the contract itself, not a description of one, and a missing member is
// exactly the bug worth catching.
// Only cases that pin a set: an `invalid` document has no assets to
// speak of, and a flow with no `book` node has nothing that could drift.
// Collected before `describe`, because a version whose corpus pins
// nothing must produce no suite rather than an empty one.
const ASSET_CASES = CORPUS_VERSIONS.map((version) => ({
  version,
  cases: (['valid', 'invalid'] as const).flatMap((bucket) =>
    casesIn(version, bucket)
      .map((name) => ({ bucket, name, expected: expectation(version, bucket, name) }))
      .filter((entry) => entry.expected.requiredAssets !== undefined),
  ),
})).filter((entry) => entry.cases.length > 0);

describe.each(ASSET_CASES)('conformance corpus $version — required assets', ({ cases, version }) => {
  for (const { bucket, name, expected } of cases) {
    it(`${bucket}/${name}`, () => {
      const result = checkFlow(source(version, bucket, name));
      expect(result.flow, `${bucket}/${name} must parse to pin its assets`).toBeDefined();
      expect(requiredAssets(result.flow!)).toEqual(expected.requiredAssets);
    });
  }
});

// The outbound profile: `conformance/vN/outbound/{valid,invalid}`, run
// through `validateOutbound` (which includes the base validation) with the
// same subset contract as the semantic corpus above. Kept out of the
// top-level `valid/`/`invalid/` buckets on purpose: a flow refused for
// outbound — a `ring` step, say — is a perfectly good inbound flow. The
// Rust crate runs the same cases through `validate_outbound`.
const OUTBOUND_CASES = CORPUS_VERSIONS.flatMap((version) =>
  (['valid', 'invalid'] as const).flatMap((bucket) => {
    const dir = resolve(corpusRoot, version, 'outbound', bucket);
    if (!existsSync(dir)) return [];
    return casesIn(version, `outbound/${bucket}`).map((name) => ({
      version,
      bucket: `outbound/${bucket}`,
      name,
    }));
  }),
);

describe('conformance corpus — outbound (validateOutbound)', () => {
  it('has cases', () => {
    expect(OUTBOUND_CASES.length).toBeGreaterThan(0);
  });

  for (const { version, bucket, name } of OUTBOUND_CASES) {
    it(`${version}/${bucket}/${name}`, () => {
      const src = source(version, bucket, name);
      const expected = expectation(version, bucket, name);
      expect(validateStructure(parse(src)).valid).toBe(expected.structurallyValid);

      const parsed = parseFlow(src);
      const issues = [...parsed.issues];
      if (parsed.flow) issues.push(...validateOutbound(parsed.flow, parsed.nodeRanges));
      expect(!hasErrors(issues), JSON.stringify(issues.map((i) => i.code))).toBe(
        expected.semantic.ok,
      );
      const reported = new Set(issues.map((issue) => issue.code));
      for (const code of expected.semantic.errors) {
        expect(reported, `expected outbound error "${code}" for ${bucket}/${name}`).toContain(code);
      }
    });
  }
});

// The fill corpus: `conformance/fill/<case>.input.yaml` + `<case>.values.json`
// run through `fill`. A success case has `<case>.expected.yaml`, compared with
// the filled flow after canonical serialization; a refusal has
// `<case>.expected.json` = `{"errors": [codes]}` (exact list, in order). The
// Rust crate runs the same cases (`corpus_fill_matches_expectations`).
const FILL_DIR = resolve(corpusRoot, 'fill');
const FILL_CASES = readdirSync(FILL_DIR)
  .filter((f) => f.endsWith('.input.yaml'))
  .map((f) => f.slice(0, -'.input.yaml'.length))
  .sort();

function decode(src: string, label: string) {
  const { flow, issues } = parseFlow(src);
  if (!flow) throw new Error(`${label}: ${JSON.stringify(issues)}`);
  return flow;
}

describe('conformance corpus — fill', () => {
  it('has cases', () => {
    expect(FILL_CASES.length).toBeGreaterThan(0);
  });

  for (const name of FILL_CASES) {
    it(name, () => {
      const read = (ext: string) => readFileSync(resolve(FILL_DIR, `${name}.${ext}`), 'utf8');
      const flow = decode(read('input.yaml'), name);
      const values = JSON.parse(read('values.json')) as Record<string, string>;
      const result = fill(flow, values);
      if (existsSync(resolve(FILL_DIR, `${name}.expected.yaml`))) {
        if (!('flow' in result)) throw new Error(JSON.stringify(result.errors));
        const want = decode(read('expected.yaml'), name);
        expect(serializeFlow(result.flow)).toBe(serializeFlow(want));
      } else {
        const want = JSON.parse(read('expected.json')) as { errors: string[] };
        if (!('errors' in result)) throw new Error('expected fill to be refused');
        expect(result.errors.map((e) => e.code)).toEqual(want.errors);
      }
    });
  }
});
