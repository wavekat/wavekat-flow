// JSON-Schema structural validation — kept OUT of the package barrel.
//
// Ajv compiles a schema by *generating JavaScript source and `new
// Function`-ing it* into a validator (its whole speed model is JIT). Any
// runtime that disallows code-generation-from-strings — notably the
// Cloudflare Workers isolate the platform API runs on — throws
// `EvalError: Code generation from strings disallowed` the moment this
// module is evaluated. Because the compile happens at import time, merely
// importing the barrel used to crash such consumers at startup even when
// they never called `validateStructure`.
//
// So this lives behind the `@wavekat/flow-schema/structure` subpath: the
// main entry (`.`) stays pure hand-written code with no Ajv in its module
// graph, and only Node-side consumers that actually want meta-schema
// structural validation opt into the Ajv dependency. This subpath is NOT
// safe to import from a Workers/edge bundle.

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { flowV1Schema, flowV2Schema } from './generated/schema.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });

// One compiled validator per format version. Each schema file describes
// exactly one version and pins `schema_version` with a `const`, so the
// document itself says which one it must satisfy — there is no "try them
// all and take the best" here, deliberately: a v1 document that happens
// to also satisfy v2 is still a v1 document, and a v1 document carrying
// a v2-only component must fail rather than quietly pass under the newer
// rules.
const validators = new Map<number, ValidateFunction>([
  [1, ajv.compile(flowV1Schema)],
  [2, ajv.compile(flowV2Schema)],
]);

export type StructuralResult =
  | { valid: true }
  | { valid: false; errors: ErrorObject[] };

/** The format versions this build can structurally validate, ascending. */
export const STRUCTURAL_SCHEMA_VERSIONS: readonly number[] = [...validators.keys()].sort(
  (a, b) => a - b,
);

/**
 * Validate an already-parsed document against the normative JSON Schema
 * for the version it declares (structure only — no reachability /
 * exit-wiring / hours semantics; use `checkFlow` / `validateFlow` for
 * those).
 *
 * A document declaring a version this build has no schema for is
 * invalid, reported the same way Ajv reports a failed `const` — the
 * caller wants "this doesn't validate", not an exception.
 *
 * Node-side only — see the module header on Workers incompatibility.
 */
export function validateStructure(doc: unknown): StructuralResult {
  const declared = (doc as { schema_version?: unknown } | null | undefined)?.schema_version;
  const validateFn = typeof declared === 'number' ? validators.get(declared) : undefined;
  if (!validateFn) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/schema_version',
          schemaPath: '#/properties/schema_version',
          keyword: 'enum',
          params: { allowedValues: STRUCTURAL_SCHEMA_VERSIONS },
          message: `schema_version must be one of: ${STRUCTURAL_SCHEMA_VERSIONS.join(', ')}`,
        },
      ],
    };
  }
  const valid = validateFn(doc);
  return valid ? { valid: true } : { valid: false, errors: validateFn.errors ?? [] };
}
