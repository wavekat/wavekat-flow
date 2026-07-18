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
    let schema_path = Path::new("../../schema/flow.v1.schema.json");
    println!("cargo:rerun-if-changed=../../schema/flow.v1.schema.json");
    println!("cargo:rerun-if-changed=build.rs");

    let raw = fs::read_to_string(schema_path).expect("read schema");
    let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse schema json");

    // draft 2020-12 -> the shape typify's schema reader expects.
    rewrite_defs(&mut value);

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
