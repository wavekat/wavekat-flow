//! Older readers must keep reading newer documents.
//!
//! Voice daemons keep running whatever `wavekat-flow` release they were built
//! with, while the platform writes the current format. This crate pins the
//! oldest release still in the field (`old-flow` in Cargo.toml) next to the
//! current crate and checks that everything the current format produces still
//! parses, and is judged the same way, by the old one.
//!
//! OLDEST_READER tracks the oldest crate release still running in installed
//! daemons. To retire it once no daemon that old remains: bump the `=x.y.z`
//! pin in Cargo.toml to the new oldest release and update the constant below.
//! Never bump it just to make a failure go away: a failure here means a
//! document we write today would break a daemon that is already installed.
//!
//! Corpus cases are frozen, so this also covers every document the format has
//! ever accepted that the old reader's schema versions can read.

use std::{fs, path::Path, path::PathBuf};

use old_flow::validate::validate as old_validate;
use wavekat_flow::validate::validate as new_validate;

/// The oldest `wavekat-flow` release still running in installed daemons.
/// Must match the `old-flow` pin in Cargo.toml (asserted below).
const OLDEST_READER: &str = "0.0.6";

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn yaml_files(dir: PathBuf) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .collect();
    out.sort();
    out
}

/// Every document the current format is expected to produce or accept: the
/// valid and outbound-valid corpus of every version, and the canonical
/// outputs of the serializer.
fn current_documents() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for version in fs::read_dir(corpus()).unwrap().flatten() {
        let name = version.file_name().to_string_lossy().to_string();
        if name.starts_with('v') && name[1..].chars().all(|c| c.is_ascii_digit()) {
            out.extend(yaml_files(version.path().join("valid")));
            out.extend(yaml_files(version.path().join("outbound").join("valid")));
        }
    }
    out.extend(
        yaml_files(corpus().join("canonical"))
            .into_iter()
            .filter(|p| p.to_string_lossy().ends_with(".canonical.yaml")),
    );
    out
}

/// Read the version straight off the text, without going through either
/// crate's model.
fn schema_version(yaml: &str) -> u32 {
    yaml.lines()
        .find_map(|l| l.strip_prefix("schema_version:"))
        .expect("schema_version line")
        .trim()
        .parse()
        .expect("numeric schema_version")
}

fn rel(p: &Path) -> String {
    p.strip_prefix(corpus()).unwrap().display().to_string()
}

/// The documents the old reader claims to support, as (name, yaml).
fn readable_by_old() -> Vec<(String, String)> {
    current_documents()
        .iter()
        .map(|p| (rel(p), fs::read_to_string(p).unwrap()))
        .filter(|(_, yaml)| old_flow::SUPPORTED_SCHEMA_VERSIONS.contains(&schema_version(yaml)))
        .collect()
}

#[test]
fn pin_matches_constant() {
    let manifest =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    assert!(
        manifest.contains(&format!("version = \"={OLDEST_READER}\"")),
        "OLDEST_READER and the old-flow pin in Cargo.toml disagree"
    );
}

#[test]
fn old_reader_parses_every_current_document() {
    let docs = readable_by_old();
    assert!(
        docs.len() > 10,
        "only {} documents reached the old reader",
        docs.len()
    );
    for (case, yaml) in docs {
        old_flow::Flow::from_yaml(&yaml).unwrap_or_else(|e| {
            panic!("{OLDEST_READER} cannot parse {case}, which the current format writes: {e}")
        });
    }
}

#[test]
fn old_reader_judges_like_the_current_one() {
    for (case, yaml) in readable_by_old() {
        let old = old_flow::Flow::from_yaml(&yaml).unwrap();
        let new = wavekat_flow::Flow::from_yaml(&yaml).unwrap();
        assert_eq!(
            old_validate(&old).is_ok(),
            new_validate(&new).is_ok(),
            "{OLDEST_READER} and the current crate disagree on {case}"
        );
    }
}

#[test]
fn unknown_keys_do_not_disturb_the_fields_the_old_reader_knows() {
    // Not just "does not fail": the keys it skips must not consume or
    // reorder what it does understand.
    let yaml = fs::read_to_string(corpus().join("v2/valid/notes.yaml")).unwrap();
    let old = old_flow::Flow::from_yaml(&yaml).unwrap();
    let new = wavekat_flow::Flow::from_yaml(&yaml).unwrap();
    assert_eq!(old.entry, new.entry);
    // Order is the author's reading order and irrelevant to execution; the
    // old reader may not keep it, so compare the node sets.
    let mut old_ids: Vec<_> = old.nodes.keys().map(|k| k.to_string()).collect();
    let mut new_ids: Vec<_> = new.nodes.keys().map(|k| k.to_string()).collect();
    old_ids.sort();
    new_ids.sort();
    assert_eq!(old_ids, new_ids);
}

#[test]
fn old_reader_refuses_versions_it_does_not_know() {
    // The other half of the contract: a version bump is how a change old
    // readers cannot handle is announced, and they must say so rather than
    // guess.
    let yaml = "schema_version: 99\nid: f\nname: f\nentry: a\nnodes:\n  a:\n    kind: hangup\n";
    let flow = old_flow::Flow::from_yaml(yaml).expect("parses; the version gate is validate");
    assert!(old_validate(&flow).is_err());
}
