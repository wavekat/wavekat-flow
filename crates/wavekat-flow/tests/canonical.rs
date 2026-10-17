//! The Rust half of the canonical-text contract
//! (docs/01-canonical-document.md §4). The TS package runs the same cases
//! (packages/flow-schema/test/canonical.test.ts), so the two serializers
//! agree byte for byte.

use std::{fs, path::PathBuf};

use wavekat_flow::{edit, prompt_fields, Flow};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

#[derive(serde::Deserialize)]
struct Expected {
    comments: usize,
}

fn canonical_cases() -> Vec<String> {
    let mut cases: Vec<String> = fs::read_dir(corpus().join("canonical"))
        .expect("read canonical corpus")
        .filter_map(|e| {
            let name = e.ok()?.file_name().to_str()?.to_string();
            name.strip_suffix(".input.yaml").map(str::to_string)
        })
        .collect();
    cases.sort();
    assert!(!cases.is_empty(), "no canonical cases");
    cases
}

fn read(case: &str, ext: &str) -> String {
    let path = corpus().join("canonical").join(format!("{case}.{ext}"));
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn canonical_cases_serialize_exactly() {
    for case in canonical_cases() {
        let input = read(&case, "input.yaml");
        let canonical = read(&case, "canonical.yaml");
        let expected: Expected = serde_json::from_str(&read(&case, "expected.json")).unwrap();

        let flow = Flow::from_yaml(&input).unwrap_or_else(|e| panic!("{case}: {e}"));
        assert_eq!(flow.to_yaml(), canonical, "{case}: input → canonical");

        let again = Flow::from_yaml(&canonical).unwrap_or_else(|e| panic!("{case}: {e}"));
        assert_eq!(
            again.to_yaml(),
            canonical,
            "{case}: canonical is a fixed point"
        );

        assert_eq!(
            edit::comments(&input).len(),
            expected.comments,
            "{case}: comments in input: {:?}",
            edit::comments(&input)
        );
        assert!(
            edit::comments(&canonical).is_empty(),
            "{case}: comments in canonical"
        );
    }
}

/// Every valid document in the corpus, any version, inbound or outbound.
fn valid_documents() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for version in fs::read_dir(corpus()).unwrap().flatten() {
        for bucket in ["valid", "outbound/valid"] {
            let Ok(entries) = fs::read_dir(version.path().join(bucket)) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "yaml") {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    assert!(!out.is_empty());
    out
}

#[test]
fn serializing_loses_nothing() {
    for path in valid_documents() {
        let src = fs::read_to_string(&path).unwrap();
        let flow = Flow::from_yaml(&src).unwrap();
        let text = flow.to_yaml();
        let back =
            Flow::from_yaml(&text).unwrap_or_else(|e| panic!("{}: {e}\n{text}", path.display()));
        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&flow).unwrap(),
            "{}: the canonical text means something else",
            path.display()
        );
        assert_eq!(
            back.to_yaml(),
            text,
            "{}: not a fixed point",
            path.display()
        );
    }
}

/// `prompt_fields(kind)` names exactly the fields `Node::prompts()` reads,
/// on every node in the corpus.
#[test]
fn prompt_fields_match_model() {
    for path in valid_documents() {
        let flow = Flow::from_yaml(&fs::read_to_string(&path).unwrap()).unwrap();
        for (id, node) in &flow.nodes {
            let fields = prompt_fields(node.kind()).expect("a known kind");
            let value = serde_json::to_value(node).unwrap();
            let present = fields.iter().filter(|f| value.get(**f).is_some()).count();
            assert_eq!(
                present,
                node.prompts().len(),
                "{}: {id} ({}): prompt_fields disagrees with Node::prompts",
                path.display(),
                node.kind()
            );
        }
    }
}
