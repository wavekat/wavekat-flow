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

pub mod book;
pub mod engine;
pub mod hours;
pub mod trace;
pub mod validate;

pub use model::*;
pub use model_ext::{required_assets, NodeId};

/// The normative JSON Schema (draft 2020-12) for format version 1, as a
/// string, bundled so consumers can run structural validation without
/// reaching outside the crate. The crate-local copies are synced from the
/// repo-root schemas by `build.rs` (and are what ship in the published
/// package).
pub const FLOW_V1_SCHEMA: &str = include_str!("../schema/flow.v1.schema.json");

/// Format version 2 — version 1 plus the `book` component. This is also
/// the file the model types are generated from, being the newest.
pub const FLOW_V2_SCHEMA: &str = include_str!("../schema/flow.v2.schema.json");

/// The schema for a declared version, or `None` if this build has none.
pub fn flow_schema(version: u32) -> Option<&'static str> {
    match version {
        1 => Some(FLOW_V1_SCHEMA),
        2 => Some(FLOW_V2_SCHEMA),
        _ => None,
    }
}

/// Schema versions this crate's model describes. Twin:
/// `packages/flow-schema/src/model.ts` `SUPPORTED_SCHEMA_VERSIONS`.
///
/// This is what a daemon advertises and the platform refuses to serve
/// past: a device that only knows version 1 must never be handed a
/// document that uses a component it has no code for.
pub const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1, 2];

/// The newest version this build authors. Reading stays broad
/// ([`SUPPORTED_SCHEMA_VERSIONS`]); writing is deliberately one number.
/// Twin: `model.ts` `CURRENT_SCHEMA_VERSION`.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;
