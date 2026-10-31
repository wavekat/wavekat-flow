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
//! in its own codebase. Documents are edited through the model:
//! [`Flow::from_yaml`], change the flow, [`Flow::to_yaml`] (the canonical
//! text, identical to the TS side's); [`edit::load`] refuses what a save
//! would lose.

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

/// The canonical serialization behind [`Flow::to_yaml`].
mod canonical;

pub mod book;
pub mod edit;
pub mod engine;
pub mod hours;
pub mod trace;
pub mod validate;

/// Re-exported so callers name the generated maps' type without a matching
/// `indexmap` dependency of their own.
pub use indexmap;
pub use model::*;
pub use model_ext::{
    is_generated_clip_ref, is_local_audio_ref, prompt_fields, required_assets, NodeId,
    PROMPT_FIELDS,
};

/// The normative JSON Schema (draft 2020-12) for format version 1, as a
/// string, bundled so consumers can run structural validation without
/// reaching outside the crate. The crate-local copies are synced from the
/// repo-root schemas by `build.rs` (and are what ship in the published
/// package).
pub const FLOW_V1_SCHEMA: &str = include_str!("../schema/flow.v1.schema.json");

/// Format version 2 — version 1 plus the `book` component.
pub const FLOW_V2_SCHEMA: &str = include_str!("../schema/flow.v2.schema.json");

/// Format version 3 — version 2 plus the screened transfer (`transfer`
/// gains `whisper` and `timeout_secs`). This is also the file the model
/// types are generated from, being the newest.
pub const FLOW_V3_SCHEMA: &str = include_str!("../schema/flow.v3.schema.json");

/// The schema for a declared version, or `None` if this build has none.
pub fn flow_schema(version: u32) -> Option<&'static str> {
    match version {
        1 => Some(FLOW_V1_SCHEMA),
        2 => Some(FLOW_V2_SCHEMA),
        3 => Some(FLOW_V3_SCHEMA),
        _ => None,
    }
}

/// Schema versions this crate's model describes. Twin:
/// `packages/flow-schema/src/model.ts` `SUPPORTED_SCHEMA_VERSIONS`.
///
/// This is what a daemon advertises and the platform refuses to serve
/// past: a device that only knows version 1 must never be handed a
/// document that uses a component it has no code for.
pub const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1, 2, 3];

/// The newest version this build authors. Reading stays broad
/// ([`SUPPORTED_SCHEMA_VERSIONS`]); writing is deliberately one number.
/// Twin: `model.ts` `CURRENT_SCHEMA_VERSION`.
pub const CURRENT_SCHEMA_VERSION: u32 = 3;
