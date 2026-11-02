//! The Rust half of the shared conformance corpus. Every case in
//! `conformance/vN/{valid,invalid}` is validated against the normative
//! JSON Schema **for the version it declares**, with a real draft-2020-12
//! validator (mirroring the TS side's ajv), so `structurallyValid` means
//! the identical thing in both languages. Valid cases are additionally
//! deserialized into the schema-generated model, proving the generated
//! types accept real documents. The TS package runs the SAME corpus
//! (packages/flow-schema/test/conformance.test.ts).
//!
//! One directory per format version. A case lives under the version its
//! document *declares*, not the version that can read it: the v1 case
//! using a `book` node belongs to v1, because what it pins is how a
//! version-1 document is treated.

use std::{fs, path::PathBuf};

use wavekat_flow::model::Flow;
use wavekat_flow::validate::{validate, validate_outbound};

#[derive(serde::Deserialize)]
struct Expectation {
    #[serde(rename = "structurallyValid")]
    structurally_valid: bool,
    semantic: Semantic,
    /// Optional: the exact asset set a daemon must have on disk before it
    /// will arm this flow. See `corpus_required_assets_match_expectations`.
    #[serde(rename = "requiredAssets", default)]
    required_assets: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct Semantic {
    ok: bool,
    errors: Vec<String>,
}

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

/// Every `vN` directory present, so a new version's cases run the moment
/// the directory exists rather than when someone remembers a list.
fn corpus_versions() -> Vec<String> {
    let mut versions: Vec<String> = fs::read_dir(corpus_root())
        .expect("read corpus root")
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().to_str()?.to_string();
            let rest = name.strip_prefix('v')?;
            rest.chars().all(|c| c.is_ascii_digit()).then_some(name)
        })
        .collect();
    versions.sort_by_key(|v| v[1..].parse::<u32>().unwrap_or(0));
    assert!(!versions.is_empty(), "corpus has no vN directories");
    versions
}

fn corpus_dir(version: &str, bucket: &str) -> PathBuf {
    corpus_root().join(version).join(bucket)
}

fn yaml_cases(version: &str, bucket: &str) -> Vec<(String, PathBuf)> {
    yaml_cases_in(&corpus_dir(version, bucket))
}

