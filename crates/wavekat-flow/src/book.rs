//! The `book` component (schema_version 2): its bounds, and the
//! vocabulary that lets a caller be told a time.
//!
//! # Why a vocabulary exists at all
//!
//! Every sound a flow makes is a clip. The daemon runs no text-to-speech:
//! prompts are rendered when the flow is published and frozen as version
//! assets, and playback is a file read. That is what makes a flow work
//! with no network, and it is why `book` cannot simply "say the time" —
//! the time is not known until a caller is on the line, hours or days
//! after the last thing was rendered.
//!
//! So the times a flow can *ever* offer are enumerated at publish and
//! rendered then, exactly like its prompts. Two things make that a small
//! finite set rather than an impossible one: starts snap to a half hour
//! ([`BOOK_GRANULARITY_MINS`]), and the node already declares the only
//! hours it books in. A business open 9–5 on weekdays therefore needs 16
//! time clips, not 1440 — and needs them regardless of which week the
//! caller rings in, because "nine thirty" is the same two words on every
//! one of those days.
//!
//! # Why it is split day + time
//!
//! An utterance is two clips: a day phrase, then a time phrase
//! ("Tuesday", then "ten thirty a.m."). One clip per (day, time) pair
//! multiplies the render count by nine for no gain. Going finer the
//! other way — composing "ten", "thirty" and "a.m." separately — is what
//! a naive reading suggests and is wrong: word order and grammar differ across
//! the languages this platform ships, and an engine concatenating
//! fragments in English order produces something between odd and
//! unintelligible elsewhere. Whole phrases keep each language's grammar
//! inside the phrase, where a translator can see it; day-before-time is
//! the one ordering assumption left, and it holds across all of them.
//!
//! # The contract
//!
//! These refs are the contract between the two sides: the platform
//! renders exactly this set at publish and stores it with the version's
//! frozen assets; the daemon plays them and never asks what they mean.
//! Both sides compute the set from the same node config with
//! [`vocabulary_refs`], so neither can render one thing and expect
//! another. The refs join [`crate::model_ext`]'s `required_assets`,
//! which puts them behind the daemon's existing "don't arm a flow whose
//! audio hasn't synced" gate with no new machinery.
//!
//! Twin: `packages/flow-schema/src/book.ts`. Keep the two in lockstep —
//! the conformance corpus pins the ref sets they produce.

use std::collections::BTreeSet;

use time::OffsetDateTime;
use time_tz::{OffsetDateTimeExt, Tz};

use crate::model::{Node, TimeRange};

// ── Defaults (mirroring the schema's own, which typify reads) ───────────

pub const DEFAULT_BOOK_BUFFER_MINS: u64 = 0;
pub const DEFAULT_BOOK_LEAD_MINS: u64 = 120;
pub const DEFAULT_BOOK_HORIZON_DAYS: u64 = 14;
pub const DEFAULT_BOOK_MAX_OFFERS: u64 = 3;
pub const DEFAULT_BOOK_RETRIES: u64 = 1;
pub const DEFAULT_BOOK_TIMEOUT_SECS: u64 = 5;

// ── Bounds (the validator's, per "schema owns shape, validators own
//    semantics" — see CLAUDE.md) ───────────────────────────────────────

/// Shortest and longest one appointment may run.
pub const MIN_BOOK_DURATION_MINS: u64 = 5;
pub const MAX_BOOK_DURATION_MINS: u64 = 480;
/// Widest clear time that may be kept on each side of an appointment.
pub const MAX_BOOK_BUFFER_MINS: u64 = 240;
/// Furthest ahead a caller may be pushed before the first offer (30 days).
pub const MAX_BOOK_LEAD_MINS: u64 = 60 * 24 * 30;
/// Furthest ahead a `book` node may look.
pub const MAX_BOOK_HORIZON_DAYS: u64 = 31;
/// How many times one caller may be offered — bounded by the keypad
/// digits the vocabulary carries.
pub const MAX_BOOK_OFFERS: u64 = 5;

