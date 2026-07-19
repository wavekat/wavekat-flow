// @wavekat/flow-schema — public surface.
//
// The generated model types (from the normative JSON Schema) plus the
// hand-written authoring logic consolidated here in Phase 2: safe-subset
// YAML parsing/decoding, semantic validation (reachability, exit wiring,
// hours math, DTMF/prompt rules), and the one-call `checkFlow` gate. The
// model *helpers* (`requiredExits`, `isTerminal`, …) are hand-written
// twins layered on the generated types — logic, not shape (see
// `src/model.ts`). Import paths are kept identical to the platform's
// in-repo copy so the Phase 3 swap is a dependency change, not a code
// change.
//
// Still living in the consumer repos (later Phase 2 steps): comment-
// preserving `mutate.ts` (TS-only) and the Rust engine.

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

import schema from './generated/flow.v1.schema.json' with { type: 'json' };

// Model: generated types + hand-written constants & helpers.
export * from './model.js';
export { schema as flowV1Schema };

// Issues, parsing, validation, and the combined gate.
export type { Issue } from './issues.js';
export { MISSING_ASSET, hasErrors } from './issues.js';
export type { ParseResult } from './parse.js';
export { parseFlow } from './parse.js';
export { validateFlow } from './validate.js';
export type { FlowCheck } from './check.js';
export { checkFlow } from './check.js';
export { isValidDate, isValidTimezone, parseTimeMinutes, validateHours } from './hours.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile(schema);

export type StructuralResult =
  | { valid: true }
  | { valid: false; errors: ErrorObject[] };

/**
 * Validate an already-parsed document against the normative JSON Schema
 * (structure only — no reachability / exit-wiring / hours semantics; use
 * `checkFlow` / `validateFlow` for those).
 */
export function validateStructure(doc: unknown): StructuralResult {
  const valid = validateFn(doc);
  return valid ? { valid: true } : { valid: false, errors: validateFn.errors ?? [] };
}
