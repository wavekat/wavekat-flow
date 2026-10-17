# 01 — The document is the whole truth

Status: **accepted**. Implementation in progress (see [Consumers](#consumers)).

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

Add an optional `note` (string) to the flow and to every node kind. It's the
author's free-text annotation: why this menu has a fifth option, who
recorded the greeting. The engine never reads it.

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

A comment is not part of the document. Both languages report each one
(`comment_ignored`, a warning, with its line) so a hand-written file still
loads, and the author is told the next save will drop it, and that the
words belong in `note`. Saving writes the canonical text, which has no
comments. The corpus pins how many comments each case has, so the two
detectors agree.

### 3. Order is data

Maps keep the order they're written in: `nodes` (the author's reading
order), menu `options`, `exits`, and everything inside `ui`.

- Rust generates every map as `indexmap::IndexMap` (typify
  `TypeSpaceSettings::with_map_type`). Parsing already goes through
  `serde_yaml_ng::Value`, whose `Mapping` keeps order. `ui` is
  `serde_json::Value`, with `serde_json`'s `preserve_order` turned on.
- TS objects keep insertion order, **except** that keys which are
  canonical array indices (`"0"`, `"1"`, `"42"`, but not `"01"` or `"-1"`)
  always come first, in ascending numeric order. That's a JavaScript rule
  no TS model can avoid, so the canonical order adopts it everywhere: in
  every map the schema doesn't give a fixed order to, **integer keys come
  first in ascending order, then the other keys in document order**. Rust
  applies the same rule when it writes, so both languages agree. In
  practice it only touches menu digits (`"0"` sorts before `"1"`) and
  numeric node ids.

### 4. One canonical serialization, driven by the schema

`Flow::to_yaml()` (Rust) and `serializeFlow()` (TS) emit **byte-identical**
text for the same model. Both are small hand-written emitters guided by the
bundled newest schema. Neither delegates layout to a YAML library, because
the two libraries don't agree. The rules:

**Which keys, in which order.**
- The properties of an object the schema describes (the flow, a node of
  each kind, an audio prompt, a time range, a weekly schedule, an hours
  exception) are written in **schema property order**. The schema puts
  `note` right after `version` in the flow and right after `kind` in each
  node, and `exits` last.
- Other maps (`nodes`, `exits`, `options`, anything in `ui`) use the order
  rule in §3.
- An optional property is **omitted** when it's absent, when its value
  equals its schema `default` (`retries: 1`, `tone: beep`, `version: 1`),
  or when it's an empty map or list (`exits: {}`, `exceptions: []`, a
  weekday with no ranges). Both parsers fill in defaults, so this is what
  makes "the author left it out" and "the author wrote the default" the
  same document. A required property is always written, even when it's
  empty (`schedule: {}`).
- Nothing inside `ui` is omitted or reordered beyond §3. It's opaque.

**Layout.**
- The document and each node are block mappings, indented two spaces.
- Any other map or list (below a node, and inside `ui`) whose written
  entries, after the omissions above, are **all scalars** is written in
  flow style on one line:
  `exits: { next: bye }`, `options: { "1": Sales }`,
  `prompt: { audio: vprompt_a1, transcript: Hi }`,
  `- { open: "09:00", close: "17:00" }`, `welcome: [120, 40]`. An empty
  map or list is `{}` or `[]`. Anything else is block style, and a list
  item that is a block map starts on the `- ` line.
- The file ends with exactly one newline. No `---`, no comments.

**Scalars.**
- Integers are written plainly. Other numbers (only possible inside `ui`)
  are written the way JavaScript's `String(n)` writes them: shortest
  round-trip digits, with an exponent only at 1e21 and up or below 1e-6
  (`1e+21`, `1e-7`). Booleans are `true`/`false`, null is `null`.
- A string is written **plain** when all of the following hold. Otherwise
  it's **double-quoted**.
  - It isn't empty, and its first character is an ASCII letter, `_`, `/`,
    or any non-ASCII character.
  - It doesn't end with a space or `:`.
  - It contains no `: `, ` #`, tab, line break, or any character that
    needs an escape (below).
  - In flow style, it also contains none of `,` `[` `]` `{` `}` `:`. (libyaml,
    which Rust readers use, rejects a `:` inside a plain scalar there.)
  - Lowercased, it isn't `true`, `false`, `yes`, `no`, `on`, `off`, `y`,
    `n`, `null`, `inf`, `nan` or `infinity`. (YAML 1.1 readers still treat
    some of these as booleans or numbers.)
  
  Because the first character can't be a digit, sign or dot, nothing that
  looks like a number, date or time (`09:00`, `2026-12-25`) is ever plain.
  Menu digit keys are always quoted (`"1"`).