/// Every candidate appointment start lands on a half hour.
///
/// Load-bearing, not cosmetic: this is what bounds the vocabulary.
/// Twin: the platform's `SLOT_GRANULARITY_MINS`, which must agree — if
/// the server offers a time the vocabulary has no clip for, the caller
/// hears silence where the time should be.
///
/// **Narrowing this is not a free change.** [`required_assets`] is
/// computed from the value compiled into *this* build, not from anything
/// a version carries — so a daemon still on the quarter hour, handed a
/// version published against a narrower grid, asks for `bktime_0915`,
/// does not find it, and refuses to arm the flow at all.
///
/// That does not make the change wait on the fleet, which never fully
/// updates. A renderer covers the devices it must serve by rendering the
/// union of every grid still installed; [`vocabulary_refs_on`] is how it
/// enumerates the members it no longer compiles in. See the platform's
/// docs/36.
///
/// [`required_assets`]: crate::model_ext::required_assets
pub const BOOK_GRANULARITY_MINS: u64 = 30;

// ── Vocabulary refs ────────────────────────────────────────────────────

/// Prefix every vocabulary ref carries, so nothing collides with a
/// platform-generated clip ref (`vprompt_…`) or an author's own file.
const PREFIX: &str = "bk";

/// The day phrases, always required. `today`/`tomorrow` are how a person
/// says a date this close to now, and a caller told "Monday" on a Monday
/// has to work out which Monday.
pub const BOOK_DAY_KEYS: &[&str] = &[
    "today", "tomorrow", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
];

/// `bkday_tue` — the day half of an utterance.
pub fn day_ref(day: &str) -> String {
    format!("{PREFIX}day_{day}")
}

/// The day key for a slot, given how many civil days away it falls and
/// which weekday it lands on (0 = Monday, matching [`BOOK_DAY_KEYS`]'s
/// weekday order). Today and tomorrow win over the weekday name.
pub fn day_key(days_ahead: i64, weekday_from_monday: usize) -> &'static str {
    match days_ahead {
        0 => "today",
        1 => "tomorrow",
        _ => BOOK_DAY_KEYS[2 + (weekday_from_monday % 7)],
    }
}

/// `bktime_0930` — the time half, in the flow's own timezone.
pub fn time_ref(minutes_of_day: u64) -> String {
    format!(
        "{PREFIX}time_{:02}{:02}",
        minutes_of_day / 60,
        minutes_of_day % 60
    )
}

/// `bkpress_2` — "press two", the digit that takes the offer.
pub fn press_ref(digit: u64) -> String {
    format!("{PREFIX}press_{digit}")
}

/// The one fixed line the component speaks on its own account: the slot
/// the caller chose was taken between hearing it and pressing the key.
/// Everything else a caller hears is either the author's prompt or a time.
pub fn taken_ref() -> String {
    format!("{PREFIX}taken")
}

/// What a vocabulary ref means — so the side that *renders* it can look
/// up the words without re-deriving the ref format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VocabularyRef {
    Day { day: String },
    Time { hour: u64, minute: u64 },
    Press { digit: u64 },
    Taken,
}

/// Read a ref back into what it says. `None` for anything that is not a
/// vocabulary ref (an author's clip, a filename), so a caller can filter
/// a mixed asset list with it.
pub fn parse_vocabulary_ref(reference: &str) -> Option<VocabularyRef> {
    if reference == taken_ref() {
        return Some(VocabularyRef::Taken);
    }
    if let Some(day) = reference.strip_prefix(&format!("{PREFIX}day_")) {
        return BOOK_DAY_KEYS.contains(&day).then(|| VocabularyRef::Day {
            day: day.to_string(),
        });
    }
    if let Some(digits) = reference.strip_prefix(&format!("{PREFIX}time_")) {
        if digits.len() != 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let hour: u64 = digits[..2].parse().ok()?;
        let minute: u64 = digits[2..].parse().ok()?;
        return (hour <= 23 && minute <= 59).then_some(VocabularyRef::Time { hour, minute });
    }
    if let Some(digits) = reference.strip_prefix(&format!("{PREFIX}press_")) {
        let digit: u64 = digits.parse().ok()?;
        return (1..=MAX_BOOK_OFFERS)
            .contains(&digit)
            .then_some(VocabularyRef::Press { digit });
    }
    None
}

// ── Enumerating a node's vocabulary ────────────────────────────────────

