# 01 — The document is the whole truth

Status: **proposal**

## Problem

A flow document is YAML text, and the text is meant to be the single source
of truth. Today, though, part of what authors care about lives *outside* the
model: YAML comments, and the order nodes are written in. So no tool can
edit a document by doing the obvious thing (parse it, change the model,
write it back), because writing it back loses that information:

- **Comments are dropped.** They aren't in the model.
- **Node order is scrambled** in Rust: the generated `Flow.nodes` is a
  `HashMap`.
- **Formatting differs per language.** `serde_yaml_ng` and the TS `yaml`
  library each choose their own quoting and layout, so the same flow saved
  by two tools produces two different texts.

The workarounds edit the source text instead: `mutate.ts` goes through the
`yaml` CST, and Rust authoring tools have started splicing text at parser
positions. That is complex logic in every consumer, it can only be done
well in languages that have a lossless YAML editor (Rust doesn't), and it
still leaves meaning in comments that no tool can read.

## Decision

Everything worth keeping is **data in the model**, and there is **one
canonical text** for any model. Then every edit, in every language, is:

```
parse → change the model → serialize
```

and nothing is lost, because nothing lives outside the model.

### 1. Notes are fields, not comments

Add an optional `note` (string) to every node kind, and to the flow itself.
It's the author's free-text annotation: why this menu has a fifth option,
who recorded the greeting. The engine never reads it.

```yaml
nodes:
  menu:
    kind: menu
    note: Option 5 is for the spring promo; remove after May.
    prompt: Press 1 for sales, 5 for the spring offer.
```

Canvas layout already has its home: `ui` ("canvas positions, annotations…
never read by the engine"). Notes go in `note`, not `ui`, because people
write them by hand in the YAML; `ui` is for what an editor draws.

**Compatibility.** Node schemas don't set `additionalProperties: false`, so
older readers already accept an unknown `note` (Rust ignores it; TS warns
`unknown_field`). Adding an optional field the engine ignores is therefore a
compatible change: it goes into **v1 and v2** without a version bump, and
`requiredSchemaVersion` doesn't change. No frozen corpus case uses `note`.
New cases are added; none change.

### 2. YAML comments carry no meaning

A comment is not part of the document. The parser reports each one as a
warning (`comment_ignored`, with its position) so a hand-written file still
loads, and the author is told the next save will drop it, and that the
words belong in `note`. Saving writes the canonical text, which has no
comments.

### 3. Order is data

Maps keep the order they're written in: `nodes` (the author's reading
order), menu `options`, `exits`. Rust gets this by generating every map as
`indexmap::IndexMap` (typify `TypeSpaceSettings::with_map_type`; parsing
already goes through `serde_yaml_ng::Value`, whose `Mapping` keeps order).
TS objects already keep insertion order for string keys.

`ui` is opaque JSON. In Rust it's `serde_json::Value`, whose maps sort keys
unless `serde_json`'s `preserve_order` feature is on; turn it on so `ui`
round-trips as written.

### 4. One canonical serialization, pinned by the corpus

`Flow::to_yaml()` (Rust) and `serializeFlow()` (TS) emit **byte-identical**
text for the same model. Both are hand-written emitters following the rules
below. Neither delegates layout to a YAML library, because the two
libraries don't agree.

- **Key order.** Top level: `schema_version, id, name, version, note,
  entry, nodes, ui`. In a node: `kind, note`, then the kind's fields in
  schema order, then `exits` last. Maps the author orders (`nodes`,
  `options`, `exits`, schedule entries, `ui`) keep document order.
- **Block style everywhere**, two-space indent. One exception: a `prompt`
  written as an audio mapping, an `exits` map and an `options` map are
  written in flow style on one line (`exits: { next: bye }`). That's how
  the documented examples and the web editor write them.
- **Absent optional fields are omitted**, never written as `null`.
- **Scalars.** A string is written plain when it matches a safe pattern,
  defined once in this doc and pinned by corpus cases: no leading or
  trailing space, no `: ` or ` #`, doesn't start with an indicator
  character, isn't a YAML 1.1 or 1.2 reserved word (`yes`, `no`, `on`,
  `off`, `true`, `false`, `null`, `~`), and doesn't look like a number. Any
  other string is double-quoted with JSON escapes. Menu digit keys
  (`'1'`) are always quoted, so implicit typing can't touch them. Numbers
  and booleans are written plain.
- **Multi-line strings** are double-quoted with `\n`. That's simple and
  identical in both languages. A literal block (`|`) reads better and is
  open question 2.
- The file ends with exactly one newline.

**Corpus.** A new `conformance/canonical/` holds pairs of
`<case>.input.yaml` and `<case>.canonical.yaml`. Both languages must:

1. serialize `parse(input)` to exactly `canonical`;
2. serialize `parse(canonical)` to `canonical` (a fixed point);
3. for every valid document in the rest of the corpus, satisfy
   `parse(serialize(parse(doc))) == parse(doc)` (nothing lost).

### 5. Editors edit the model

- **Rust** (the voice daemon never edits; authoring tools such as a CLI
  do): `Flow::from_yaml`, change the typed tree, `Flow::to_yaml`. This
  works offline and needs no YAML handling in the consumer. Helpers that
  encode format rules live in the crate, not the consumer:
  `is_generated_clip_ref` (twin of `isGeneratedClipRef`) and
  `prompt_fields(kind)`, kept in step with `Node::prompts()` by a corpus
  test.
- **TS**: `mutate.ts` keeps its public API (source in, source out,
  `EditResult`), so callers don't change. Inside, each op becomes
  `parseFlow → change → serializeFlow` instead of CST surgery. The `ui`
  fix-ups for rename and remove stay.
- **Unknown fields block a save.** A model round-trip drops fields the
  editor doesn't know, so an editor must refuse to save a document that
  has any. TS already finds them (`unknown_field`); Rust gains the same
  check. A document whose `schema_version` is newer than the editor
  supports is refused too, as today.

### 6. Migrating stored flows

Stored documents may have comments that matter. A one-time migration on
the platform, using the `yaml` CST, moves comments into notes:

- a comment on a node's key line, or directly above it, goes to that
  node's `note`;
- any other comment goes into the flow's `note`, in order.

It then saves the canonical text and reports what moved. The engine
ignores `note`, so behavior doesn't change. A flow already published is
re-published only if its owner edits it.

## Plan

1. Schema: `note` on the flow and on every node kind (v1 and v2).
   Regenerate the types. Add corpus cases.
2. Rust: `IndexMap` maps, `serde_json` `preserve_order`, the canonical
   `to_yaml`, the unknown-field check, `is_generated_clip_ref` and
   `prompt_fields`.
3. TS: `serializeFlow`, `comment_ignored`, and `mutate.ts` rebuilt on the
   model.
4. `conformance/canonical/`, run by both languages.
5. Consumers: the platform migrates its stored flows and adopts the new
   `mutate.ts`; Rust authoring tools edit through the model.

Steps 2 and 3 can proceed in parallel once step 1 lands. Step 4 gates the
release.

## Open questions

1. **Flow-level `note`.** Is the per-node `note` enough, or does the flow
   want one too? This doc assumes yes, so the migration has somewhere to
   put comments that belong to no node.
2. **Multi-line style.** Double-quoted `"line one\nline two"` (simple,
   proposed) or literal block `|` (nicer to read; trailing-newline
   handling has to be specified exactly).
3. **Flow-style exceptions.** Keep the three one-line forms (audio
   prompt, `exits`, `options`), or go block style everywhere for one rule
   with no exceptions.
