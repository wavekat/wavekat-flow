<p align="center">
  <a href="https://github.com/wavekat/wavekat-flow">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-flow-narrow.svg" alt="WaveKat Flow">
  </a>
</p>

[![npm](https://img.shields.io/npm/v/%40wavekat%2Fflow-schema.svg)](https://www.npmjs.com/package/@wavekat/flow-schema)

The call-flow ("Receptionist") document model for the
[WaveKat](https://wavekat.com) voice platform: the declarative IVR document —
greeting, hours check, menu, voicemail, transfer, phone booking — that WaveKat voice lines
run, authored as YAML.

The model types are **generated** from the normative JSON Schema
(`schema/flow.vN.schema.json`), the single source of truth shared with the
[`wavekat-flow`](https://crates.io/crates/wavekat-flow) Rust crate. Both
languages run the same
[conformance corpus](https://github.com/wavekat/wavekat-flow/tree/main/conformance),
so a document means the identical thing to this package and the Rust daemon
that executes it.

> [!WARNING]
> Early development (`0.0.x`). API may change between releases.

## What's inside

| Export | What it does |
|--------|--------------|
| `Flow`, `Node`, `Prompt`, … | Generated model types, plus hand-written helpers (`requiredExits`, `isTerminal`, `requiredAssets`, …) |
| `checkFlow` | The one-call gate: safe-subset YAML parse + semantic validation |
| `parseFlow` / `validateFlow` | The two halves of `checkFlow`, usable separately |
| `validateStructure` / `flowV1Schema` | Structural (JSON Schema) validation via `ajv`, and the bundled schema itself |
| `validateHours`, `isValidTimezone`, … | Business-hours / timezone checks |
| `addNode`, `setExit`, `renameNode`, … | Comment-preserving YAML source edits (TS-only — the Rust side never edits) |

## Quick start

```sh
pnpm add @wavekat/flow-schema
```

```ts
import { checkFlow } from '@wavekat/flow-schema';

const source = `
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
`;

const { flow, issues, valid, requiredAssets } = checkFlow(source);
if (!valid) {
  for (const issue of issues) console.error(`${issue.code}: ${issue.message}`);
}
```

Parsing rejects the YAML footguns (anchors/aliases, custom tags, duplicate
keys, implicit typing) and reports node-level source ranges for editor
diagnostics. Validation covers what a schema can't: reachability, caller
traps, exit-set exactness, hours math, DTMF and prompt rules.

## One format, two languages

This package is the TypeScript (authoring) half of the format. Parsing,
validation, and execution on live calls happen in the
[`wavekat-flow`](https://crates.io/crates/wavekat-flow) Rust crate. The
schema, the shared conformance corpus, and the full design rationale live in
the [`wavekat-flow` repository](https://github.com/wavekat/wavekat-flow).

## License

Licensed under [Apache 2.0](https://github.com/wavekat/wavekat-flow/blob/main/LICENSE).

Copyright 2026 WaveKat.
