// Rust half of "generate types from schema": at build time, read the
// normative JSON Schema (the single source of truth) and emit Rust model
// types with typify into OUT_DIR. `src/lib.rs` include!s the result, so
// the crate can never drift from the schema — there is no committed,
// hand-editable copy of the model.
//
// The schema is authored in JSON Schema draft 2020-12 (`$defs`, `$ref:
// #/$defs/...`). typify consumes the draft-07 shape (`definitions`), so
// we mechanically rewrite the dialect here before handing it over. This
// keeps ONE source file; the rewrite is deterministic and lossless for
// the constructs this schema uses.

use std::{env, fs, path::Path};

fn main() {
    // In the workspace, read the normative schema at the repo root and keep
    // the crate-local copy in sync (it is committed so the published crate
    // is self-contained — `cargo package` only ships files under the crate
    // root; CI fails if the copy is stale). In a packaged crate the root
    // schema doesn't exist, so build from the shipped copy.
    let workspace_schema = Path::new("../../schema/flow.v1.schema.json");
    let local_schema = Path::new("schema/flow.v1.schema.json");
    println!("cargo:rerun-if-changed=../../schema/flow.v1.schema.json");
    println!("cargo:rerun-if-changed=schema/flow.v1.schema.json");
    println!("cargo:rerun-if-changed=build.rs");

    let raw = if workspace_schema.exists() {
        let raw = fs::read_to_string(workspace_schema).expect("read schema");
        if fs::read_to_string(local_schema).ok().as_deref() != Some(raw.as_str()) {
            fs::create_dir_all("schema").expect("create crate-local schema dir");
            fs::write(local_schema, &raw).expect("sync crate-local schema copy");
        }
        raw
    } else {
        fs::read_to_string(local_schema).expect("read crate-local schema copy")
    };
    let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse schema json");

    // draft 2020-12 -> the shape typify's schema reader expects.
    rewrite_defs(&mut value);
    // Make typify emit `Node` as an internally-tagged enum instead of an
    // `#[serde(untagged)]` one that mis-discriminates (a menu would
    // deserialize as a greeting). Two things are needed, both Rust-only —
    // the schema file itself keeps its clean `$defs` + `const` for TS's
    // json-schema-to-typescript and the ajv/jsonschema validators:
    //   1. typify's tagged-enum detection only inspects INLINE object
    //      subschemas (its `get_object` returns None for a bare `$ref`), so
    //      inline the per-node definitions into `Node`'s `oneOf`.
    //   2. detection keys off a single-valued `enum` discriminant, not a
    //      `const`, so rewrite each inlined branch's `kind` accordingly.
    // Scoped to the node `kind` on purpose: a blanket const->enum rewrite
    // would also turn the top-level `schema_version: { const: 1 }` into a
    // constrained newtype, which the validator wants to stay a plain integer.
    inline_node_variants(&mut value);

    let schema: schemars::schema::RootSchema =
        serde_json::from_value(value).expect("schema into RootSchema");

    let mut type_space =
        typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    type_space
        .add_root_schema(schema)
        .expect("typify add_root_schema");

    let tokens = type_space.to_stream();
    let formatted = prettyplease::unparse(&syn::parse2::<syn::File>(tokens).expect("parse tokens"));

    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("flow_types.rs");
    fs::write(out, formatted).expect("write generated types");
}

/// Inline `definitions.Node.oneOf`'s `$ref` branches with the referenced
/// definition bodies, then drop those now-unused definitions. Runs after the
/// `$defs` rewrite, so refs are `#/definitions/<Name>`.
fn inline_node_variants(v: &mut serde_json::Value) {
    let Some(defs) = v.get("definitions").and_then(|d| d.as_object()).cloned() else {
        return;
    };
    let Some(one_of) = v
        .get("definitions")
        .and_then(|d| d.get("Node"))
        .and_then(|n| n.get("oneOf"))
        .and_then(|o| o.as_array())
        .cloned()
    else {
        return;
    };

    let mut consumed: Vec<String> = Vec::new();
    let mut inlined: Vec<serde_json::Value> = Vec::new();
    for branch in &one_of {
        match branch.get("$ref").and_then(|r| r.as_str()) {
            Some(r) => {
                let name = r
                    .strip_prefix("#/definitions/")
                    .expect("node variant ref shape");
                let mut body = defs
                    .get(name)
                    .unwrap_or_else(|| panic!("missing node definition {name}"))
                    .clone();
                rewrite_kind_const_to_enum(&mut body);
                consumed.push(name.to_string());
                inlined.push(body);
            }
            // Already inline — leave as-is.
            None => inlined.push(branch.clone()),
        }
    }

    let defs_mut = v
        .get_mut("definitions")
        .and_then(|d| d.as_object_mut())
        .expect("definitions object");
    defs_mut
        .get_mut("Node")
        .and_then(|n| n.as_object_mut())
        .expect("Node object")
        .insert("oneOf".to_string(), serde_json::Value::Array(inlined));
    for name in consumed {
        defs_mut.remove(&name);
    }
}

/// In a node definition body, rewrite `properties.kind: { "const": X }` into
/// `{ "enum": [X] }` so typify's tagged-enum detection fires on `kind`.
fn rewrite_kind_const_to_enum(body: &mut serde_json::Value) {
    let Some(kind) = body
        .get_mut("properties")
        .and_then(|p| p.get_mut("kind"))
        .and_then(|k| k.as_object_mut())
    else {
        return;
    };
    if !kind.contains_key("enum") {
        if let Some(c) = kind.remove("const") {
            kind.insert("enum".to_string(), serde_json::Value::Array(vec![c]));
        }
    }
}

/// Rename `$defs` -> `definitions` and rewrite `$ref` pointers, recursively.
fn rewrite_defs(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(defs) = map.remove("$defs") {
                map.insert("definitions".to_string(), defs);
            }
            if let Some(serde_json::Value::String(r)) = map.get_mut("$ref") {
                if let Some(rest) = r.strip_prefix("#/$defs/") {
                    *r = format!("#/definitions/{rest}");
                }
            }
            for (_k, child) in map.iter_mut() {
                rewrite_defs(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                rewrite_defs(item);
            }
        }
        _ => {}
    }
}
