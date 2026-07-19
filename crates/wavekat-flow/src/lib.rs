//! `wavekat-flow` — the call-flow ("Receptionist") document model for the
//! WaveKat voice platform.
//!
//! The types in this crate are **generated at build time** from the
//! normative JSON Schema at `schema/flow.v1.schema.json` — the single
//! source of truth shared with the `@wavekat/flow-schema` npm package.
//! See `build.rs`.
//!
//! Phase 2 (this milestone) adds the semantic validator ([`validate`]), the
//! hours/timezone math ([`hours`]), and the interpreter ([`engine`] + its
//! [`trace`] output) alongside the generated model, adapted to the generated
//! types and pinned by the shared conformance corpus. The engine owns the
//! [`engine::FlowEffects`] trait *definition*; the daemon keeps its live impl
//! in its own codebase. Comment-preserving mutation stays TS-only.

/// The generated document model (`Flow`, `Node`, `Prompt`, …), emitted
/// from the schema by `typify` into `OUT_DIR/flow_types.rs`.
///
/// `Node` is an internally-tagged enum (`#[serde(tag = "kind")]`): the
/// `build.rs` schema normalization inlines the per-node `oneOf` branches
/// and rewrites the `kind` `const` to a single-valued `enum` so typify
/// discriminates on `kind` instead of emitting an `#[serde(untagged)]` enum
/// that would mis-deserialize (a menu as a greeting).
pub mod model {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/flow_types.rs"));
}

/// Hand-written helpers layered on the generated model (logic, not shape).
mod model_ext;

pub mod engine;
pub mod hours;
pub mod trace;
pub mod validate;

pub use model::*;
pub use model_ext::NodeId;

/// The normative JSON Schema (draft 2020-12) as a string, bundled so
/// consumers can run structural validation without reaching outside the
/// crate. The crate-local copy is synced from the repo-root schema by
/// `build.rs` (and is what ships in the published package).
pub const FLOW_V1_SCHEMA: &str = include_str!("../schema/flow.v1.schema.json");

/// Schema versions this crate's model describes. Twin:
/// `packages/flow-schema/src/model.ts` `SUPPORTED_SCHEMA_VERSIONS`.
pub const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1];
