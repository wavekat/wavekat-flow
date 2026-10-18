//! Older readers must keep reading newer documents. A daemon built from an
//! older crate parses whatever the platform writes today, so the schema must
//! never close an object to unknown keys: no `additionalProperties: false`
//! and no `unevaluatedProperties: false` anywhere. The generated serde types
//! follow the schema (typify emits `deny_unknown_fields` for exactly that),
//! so this one check covers the Rust model too. The TS package has the same
//! test (packages/flow-schema/test/tolerance.test.ts).
//!
//! There is no intentional exception: the opaque `ui` block is simply
//! unconstrained, and the `additionalProperties` that do exist are
//! sub-schemas (node map, option labels), not `false`.

use serde_json::Value;

fn closed_objects(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for key in ["additionalProperties", "unevaluatedProperties"] {
                if map.get(key) == Some(&Value::Bool(false)) {
                    out.push(format!("{path}/{key}"));
                }
            }
            for (k, v) in map {
                closed_objects(v, &format!("{path}/{k}"), out);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                closed_objects(v, &format!("{path}/{i}"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn no_schema_version_closes_an_object_to_unknown_keys() {
    for version in wavekat_flow::SUPPORTED_SCHEMA_VERSIONS {
        let schema: Value =
            serde_json::from_str(wavekat_flow::flow_schema(*version).expect("schema")).unwrap();
        let mut closed = Vec::new();
        closed_objects(&schema, "", &mut closed);
        assert!(
            closed.is_empty(),
            "schema v{version} closes objects to unknown keys, which would break older readers \
             of newer documents: {closed:?}"
        );
    }
}
