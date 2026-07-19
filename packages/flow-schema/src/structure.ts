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
import type { ErrorObject } from 'ajv';

import schema from './generated/schema.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile(schema);

export type StructuralResult =
  | { valid: true }
  | { valid: false; errors: ErrorObject[] };

/**
 * Validate an already-parsed document against the normative JSON Schema
 * (structure only — no reachability / exit-wiring / hours semantics; use
 * `checkFlow` / `validateFlow` for those).
 *
 * Node-side only — see the module header on Workers incompatibility.
 */
export function validateStructure(doc: unknown): StructuralResult {
  const valid = validateFn(doc);
  return valid ? { valid: true } : { valid: false, errors: validateFn.errors ?? [] };
}
