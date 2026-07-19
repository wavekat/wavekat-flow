//! Evaluation of the `hours` node's schedule — the one v1 component with
//! real branching logic, kept pure so it is directly unit-testable (feed a
//! fixed instant, assert open/closed) without a call or a clock. The
//! TypeScript twin is `packages/flow-schema/src/hours.ts`; a config is valid
//! on one side iff it is on the other (pinned by the conformance corpus).
//!
//! A flow is authored in one place and may run on a device in another
//! timezone, so the schedule is always evaluated in the flow's declared IANA
//! zone (doc 48), never the device's local time. `time-tz` bundles the tz
//! database and does the UTC→zone conversion.

use time::macros::format_description;
use time::{Date, OffsetDateTime, Time, Weekday};
use time_tz::{timezones, OffsetDateTimeExt, Tz};

use crate::model::{HoursException, Node, TimeRange, WeeklySchedule};

/// Result of evaluating an `hours` node: which named exit to follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoursResult {
    Open,
    Closed,
}

impl HoursResult {
    /// The exit name this result follows.
    pub fn exit(self) -> &'static str {
        match self {
            HoursResult::Open => "open",
            HoursResult::Closed => "closed",
        }
    }
}

/// Why an `hours` node could not be evaluated or validated. All of these are
/// caught at load by [`crate::validate`], so a validated flow never produces
/// one at run time — the engine treats it as a defect.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HoursError {
    #[error("unknown IANA timezone {0:?}")]
    UnknownTimezone(String),
    #[error("time {0:?} is not HH:MM")]
    BadTime(String),
    #[error("date {0:?} is not YYYY-MM-DD")]
    BadDate(String),
    #[error("range open {open:?} is not before close {close:?}")]
    NonPositiveRange { open: String, close: String },
}

/// Resolve an IANA zone name, or [`HoursError::UnknownTimezone`].
pub fn resolve_tz(name: &str) -> Result<&'static Tz, HoursError> {
    timezones::get_by_name(name).ok_or_else(|| HoursError::UnknownTimezone(name.to_string()))
}

/// Parse `"HH:MM"` (24-hour) into a [`Time`].
pub fn parse_time(s: &str) -> Result<Time, HoursError> {
    let fmt = format_description!("[hour]:[minute]");
    Time::parse(s, fmt).map_err(|_| HoursError::BadTime(s.to_string()))
}

/// Parse `"YYYY-MM-DD"` into a [`Date`].
pub fn parse_date(s: &str) -> Result<Date, HoursError> {
    let fmt = format_description!("[year]-[month]-[day]");
    Date::parse(s, fmt).map_err(|_| HoursError::BadDate(s.to_string()))
}

/// Check every time/date string in the config parses and every range is
/// positive (open strictly before close). Called by validation so a
/// malformed schedule is rejected at publish, not discovered mid-call.
/// Overnight ranges (close ≤ open) are **not** a v1 feature — they fail here
/// rather than silently never matching.
pub fn validate_config(
    schedule: &WeeklySchedule,
    timezone: &str,
    exceptions: &[HoursException],
) -> Result<(), HoursError> {
    resolve_tz(timezone)?;
    for range in weekdays(schedule).into_iter().flatten() {
        check_range(range)?;
    }
    for ex in exceptions {
        parse_date(&ex.date)?;
        for range in &ex.ranges {
            check_range(range)?;
        }
    }
    Ok(())
}

fn check_range(range: &TimeRange) -> Result<(), HoursError> {
    let open = parse_time(&range.open)?;
    let close = parse_time(&range.close)?;
    if open >= close {
        return Err(HoursError::NonPositiveRange {
            open: range.open.clone(),
            close: range.close.clone(),
        });
    }
    Ok(())
}

/// Evaluate an `hours` node against an instant (any offset; the evaluation
/// converts it to the flow's zone). Returns which exit to follow. Assumes a
/// validated config; a parse failure here is a defect surfaced as an error
/// rather than a panic. Called only for `hours` nodes; any other kind is a
/// programming error surfaced (not hidden as "closed").
pub fn evaluate(node: &Node, now: OffsetDateTime) -> Result<HoursResult, HoursError> {
    let Node::Hours {
        schedule,
        timezone,
        exceptions,
        ..
    } = node
    else {
        return Err(HoursError::UnknownTimezone(String::new()));
    };

    let tz = resolve_tz(timezone)?;
    let local = now.to_timezone(tz);
    let today = local.date();
    let now_time = local.time();

    // A dated exception fully overrides the weekly schedule for that day —
    // the whole point of a holiday override.
    for ex in exceptions {
        if parse_date(&ex.date)? == today {
            if ex.closed {
                return Ok(HoursResult::Closed);
            }
            return open_if_within(&ex.ranges, now_time);
        }
    }

    let ranges = ranges_for(schedule, local.weekday());
    open_if_within(ranges, now_time)
}

fn open_if_within(ranges: &[TimeRange], now: Time) -> Result<HoursResult, HoursError> {
    for range in ranges {
        let open = parse_time(&range.open)?;
        let close = parse_time(&range.close)?;
        if now >= open && now < close {
            return Ok(HoursResult::Open);
        }
    }
    Ok(HoursResult::Closed)
}

fn ranges_for(schedule: &WeeklySchedule, day: Weekday) -> &[TimeRange] {
    match day {
        Weekday::Monday => &schedule.mon,
        Weekday::Tuesday => &schedule.tue,
        Weekday::Wednesday => &schedule.wed,
        Weekday::Thursday => &schedule.thu,
        Weekday::Friday => &schedule.fri,
        Weekday::Saturday => &schedule.sat,
        Weekday::Sunday => &schedule.sun,
    }
}

