<p align="center">
  <a href="https://github.com/wavekat/wavekat-flow">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-flow-narrow.svg" alt="WaveKat Flow">
  </a>
</p>

[![Crates.io](https://img.shields.io/crates/v/wavekat-flow.svg)](https://crates.io/crates/wavekat-flow)
[![docs.rs](https://docs.rs/wavekat-flow/badge.svg)](https://docs.rs/wavekat-flow)

The call-flow ("Receptionist") document model for the
[WaveKat](https://wavekat.com) voice platform: the declarative IVR document —
greeting, hours check, menu, voicemail, transfer, phone booking — that WaveKat voice lines
run.

The model types are **generated at build time** from the normative JSON
Schema (`schema/flow.vN.schema.json`), the single source of truth shared with
the [`@wavekat/flow-schema`](https://www.npmjs.com/package/@wavekat/flow-schema)
npm package. Both languages run the same
[conformance corpus](https://github.com/wavekat/wavekat-flow/tree/main/conformance),
so a document means the identical thing to the TypeScript authoring side and
this crate.

> [!WARNING]
> Early development (`0.0.x`). API may change between releases.

## What's inside

| Module | What it does |
|--------|--------------|
| `model` (re-exported at root) | Generated document types (`Flow`, `Node`, `Prompt`, …) plus hand-written helpers (`Flow::from_yaml`, `Node::exits`, …) |
| `validate` | Semantic validation: reachability, caller traps, exit-set exactness, DTMF and prompt rules |
| `hours` | Business-hours / timezone math (IANA zones, holiday exceptions) |
| `engine` | The flow interpreter + the `FlowEffects` async trait your runtime implements |
| `trace` | Serializable run traces emitted by the engine |
| `FLOW_V1_SCHEMA` | The normative JSON Schema, bundled as a string for structural validation |

## Quick start

```sh
cargo add wavekat-flow
```

```rust
use wavekat_flow::{validate, Flow};

let flow = Flow::from_yaml(
    r#"
schema_version: 1
id: flow_min
name: Minimal greeting then hangup
entry: hello
nodes:
  hello:
    kind: greeting
    prompt: Hi there.
    exits: { next: bye }
  bye:
    kind: hangup
    prompt: Goodbye.
"#,
)?;

if let Err(errors) = validate::validate(&flow) {
    for e in &errors {
        eprintln!("{}: {e}", e.code());
    }
}
```

## Upgrading when the booking grid moves

`BOOK_GRANULARITY_MINS` decides which times a `book` node can ever say, so
changing it changes what `vocabulary_refs` — and therefore
`required_assets` — returns for a node nobody edited.

This crate is where a device answers that question, from the constant
compiled into it rather than from anything the flow document carries, and a
device refuses to arm a flow whose required assets aren't all on disk. So a
device left on an older grid, handed a version published by an authoring
side that already narrowed, asks for a clip that was never rendered and
stops running the whole flow — not just its booking step.

Take this crate's upgrade **before** the authoring side takes the matching
`@wavekat/flow-schema`. Narrowing leaves the published set a superset in the
meantime, which is the safe direction.

## One format, two languages

This crate is the Rust half of the format. Authoring, comment-preserving
edits, and the TypeScript twin of the validator live in
[`@wavekat/flow-schema`](https://www.npmjs.com/package/@wavekat/flow-schema).
The schema, the shared conformance corpus, and the full design rationale live
in the [`wavekat-flow` repository](https://github.com/wavekat/wavekat-flow).

## License

Licensed under [Apache 2.0](https://github.com/wavekat/wavekat-flow/blob/main/LICENSE).

Copyright 2026 WaveKat.
