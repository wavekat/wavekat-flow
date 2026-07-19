// `hours` component config checks — the TypeScript twin of the Rust
// engine's `hours.rs` `validate_config`. Same rules: every time/date
// string parses, every range is positive (open strictly before close;
// overnight ranges are not a v1 feature), and the timezone resolves.

import type { HoursException, TimeRange, WeeklySchedule } from './model.js';
import { WEEKDAYS } from './model.js';
import type { Issue } from './issues.js';

/**
 * `"HH:MM"` (24-hour, zero-padded — `9:00` is rejected like the Rust
 * side's `[hour]:[minute]` format) → minutes since midnight, or `null`.
 */
export function parseTimeMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Strict `"YYYY-MM-DD"` with a real calendar check (leap years included). */
export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

/**
 * Whether a timezone name resolves. The Rust engine resolves against
 * the bundled IANA db; `Intl` is the runtime equivalent here (Workers
 * and browsers both ship full ICU). Offset strings (`"+05:00"`) are
 * rejected up front — some engines' `Intl` accepts them, the daemon
 * does not.
 */
export function isValidTimezone(name: string): boolean {
  if (name === '' || name.startsWith('+') || name.startsWith('-')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function checkRange(node: string, range: TimeRange, issues: Issue[]): void {
  const open = parseTimeMinutes(range.open);
  const close = parseTimeMinutes(range.close);
  for (const [value, minutes] of [
    [range.open, open],
    [range.close, close],
  ] as const) {
    if (minutes === null) {
      issues.push({
        severity: 'error',
        code: 'bad_time',
        message: `hours node "${node}": time "${value}" is not HH:MM`,
        node,
        params: { value },
      });
    }
  }
  if (open !== null && close !== null && open >= close) {
    issues.push({
      severity: 'error',
      code: 'non_positive_range',
      message: `hours node "${node}": range open "${range.open}" is not before close "${range.close}"`,
      node,
      params: { open: range.open, close: range.close },
    });
  }
}

/**
 * All problems in an `hours` config. Unlike the Rust twin this collects
 * every issue instead of stopping at the first — an editor wants the
 * full list; a config is valid on one side iff it is on the other.
 */
export function validateHours(
  node: string,
  schedule: WeeklySchedule,
  timezone: string,
  exceptions: HoursException[],
): Issue[] {
  const issues: Issue[] = [];
  if (!isValidTimezone(timezone)) {
    issues.push({
      severity: 'error',
      code: 'unknown_timezone',
      message: `hours node "${node}": unknown IANA timezone "${timezone}"`,
      node,
      params: { timezone },
    });
  }
  for (const day of WEEKDAYS) {
    for (const range of schedule[day] ?? []) checkRange(node, range, issues);
  }
  for (const exception of exceptions) {
    if (!isValidDate(exception.date)) {
      issues.push({
        severity: 'error',
        code: 'bad_date',
        message: `hours node "${node}": date "${exception.date}" is not YYYY-MM-DD`,
        node,
        params: { value: exception.date },
      });
    }
    for (const range of exception.ranges ?? []) checkRange(node, range, issues);
  }
  return issues;
}
