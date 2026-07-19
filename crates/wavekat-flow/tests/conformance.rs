//! The Rust half of the shared conformance corpus. Every case in
//! `conformance/v1/{valid,invalid}` is validated against the normative
//! JSON Schema with a real draft-2020-12 validator (mirroring the TS
//! side's ajv), so `structurallyValid` means the identical thing in both
//! languages. Valid cases are additionally deserialized into the
//! schema-generated model, proving the generated types accept real
//! documents. The TS package runs the SAME corpus
//! (packages/flow-schema/test/conformance.test.ts).

use std::{fs, path::PathBuf};

use wavekat_flow::model::Flow;
use wavekat_flow::validate::validate;

#[derive(serde::Deserialize)]
struct Expectation {
    #[serde(rename = "structurallyValid")]
    structurally_valid: bool,
    semantic: Semantic,
}

#[derive(serde::Deserialize)]
struct Semantic {
    ok: bool,
    errors: Vec<String>,
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

/// Map a parse (serde) failure to the corpus's semantic code vocabulary. The
/// TypeScript side has a coded parser; here serde produces the rejection, and
/// its message names the cause. Only the codes the corpus exercises are
/// mapped; anything else falls back to `parse_error`.
fn parse_error_code(err: &serde_yaml_ng::Error) -> &'static str {
    let msg = err.to_string();
    if msg.contains("missing field") {
        "missing_field"
    } else if msg.contains("unknown variant") {
        "unknown_kind"
    } else {
        "parse_error"
    }
}

/// The full semantic gate over the raw YAML: parse (serde) + validate. Returns
/// `(accepted, reported_codes)`.
fn semantic_result(yaml: &str) -> (bool, Vec<String>) {
    match Flow::from_yaml(yaml) {
        Err(e) => (false, vec![parse_error_code(&e).to_string()]),
        Ok(flow) => match validate(&flow) {
            Ok(()) => (true, Vec::new()),
            Err(errs) => (false, errs.iter().map(|e| e.code().to_string()).collect()),
        },
    }
}

// The semantic half of the corpus: the full parse + validate gate, asserted
// against each case's `semantic` expectation. The TS package runs the SAME
// corpus (packages/flow-schema/test/conformance.test.ts), so the two
// validators cannot disagree on acceptance.
//
// `errors` lists a case's *characteristic* codes, not its exhaustive set — a
// single defect can cascade (a dangling exit also traps the caller). So the
// contract is: acceptance matches (`accepted == semantic.ok`), and every
// listed code is reported (subset), never exact-set equality — which would
// force the frozen corpus to enumerate incidental cascade errors.
#[test]
fn corpus_semantic_matches_expectations() {
    for bucket in ["valid", "invalid"] {
        for (stem, path) in yaml_cases(bucket) {
            let yaml = fs::read_to_string(&path).unwrap();
            let exp_path = corpus_dir(bucket).join(format!("{stem}.expected.json"));
            let exp: Expectation =
                serde_json::from_str(&fs::read_to_string(exp_path).unwrap()).unwrap();

            let (accepted, codes) = semantic_result(&yaml);
            assert_eq!(
                accepted, exp.semantic.ok,
                "semantic acceptance mismatch for {bucket}/{stem} (codes: {codes:?})"
            );
            for code in &exp.semantic.errors {
                assert!(
                    codes.contains(code),
                    "expected semantic error {code:?} for {bucket}/{stem}, got {codes:?}"
                );
            }
        }
    }
}