/// `"HH:MM"` → minutes since midnight, or `None` if it isn't one.
/// Lenient in the same direction as the runtime: a range this can't read
/// is a range that offers nothing, not a document that fails to load.
fn minutes_of(hhmm: &str) -> Option<u64> {
    let (h, m) = hhmm.trim().split_once(':')?;
    if m.len() != 2 || h.is_empty() || h.len() > 2 {
        return None;
    }
    let hours: u64 = h.parse().ok()?;
    let mins: u64 = m.parse().ok()?;
    (hours <= 23 && mins <= 59).then_some(hours * 60 + mins)
}

/// The starts a single open range can produce: on the half-hour grid,
/// from the first grid point at or after `open`, while the whole
/// appointment still finishes by `close`.
///
/// Mirrors the platform's slot walk, including that the walk uses real
/// instants and so may drop a candidate this keeps on a daylight-saving
/// boundary. That direction is safe: the vocabulary may be a superset (a
/// clip nobody plays), never a subset (a time nobody can say).
/// The same walk on a grid this build does not necessarily use.
///
/// A device decides whether it can run a flow by computing the required
/// set from the grid compiled into *it*, so a renderer that knows only
/// its own can serve only devices that agree. Rendering the union of
/// every grid still installed is what removes that coupling, and this is
/// how the other members are enumerated. See the platform's docs/36.
fn starts_in_range_on(range: &TimeRange, duration_mins: u64, granularity_mins: u64) -> Vec<u64> {
    // Stepping by zero would never terminate — on a device, that is a
    // hang rather than a wrong answer.
    if granularity_mins == 0 {
        return Vec::new();
    }
    let (Some(open), Some(close)) = (minutes_of(&range.open), minutes_of(&range.close)) else {
        return Vec::new();
    };
    if close <= open {
        return Vec::new();
    }
    let first = open.div_ceil(granularity_mins) * granularity_mins;
    let mut starts = Vec::new();
    let mut mins = first;
    while mins < close {
        if mins + duration_mins <= close {
            starts.push(mins);
        }
        mins += granularity_mins;
    }
    starts
}

/// Every asset ref a `book` node needs in order to speak: the nine day
/// phrases, one clip per bookable time of day, one "press N" per offer
/// it may make, and the taken line. Sorted and unique, so two callers of
/// this compare equal.
///
/// Reads only the node's own config, never a clock — the answer must be
/// the same at publish (when it is rendered) and on a call months later
/// (when it is played). Empty for every other kind of node, so a caller
/// can map it over a whole flow.
pub fn vocabulary_refs(node: &Node) -> Vec<String> {
    vocabulary_refs_on(node, BOOK_GRANULARITY_MINS)
}

/// The same set on a grid this build does not necessarily use.
///
/// Twin of `bookVocabularyRefs(node, { granularityMins })`. Only a
/// *renderer* has a reason to call this: it has to satisfy devices whose
/// compiled-in grid differs from its own, and covering the union of the
/// grids still installed is what stops a narrowing change from waiting on
/// a fleet that never fully updates. A device answering "can I run this
/// flow?" uses [`vocabulary_refs`] and its own constant, which is the
/// question it is actually being asked. See the platform's docs/36.
pub fn vocabulary_refs_on(node: &Node, granularity_mins: u64) -> Vec<String> {
    let Node::Book {
        schedule,
        exceptions,
        duration_mins,
        max_offers,
        ..
    } = node
    else {
        return Vec::new();
    };

    let mut refs: BTreeSet<String> = BTreeSet::new();

    for day in BOOK_DAY_KEYS {
        refs.insert(day_ref(day));
    }
    refs.insert(taken_ref());

    for digit in 1..=(*max_offers).min(MAX_BOOK_OFFERS) {
        refs.insert(press_ref(digit));
    }

    // A duration outside the bounds is a document the validator rejects;
    // clamping keeps a bad draft from asking for an unbounded render
    // while the editor is still showing the error.
    let duration = duration_mins.clamp(&MIN_BOOK_DURATION_MINS, &MAX_BOOK_DURATION_MINS);

    let weekly = [
        &schedule.mon,
        &schedule.tue,
        &schedule.wed,
        &schedule.thu,
        &schedule.fri,
        &schedule.sat,
        &schedule.sun,
    ];
    let mut ranges: Vec<&TimeRange> = weekly.iter().flat_map(|day| day.iter()).collect();
    for exception in exceptions {
        // A closed day offers nothing; its `ranges`, if any, are ignored
        // by the runtime too.
        if exception.closed {
            continue;
        }
        ranges.extend(exception.ranges.iter());
    }

    for range in ranges {
        for start in starts_in_range_on(range, *duration, granularity_mins) {
            refs.insert(time_ref(start));
        }
    }

    refs.into_iter().collect()
}

