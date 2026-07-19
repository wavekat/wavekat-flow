// @wavekat/flow-schema — public surface.
//
// The generated model types (from the normative JSON Schema) plus the
// hand-written authoring logic consolidated here in Phase 2: safe-subset
// YAML parsing/decoding, semantic validation (reachability, exit wiring,
// hours math, DTMF/prompt rules), the one-call `checkFlow` gate, and
// comment-preserving source edits (`mutate.ts`, TS-only — the daemon never
// edits). The model *helpers* (`requiredExits`, `isTerminal`, …) are
// hand-written twins layered on the generated types — logic, not shape
// (see `src/model.ts`). Import paths are kept identical to the platform's
// in-repo copy so the Phase 3 swap is a dependency change, not a code
// change.

// The schema as a generated TS module, not a JSON import: import
// attributes (`with { type: 'json' }`) don't survive every consumer
// bundler. The raw JSON is still shipped at the `./schema/v1` export.
//
// Note: Ajv-based structural validation (`validateStructure`) deliberately
// does NOT live here — it compiles a schema via runtime code generation,
// which crashes code-gen-disallowed runtimes (Cloudflare Workers) at
// import time. It lives behind the `@wavekat/flow-schema/structure`
// subpath so this barrel stays Ajv-free and safe to bundle on the edge.
import schema from './generated/schema.js';

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

// Comment-preserving source edits (TS-only).
export type { EditError, EditResult } from './mutate.js';
export {
  NODE_ID_PATTERN,
  addNode,
  clearNodePositions,
  defaultNode,
  nodePositions,
  removeExit,
  removeNode,
  renameNode,
  setEntry,
  setExit,
  setNodePosition,
  setNodeValue,
  stampIdentity,
} from './mutate.js';