- A double-quoted string escapes `"` and `\` with a backslash, uses `\n`,
  `\t`, `\r`, `\b` and `\f` for those characters, and writes every other
  character below U+0020, U+007F to U+009F, U+2028, U+2029 and U+FEFF as
  `\uXXXX` (lowercase hex). Everything else is written as is. So
  multi-line text is one line, `"first\nsecond"`.

**Corpus.** A new `conformance/canonical/` holds, per case,
`<case>.input.yaml`, `<case>.canonical.yaml` and `<case>.expected.json`
(`{ "description", "comments": N }`). Both languages must:

1. serialize `parse(input)` to exactly `canonical`;
2. serialize `parse(canonical)` to `canonical` (a fixed point), and find no
   comments in it;
3. find exactly `comments` comments in `input`;
4. for every valid document in the rest of the corpus, satisfy
   `parse(serialize(parse(doc))) == parse(doc)` (nothing lost).

### 5. Editors edit the model

- **Rust** (the voice daemon never edits; authoring tools such as a CLI
  do): `Flow::from_yaml`, change the typed tree, `Flow::to_yaml`. This
  works offline and needs no YAML handling in the consumer. Format rules a
  tool needs live in the crate: `is_generated_clip_ref` (twin of
  `isGeneratedClipRef`), `is_local_audio_ref`, `prompt_fields(kind)` (kept
  in step with `Node::prompts()` by a corpus test), `Node::prompt_slots`
  and `prompt_slots_mut` (each prompt with the field it comes from, to
  read or change in place) and `edit::load` (below).
- **TS**: `mutate.ts` keeps its public API (source in, source out,
  `EditResult`), so callers don't change. Inside, each op is
  `parseFlow → change → serializeFlow` instead of CST surgery. A form edit
  therefore needs a document that **decodes**. Validation errors (a
  missing exit) are fine; a document with structural errors (a menu with
  no `options`) gets `invalid_document`, and the editor asks the author
  to fix the YAML first.
- **Unknown fields block a save.** A model round-trip drops fields the
  editor doesn't know, so an editor must refuse to save a document that
  has any (`unknown_field`). A document whose `schema_version` is newer
  than the editor supports is refused too. Rust's `edit::load(src)` does
  both checks and returns the flow plus the comments a save would drop;
  TS's `mutate.ts` ops refuse such a document.

### 6. Migrating stored flows

Stored documents may have comments that matter. A one-time migration on
the platform, using the `yaml` CST, moves comments into notes:

- a comment on a node's key line, or directly above it, or inside the
  node, goes to that node's `note`;
- any other comment goes into the flow's `note`, in order.

It then saves the canonical text and reports what moved. The engine
ignores `note`, so behavior doesn't change. A published version is
immutable and is left as it is; the migration rewrites drafts, and the
next publish carries the notes.

## Consumers

What each repository changes, in order. Rust consumers can build against
this repo's branch through a git dependency until the crate is released;
the platform waits for the npm release.

### 1. This repo

- Schema: `note` on the flow and on every node kind (v1 and v2); TS types
  regenerated; the Rust build generates `IndexMap` maps.
- Rust: `serde_json` `preserve_order`; the canonical `to_yaml`;
  `edit::load` (unknown fields, newer version, comments);
  `is_generated_clip_ref`, `is_local_audio_ref`, `prompt_fields`,
  `Node::prompt_slots` and `prompt_slots_mut`.
- TS: `serializeFlow`; `note` decoded; `comment_ignored`; `mutate.ts`
  rebuilt on the model with the `invalid_document` and `unknown_field`
  refusals.
- `conformance/canonical/`, run by both languages.
- `ROADMAP.md`: comment-preserving mutation is gone.
- Release both packages.

### 2. The platform (TS)

- **Web editor**: the inspector and prompt controls call the `mutate.ts`
  ops as before. The inspector gains a `note` field for each node. The
  YAML editor shows `comment_ignored`, and form edits show
  `invalid_document` as "fix the YAML first".
- **API**: identity stamping, schema-version restating, template forking
  and the system-flow audio seed script go through the same ops, so they
  write canonical text.
- **Migration**: the comment-to-note migration (§6) runs in the **same
  deploy** that adopts the new package. Otherwise editors save drafts
  before their comments have moved, and those comments are lost.
- **Templates and starters**: seeded YAML is rewritten in canonical form,
  with any comments moved into `note`.

### 3. The CLI (Rust)

- Flow commands depend on this crate. Voicing text prompts and replacing
  local audio paths are model edits followed by `Flow::to_yaml`, all
  offline, with no YAML handling of its own.
- It warns about `comment_ignored` and refuses `unknown_field`, from
  `edit::load`.
- Its docs say notes go in `note`.

### 4. The voice daemon (Rust)

- No behavior change: the engine ignores `note`.
- When it upgrades the crate: `flow.nodes` and `exits` become `IndexMap`
  (same `get`/`values`/`iter` API), and code that builds `Node` values
  directly adds `note: None`.
- The narrative format spec (doc 48) gains `note`, "comments carry no
  meaning", and a pointer to this doc for the canonical form.

## Resolved questions

1. **Flow-level `note`**: yes, so the migration has somewhere to put
   comments that belong to no node.
2. **Multi-line strings**: double-quoted with `\n`. One rule, identical in
   both languages; a literal block would need exact trailing-newline rules.
3. **Flow style**: one general rule (a collection of scalars below a node
   is one line) instead of a list of special cases. It produces the
   familiar `exits: { next: bye }` and keeps time ranges on one line.