// ── Saying one time ────────────────────────────────────────────────────

/// The clips that say one appointment time, in order: the day phrase
/// then the time phrase ("Tuesday" → "ten thirty a.m.").
///
/// `start` is an absolute instant — the server answers in UTC — so the
/// business's own zone is what turns it back into the words a caller
/// expects; a 9 a.m. appointment must not be announced as 21:00 because
/// the platform happens to run in UTC. `now` decides only whether the
/// day is worth naming: "Tuesday" is a poor way to say tomorrow.
pub fn time_refs(start: OffsetDateTime, now: OffsetDateTime, tz: &Tz) -> Vec<String> {
    let local = start.to_timezone(tz);
    let today = now.to_timezone(tz).date();
    let days_ahead = (local.date() - today).whole_days();
    let minutes = u64::from(local.hour()) * 60 + u64::from(local.minute());
    vec![
        day_ref(day_key(
            days_ahead,
            local.date().weekday().number_days_from_monday() as usize,
        )),
        time_ref(minutes),
    ]
}

/// The clips that offer one time: what it is, then which key takes it.
pub fn offer_refs(start: OffsetDateTime, now: OffsetDateTime, tz: &Tz, digit: u64) -> Vec<String> {
    let mut refs = time_refs(start, now, tz);
    refs.push(press_ref(digit));
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn grid_starts_leave_room_for_the_whole_appointment() {
        let range = TimeRange {
            open: "09:10".into(),
            close: "10:30".into(),
        };
        // First grid point at or after 09:10 is 09:30 — never 09:10, and
        // no longer 09:15; the last start that still finishes by 10:30
        // with a 30-minute appointment is 10:00.
        assert_eq!(
            starts_in_range_on(&range, 30, BOOK_GRANULARITY_MINS),
            vec![570, 600]
        );
        // An appointment longer than the window produces nothing at all.
        assert!(starts_in_range_on(&range, 120, BOOK_GRANULARITY_MINS).is_empty());
    }

    // The twin of `bookVocabularyRefs(node, { granularityMins })`.
    //
    // A device answers "can I run this flow?" from the grid compiled into
    // it, so a renderer that only knows its own can serve only devices
    // that agree — which makes narrowing wait on the whole fleet
    // updating, an event that does not occur. This is how a renderer
    // enumerates the grids it no longer compiles in, so it can cover the
    // union. See the platform's docs/36.
    #[test]
    fn an_explicit_grid_is_walked_instead_of_this_builds() {
        let range = TimeRange {
            open: "09:00".into(),
            close: "11:00".into(),
        };
        // Quarter hours, from a build whose own constant says thirty.
        assert_eq!(
            starts_in_range_on(&range, 30, 15),
            vec![540, 555, 570, 585, 600, 615, 630]
        );
        // This build's own grid, for contrast — the halves of the same
        // window, and what every existing caller keeps getting.
        assert_eq!(
            starts_in_range_on(&range, 30, BOOK_GRANULARITY_MINS),
            vec![540, 570, 600, 630]
        );
    }

    #[test]
    fn a_finer_grid_is_a_superset_of_a_coarser_one() {
        // The property the union rests on: widening never drops a ref, so
        // a device on the finer grid finds everything it computes inside
        // what a renderer covering both froze.
        let range = TimeRange {
            open: "09:00".into(),
            close: "17:00".into(),
        };
        let fine = starts_in_range_on(&range, 30, 15);
        for start in starts_in_range_on(&range, 30, 30) {
            assert!(fine.contains(&start), "{start} missing from the finer grid");
        }
    }

    #[test]
    fn a_zero_grid_yields_nothing_rather_than_spinning() {
        // Unreachable through `vocabulary_refs`, which passes a constant.
        // Asserted anyway because the loop steps by this value, and the
        // failure would be a hung device rather than a wrong answer.
        let range = TimeRange {
            open: "09:00".into(),
            close: "17:00".into(),
        };
        assert!(starts_in_range_on(&range, 30, 0).is_empty());
    }

    #[test]
    fn unreadable_ranges_offer_nothing_rather_than_failing() {
        let backwards = TimeRange {
            open: "17:00".into(),
            close: "09:00".into(),
        };
        assert!(starts_in_range_on(&backwards, 30, BOOK_GRANULARITY_MINS).is_empty());
        let nonsense = TimeRange {
            open: "nine".into(),
            close: "five".into(),
        };
        assert!(starts_in_range_on(&nonsense, 30, BOOK_GRANULARITY_MINS).is_empty());
    }

    #[test]
    fn refs_round_trip_through_their_meaning() {
        assert_eq!(
            parse_vocabulary_ref(&time_ref(9 * 60 + 30)),
            Some(VocabularyRef::Time {
                hour: 9,
                minute: 30
            })
        );
        assert_eq!(
            parse_vocabulary_ref(&day_ref("tue")),
            Some(VocabularyRef::Day { day: "tue".into() })
        );
        assert_eq!(
            parse_vocabulary_ref(&press_ref(2)),
            Some(VocabularyRef::Press { digit: 2 })
        );
        assert_eq!(
            parse_vocabulary_ref(&taken_ref()),
            Some(VocabularyRef::Taken)
        );

        // Not vocabulary: an author's clip, and refs that look like one
        // but say nothing sayable.
        assert_eq!(parse_vocabulary_ref("vprompt_ab12cd34"), None);
        assert_eq!(parse_vocabulary_ref("bkday_funday"), None);
        assert_eq!(parse_vocabulary_ref("bktime_2599"), None);
        assert_eq!(parse_vocabulary_ref("bkpress_9"), None);
    }

    #[test]
    fn day_key_prefers_today_and_tomorrow_over_the_weekday_name() {
        assert_eq!(day_key(0, 3), "today");
        assert_eq!(day_key(1, 4), "tomorrow");
        assert_eq!(day_key(2, 0), "mon");
        assert_eq!(day_key(6, 6), "sun");
    }

    #[test]
    fn a_time_is_said_in_the_businesss_zone_not_the_servers() {
        let tz = crate::hours::resolve_tz("America/New_York").unwrap();
        // 14:30 UTC on Tuesday 7 July 2026 is 10:30 EDT the same day.
        let start = datetime!(2026-07-07 14:30 UTC);
        let now = datetime!(2026-07-06 12:00 UTC); // Monday: the slot is tomorrow
        assert_eq!(
            time_refs(start, now, tz),
            vec!["bkday_tomorrow".to_string(), "bktime_1030".to_string()],
        );

        // Same instant, a week earlier in the caller's life: now it needs
        // its weekday name.
        let earlier = datetime!(2026-07-01 12:00 UTC);
        assert_eq!(
            time_refs(start, earlier, tz),
            vec!["bkday_tue".to_string(), "bktime_1030".to_string()],
        );
    }

    #[test]
    fn a_late_utc_instant_can_be_the_previous_local_day() {
        let tz = crate::hours::resolve_tz("America/New_York").unwrap();
        // 01:00 UTC Wednesday is 21:00 EDT Tuesday — the local date, and
        // therefore the day word, belongs to Tuesday.
        let start = datetime!(2026-07-08 01:00 UTC);
        let now = datetime!(2026-07-07 13:00 UTC); // Tuesday morning, local
        assert_eq!(
            time_refs(start, now, tz),
            vec!["bkday_today".to_string(), "bktime_2100".to_string()],
        );
    }

    #[test]
    fn an_offer_ends_with_the_key_that_takes_it() {
        let tz = crate::hours::resolve_tz("UTC").unwrap();
        let start = datetime!(2026-07-07 09:30 UTC);
        let now = datetime!(2026-07-07 08:00 UTC);
        assert_eq!(
            offer_refs(start, now, tz, 2),
            vec![
                "bkday_today".to_string(),
                "bktime_0930".to_string(),
                "bkpress_2".to_string()
            ],
        );
    }
}
