//! The Rust half of the shared conformance corpus. Every case in
//! `conformance/v1/{valid,invalid}` is validated against the normative
//! JSON Schema with a real draft-2020-12 validator (mirroring the TS
//! side's ajv), so `structurallyValid` means the identical thing in both
//! languages. Valid cases are additionally deserialized into the
//! schema-generated model, proving the generated types accept real
//! documents. The TS package runs the SAME corpus
//! (packages/flow-schema/test/conformance.test.ts).

use std::{fs, path::PathBuf};

#[derive(serde::Deserialize)]
struct Expectation {
    #[serde(rename = "structurallyValid")]
    structurally_valid: bool,
}

fn corpus_dir(bucket: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/v1")
        .join(bucket)
}

fn yaml_cases(bucket: &str) -> Vec<(String, PathBuf)> {
    let dir = corpus_dir(bucket);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("read corpus dir") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
            let stem = path.file_stem().unwrap().to_str().unwrap().to_string();
            out.push((stem, path));
        }
    }
    out
}

#[test]
fn corpus_structural_matches_expectations() {
    let schema: serde_json::Value =
        serde_json::from_str(wavekat_flow::FLOW_V1_SCHEMA).expect("schema json");
    let validator = jsonschema::validator_for(&schema).expect("compile schema");

    for bucket in ["valid", "invalid"] {
        for (stem, path) in yaml_cases(bucket) {
            let doc: serde_json::Value =
                serde_yaml_ng::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let exp_path = corpus_dir(bucket).join(format!("{stem}.expected.json"));
            let exp: Expectation =
                serde_json::from_str(&fs::read_to_string(exp_path).unwrap()).unwrap();
            assert_eq!(
                validator.is_valid(&doc),
                exp.structurally_valid,
                "structural verdict mismatch for {bucket}/{stem}"
            );
        }
    }
}

#[test]
fn valid_corpus_deserializes_into_generated_model() {
    for (stem, path) in yaml_cases("valid") {
        let yaml = fs::read_to_string(&path).unwrap();
        serde_yaml_ng::from_str::<wavekat_flow::model::Flow>(&yaml)
            .unwrap_or_else(|e| panic!("valid corpus '{stem}' should deserialize into Flow: {e}"));
    }
}