fn yaml_cases_in(dir: &std::path::Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    // A version may have no cases in a bucket yet (v3 starts with `valid`
    // only); a missing directory is an empty bucket, not an error.
    if !dir.is_dir() {
        return out;
    }
    for entry in fs::read_dir(dir).expect("read corpus dir") {
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
    for version in corpus_versions() {
        let number: u32 = version[1..].parse().expect("vN directory name");
        let schema: serde_json::Value = serde_json::from_str(
            wavekat_flow::flow_schema(number)
                .unwrap_or_else(|| panic!("no schema for corpus directory {version}")),
        )
        .expect("schema json");
        let validator = jsonschema::validator_for(&schema).expect("compile schema");

        for bucket in ["valid", "invalid"] {
            for (stem, path) in yaml_cases(&version, bucket) {
                let doc: serde_json::Value =
                    serde_yaml_ng::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                let exp_path = corpus_dir(&version, bucket).join(format!("{stem}.expected.json"));
                let exp: Expectation =
                    serde_json::from_str(&fs::read_to_string(exp_path).unwrap()).unwrap();
                assert_eq!(
                    validator.is_valid(&doc),
                    exp.structurally_valid,
                    "structural verdict mismatch for {version}/{bucket}/{stem}"
                );
            }
        }
    }
}

#[test]
fn valid_corpus_deserializes_into_generated_model() {
    for version in corpus_versions() {
        for (stem, path) in yaml_cases(&version, "valid") {
            let yaml = fs::read_to_string(&path).unwrap();
            serde_yaml_ng::from_str::<wavekat_flow::model::Flow>(&yaml).unwrap_or_else(|e| {
                panic!("valid corpus '{version}/{stem}' should deserialize into Flow: {e}")
            });
        }
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
    semantic_result_with(yaml, validate)
}

/// [`semantic_result`] with the validator chosen — the outbound corpus runs
/// the same parse step through [`validate_outbound`].
fn semantic_result_with(
    yaml: &str,
    gate: fn(&Flow) -> Result<(), Vec<wavekat_flow::validate::ValidationError>>,
) -> (bool, Vec<String>) {
    match Flow::from_yaml(yaml) {
        Err(e) => (false, vec![parse_error_code(&e).to_string()]),
        Ok(flow) => match gate(&flow) {
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
    for version in corpus_versions() {
        for bucket in ["valid", "invalid"] {
            for (stem, path) in yaml_cases(&version, bucket) {
                let yaml = fs::read_to_string(&path).unwrap();
                let exp_path = corpus_dir(&version, bucket).join(format!("{stem}.expected.json"));
                let exp: Expectation =
                    serde_json::from_str(&fs::read_to_string(exp_path).unwrap()).unwrap();

                let (accepted, codes) = semantic_result(&yaml);
                assert_eq!(
                    accepted, exp.semantic.ok,
                    "semantic acceptance mismatch for {version}/{bucket}/{stem} (codes: {codes:?})"
                );
                for code in &exp.semantic.errors {
                    assert!(
                        codes.contains(code),
                        "expected semantic error {code:?} for {version}/{bucket}/{stem}, got {codes:?}"
                    );
                }
            }
        }
    }
}

// The asset set, pinned across both languages.
//
// This is the one place a `book` node's vocabulary arithmetic is checked
// against something outside the language that computed it. Both sides derive
// the set from their own copy of `BOOK_GRANULARITY_MINS`, and a daemon
// refuses to arm a flow whose required assets are not all on disk — so if the
// two ever drift, the symptom is not a failing test but a customer's phone
// line going quiet, on whichever devices updated late.
//
// Exact-set equality, unlike the `errors` expectation above: this set *is* the
// contract, not a description of one, and a missing member is precisely the
// bug worth catching.
#[test]
fn corpus_required_assets_match_expectations() {
    let mut pinned = 0usize;
    for version in corpus_versions() {
        for bucket in ["valid", "invalid"] {
            for (stem, path) in yaml_cases(&version, bucket) {
                let exp_path = corpus_dir(&version, bucket).join(format!("{stem}.expected.json"));
                let exp: Expectation =
                    serde_json::from_str(&fs::read_to_string(exp_path).unwrap()).unwrap();
                let Some(expected) = exp.required_assets else {
                    continue;
                };

                let yaml = fs::read_to_string(&path).unwrap();
                let flow: Flow = serde_yaml_ng::from_str(&yaml)
                    .unwrap_or_else(|e| panic!("{version}/{bucket}/{stem} must parse: {e}"));
                assert_eq!(
                    wavekat_flow::required_assets(&flow),
                    expected,
                    "required assets differ for {version}/{bucket}/{stem}"
                );
                pinned += 1;
            }
        }
    }
    // A corpus that stopped pinning any would make this test pass by
    // doing nothing, which is the one way it could fail silently.
    assert!(pinned > 0, "no corpus case pins a required-asset set");
}

// The outbound profile: `conformance/vN/outbound/{valid,invalid}`, run
// through `validate_outbound` (which includes the base validation) with the
// same subset contract as the semantic corpus above. Kept out of the
// top-level `valid/`/`invalid/` buckets on purpose: a flow refused for
// outbound — a `ring` step, say — is a perfectly good inbound flow. The TS
// package runs the same cases through `validateOutbound`.
#[test]
fn outbound_corpus_matches_expectations() {
    let mut ran = 0usize;
    for version in corpus_versions() {
        let number: u32 = version[1..].parse().expect("vN directory name");
        let schema: serde_json::Value =
            serde_json::from_str(wavekat_flow::flow_schema(number).expect("schema")).unwrap();
        let validator = jsonschema::validator_for(&schema).expect("compile schema");

        for bucket in ["valid", "invalid"] {
            let dir = corpus_root().join(&version).join("outbound").join(bucket);
            if !dir.is_dir() {
                continue;
            }
            for (stem, path) in yaml_cases_in(&dir) {
                let case = format!("{version}/outbound/{bucket}/{stem}");
                let yaml = fs::read_to_string(&path).unwrap();
                let exp: Expectation = serde_json::from_str(
                    &fs::read_to_string(dir.join(format!("{stem}.expected.json"))).unwrap(),
                )
                .unwrap();

                let doc: serde_json::Value = serde_yaml_ng::from_str(&yaml).unwrap();
                assert_eq!(
                    validator.is_valid(&doc),
                    exp.structurally_valid,
                    "structural verdict mismatch for {case}"
                );

                let (accepted, codes) = semantic_result_with(&yaml, validate_outbound);
                assert_eq!(
                    accepted, exp.semantic.ok,
                    "outbound acceptance mismatch for {case} (codes: {codes:?})"
                );
                for code in &exp.semantic.errors {
                    assert!(
                        codes.contains(code),
                        "expected outbound error {code:?} for {case}, got {codes:?}"
                    );
                }
                ran += 1;
            }
        }
    }
    assert!(ran > 0, "the outbound corpus has no cases");
}

// The fill corpus: `conformance/fill/<case>.input.yaml` + `<case>.values.json`
// run through `fill`. A success case has `<case>.expected.yaml`, compared with
// the filled flow after canonical serialization; a refusal has
// `<case>.expected.json` = `{"errors": [codes]}` (exact list, in order).
#[test]
fn corpus_fill_matches_expectations() {
    let dir = corpus_root().join("fill");
    let mut ran = 0;
    for (stem, path) in yaml_cases_in(&dir) {
        let Some(case) = stem.strip_suffix(".input") else {
            continue;
        };
        let flow = Flow::from_yaml(&fs::read_to_string(&path).unwrap()).unwrap();
        let values: std::collections::BTreeMap<String, String> = serde_json::from_str(
            &fs::read_to_string(dir.join(format!("{case}.values.json"))).unwrap(),
        )
        .unwrap();
        // Every source is a flow that passes the gate fill expects in front of it.
        wavekat_flow::validate::validate_outbound(&flow)
            .unwrap_or_else(|e| panic!("fill/{case} source should validate: {e:?}"));
        let result = wavekat_flow::vars::fill(&flow, &values);
        let expected_yaml = dir.join(format!("{case}.expected.yaml"));
        if expected_yaml.exists() {
            let filled = result.unwrap_or_else(|e| panic!("fill/{case} should succeed: {e:?}"));
            let want = Flow::from_yaml(&fs::read_to_string(expected_yaml).unwrap()).unwrap();
            let text = filled.to_yaml();
            assert_eq!(text, want.to_yaml(), "fill/{case}");
            // The result is a v3 document that validates on its own and
            // reads back as itself.
            assert_eq!(filled.schema_version, 3, "fill/{case}");
            wavekat_flow::validate::validate_outbound(&filled)
                .unwrap_or_else(|e| panic!("fill/{case} result should validate: {e:?}"));
            assert_eq!(
                Flow::from_yaml(&text).unwrap().to_yaml(),
                text,
                "fill/{case}"
            );
        } else {
            #[derive(serde::Deserialize)]
            struct Refusal {
                errors: Vec<String>,
            }
            let want: Refusal = serde_json::from_str(
                &fs::read_to_string(dir.join(format!("{case}.expected.json"))).unwrap(),
            )
            .unwrap();
            let got: Vec<String> = result
                .expect_err(&format!("fill/{case} should be refused"))
                .iter()
                .map(|e| e.code().to_string())
                .collect();
            assert_eq!(got, want.errors, "fill/{case}");
        }
        ran += 1;
    }
    assert!(ran > 0, "the fill corpus has no cases");
}
