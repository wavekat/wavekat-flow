//! `wavekat-flow` — the call-flow ("Receptionist") document model for the
//! WaveKat voice platform.
//!
//! The types in this crate are **generated at build time** from the
//! normative JSON Schema at `schema/flow.v1.schema.json` — the single
//! source of truth shared with the `@wavekat/flow-schema` npm package.
//! See `build.rs`.
//!
//! Phase 1 (this milestone) ships the generated document model only. The
//! semantic validator, hours/timezone math, and the interpreter/engine
//! move in during Phase 2 (see the repo README "Roadmap"); until then the
//! `wavekat-voice` daemon keeps its in-crate copy.

/// The generated document model (`Flow`, `Node`, `Prompt`, …), emitted
/// from the schema by `typify` into `OUT_DIR/flow_types.rs`.
pub mod model {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/flow_types.rs"));
}

pub use model::*;

/// The normative JSON Schema (draft 2020-12) as a string, bundled so
/// consumers can run structural validation without reaching outside the
/// crate.
pub const FLOW_V1_SCHEMA: &str = include_str!("../../../schema/flow.v1.schema.json");

/// Schema versions this crate's model describes.
pub const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1];
