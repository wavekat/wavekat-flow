//! `source` reads prompts from the text, the model from the typed tree.
//! Over every valid document in the corpus, the two must find the same
//! prompts, node for node. A prompt field added to the model but not to
//! `prompt_fields` (or the other way round) fails here. Each document is
//! then voiced in full, and the result must still parse to the same flow,
//! with every text prompt now a clip carrying its text as the transcript.

use std::{collections::BTreeMap, fs, path::PathBuf};

use wavekat_flow::model::{Flow, Prompt};
use wavekat_flow::source;

/// `(node, field-order index) → what it says`, as text or audio ref.
type Spoken = BTreeMap<String, Vec<Said>>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Said {
    Text(String),
    Audio(Option<String>),
}

fn valid_documents() -> Vec<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance");
    let mut out = Vec::new();
    for version in fs::read_dir(&root).expect("read corpus root").flatten() {
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
    assert!(!out.is_empty(), "no valid documents in the corpus");
    out
}

fn from_model(flow: &Flow) -> Spoken {
    let mut out = Spoken::new();
    for (id, node) in &flow.nodes {
        let said: Vec<Said> = node
            .prompts()
            .into_iter()
            .filter_map(|p| match p {
                Prompt::Text(t) if t.trim().is_empty() => None,
                Prompt::Text(t) => Some(Said::Text(t.trim().to_string())),
                Prompt::Audio { audio, .. } => Some(Said::Audio(Some(audio.trim().to_string()))),
            })
            .collect();
        if !said.is_empty() {
            out.insert(id.clone(), said);
        }
    }
    sorted(out)
}

fn from_source(found: &source::Prompts) -> Spoken {
    let mut out = Spoken::new();
    for p in &found.text {
        out.entry(p.node.clone())
            .or_default()
            .push(Said::Text(p.text.clone()));
    }
    for p in &found.audio {
        out.entry(p.node.clone())
            .or_default()
            .push(Said::Audio(p.audio.clone()));
    }
    sorted(out)
}

fn sorted(mut s: Spoken) -> Spoken {
    for v in s.values_mut() {
        v.sort();
    }
    s
}

#[test]
fn source_prompts_match_model() {
    for path in valid_documents() {
        let src = fs::read_to_string(&path).unwrap();
        let flow = Flow::from_yaml(&src).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let found = source::prompts(&src).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(
            from_source(&found),
            from_model(&flow),
            "{}: source and model disagree on the prompts",
            path.display()
        );
    }
}

#[test]
fn voicing_every_corpus_document_keeps_the_flow() {
    for path in valid_documents() {
        let src = fs::read_to_string(&path).unwrap();
        let found = source::prompts(&src).unwrap();
        let swaps: Vec<_> = found
            .text
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), format!("vprompt_{i}")))
            .collect();
        let out = source::voice_text_prompts(&src, &swaps)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));

        let before = Flow::from_yaml(&src).unwrap();
        let after = Flow::from_yaml(&out).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(before.entry, after.entry, "{}", path.display());
        assert_eq!(before.nodes.len(), after.nodes.len(), "{}", path.display());
        assert!(
            source::prompts(&out).unwrap().text.is_empty(),
            "{}: text prompts left after voicing",
            path.display()
        );
        for (i, (p, _)) in swaps.iter().enumerate() {
            let node = &after.nodes[&p.node];
            let want = format!("vprompt_{i}");
            assert!(
                node.prompts().into_iter().any(|q| matches!(
                    q,
                    Prompt::Audio { audio, transcript: Some(t) } if *audio == want && *t == p.text
                )),
                "{}: {}.{} wasn't voiced as {want}",
                path.display(),
                p.node,
                p.field
            );
        }
    }
}
