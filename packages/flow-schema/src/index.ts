// @wavekat/flow-schema — public surface.
//
// Phase 1 (this milestone): the generated model types + a structural
// validator driven by the normative JSON Schema. The hand-written
// authoring logic that the platform relies on today (safe-subset YAML
// parsing, comment-preserving mutation, semantic validation, hours math)
// moves in during Phase 2 (see repo README "Roadmap"); until then the
// platform keeps its in-repo copy. Import paths are kept identical so the
// Phase 3 swap is a dependency change, not a code change.

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

import schema from './generated/flow.v1.schema.json' with { type: 'json' };

export * from './generated/model.js';
export { schema as flowV1Schema };

/** Schema versions this package's schema describes. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile(schema);

export type StructuralResult =
  | { valid: true }
  | { valid: false; errors: ErrorObject[] };

/**
 * Validate an already-parsed document against the normative JSON Schema
 * (structure only — no reachability / exit-wiring / hours semantics;
 * those arrive with the validator in Phase 2).
 */
export function validateStructure(doc: unknown): StructuralResult {
  const valid = validateFn(doc);
  return valid ? { valid: true } : { valid: false, errors: validateFn.errors ?? [] };
}