fn weekdays(schedule: &WeeklySchedule) -> [&[TimeRange]; 7] {
    [
        &schedule.mon,
        &schedule.tue,
        &schedule.wed,
        &schedule.thu,
        &schedule.fri,
        &schedule.sat,
        &schedule.sun,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;
    use time::macros::datetime;

    fn open_11_to_22() -> WeeklySchedule {
        let range = TimeRange {
            open: "11:00".into(),
            close: "22:00".into(),
        };
        WeeklySchedule {
            tue: vec![range.clone()],
            wed: vec![range.clone()],
            thu: vec![range.clone()],
            fri: vec![range.clone()],
            sat: vec![range.clone()],
            sun: vec![range],
            ..Default::default()
        }
    }

    fn hours(exceptions: Vec<HoursException>) -> Node {
        Node::Hours {
            schedule: open_11_to_22(),
            timezone: "America/New_York".into(),
            exceptions,
            exits: None,
        }
    }

    #[test]
    fn open_during_business_hours() {
        // 2026-07-07 is a Tuesday. 15:00 America/New_York is 19:00 UTC
        // (EDT, -04:00). Well inside 11:00–22:00 local.
        let now = datetime!(2026-07-07 19:00 UTC);
        assert_eq!(evaluate(&hours(vec![]), now).unwrap(), HoursResult::Open);
    }

    #[test]
    fn closed_before_opening() {
        // 2026-07-07 Tue, 10:00 local = 14:00 UTC — before 11:00 open.
        let now = datetime!(2026-07-07 14:00 UTC);
        assert_eq!(evaluate(&hours(vec![]), now).unwrap(), HoursResult::Closed);
    }

    #[test]
    fn closed_at_exactly_close_time() {
        // Half-open [open, close): 22:00 local is closed. = 02:00 UTC the
        // next calendar day.
        let now = datetime!(2026-07-08 02:00 UTC);
        assert_eq!(evaluate(&hours(vec![]), now).unwrap(), HoursResult::Closed);
    }

    #[test]
    fn closed_on_a_day_with_no_ranges() {
        // Monday has no ranges in this schedule. 2026-07-06 is Monday.
        let now = datetime!(2026-07-06 19:00 UTC);
        assert_eq!(evaluate(&hours(vec![]), now).unwrap(), HoursResult::Closed);
    }

    #[test]
    fn timezone_is_the_flows_not_utc() {
        // 2026-07-07 Tue, 23:30 UTC. In UTC that's past 22:00 and would read
        // "closed" if we ignored the zone — but in New York it's 19:30 EDT,
        // firmly open. This is the whole reason `hours` carries a timezone.
        let now = datetime!(2026-07-07 23:30 UTC);
        assert_eq!(evaluate(&hours(vec![]), now).unwrap(), HoursResult::Open);
    }

    #[test]
    fn holiday_exception_forces_closed() {
        // Would be open (Tue 15:00 local) but for the holiday override.
        let now = datetime!(2026-07-07 19:00 UTC);
        let closed = hours(vec![HoursException {
            date: "2026-07-07".into(),
            closed: true,
            ranges: vec![],
        }]);
        assert_eq!(evaluate(&closed, now).unwrap(), HoursResult::Closed);
    }

    #[test]
    fn special_hours_exception_overrides_weekly() {
        // Monday (normally closed all day) but a one-off open window.
        let now = datetime!(2026-07-06 15:00 UTC); // 11:00 EDT
        let special = hours(vec![HoursException {
            date: "2026-07-06".into(),
            closed: false,
            ranges: vec![TimeRange {
                open: "10:00".into(),
                close: "14:00".into(),
            }],
        }]);
        assert_eq!(evaluate(&special, now).unwrap(), HoursResult::Open);

        // ...and closed outside that special window, ignoring the (empty)
        // Monday weekly schedule.
        let later = datetime!(2026-07-06 19:00 UTC); // 15:00 EDT
        assert_eq!(evaluate(&special, later).unwrap(), HoursResult::Closed);
    }

    #[test]
    fn validate_rejects_bad_timezone() {
        let err = validate_config(&open_11_to_22(), "Mars/Olympus", &[]).unwrap_err();
        assert!(matches!(err, HoursError::UnknownTimezone(_)));
    }

    #[test]
    fn validate_rejects_overnight_range() {
        let overnight = WeeklySchedule {
            fri: vec![TimeRange {
                open: "22:00".into(),
                close: "02:00".into(),
            }],
            ..Default::default()
        };
        let err = validate_config(&overnight, "America/New_York", &[]).unwrap_err();
        assert!(matches!(err, HoursError::NonPositiveRange { .. }));
    }

    #[test]
    fn validate_rejects_malformed_time_and_date() {
        let bad_time = WeeklySchedule {
            mon: vec![TimeRange {
                open: "9am".into(),
                close: "17:00".into(),
            }],
            ..Default::default()
        };
        assert!(matches!(
            validate_config(&bad_time, "UTC", &[]).unwrap_err(),
            HoursError::BadTime(_)
        ));

        let bad_date = vec![HoursException {
            date: "July 7".into(),
            closed: true,
            ranges: vec![],
        }];
        assert!(matches!(
            validate_config(&open_11_to_22(), "UTC", &bad_date).unwrap_err(),
            HoursError::BadDate(_)
        ));
    }
}
