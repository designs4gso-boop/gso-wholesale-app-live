// 2026-11-15 — DATE-ONLY due dates in the BUSINESS timezone.
//
// A production due date is a calendar DATE (the form is a date picker), but it
// is stored as a timestamp: noon server time from Job settings / the calendar,
// or midnight UTC from New Job. "Is it late?" was answered with the server's
// own clock and zone (UTC on the host), so a job due today turned LATE at
// 4:00 PM Pacific (midnight UTC), and the same job could be late on the board
// but not on its own page.
//
// One rule now, the same on the server and in the browser:
//   - the due DATE is the UTC calendar date of the stored timestamp (correct
//     for both storage forms above);
//   - TODAY is the calendar date in the business timezone;
//   - a job is late only when its due date is BEFORE today.
// Pure: no db, no auth, no server-only import (safe in route components).

/** GSO's business timezone (owner, 2026-11-15). No per-shop timezone is stored, so this is the one authority. */
export const BUSINESS_TIME_ZONE = "America/Los_Angeles";

const KEY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD for "today" in the business timezone. */
export function businessDateKey(now: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** YYYY-MM-DD of a stored due date (its intended calendar date), or null when there is none / it is not a date. */
export function dueDateKey(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && KEY.test(value.trim())) return value.trim();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const dayNumber = (key: string) => Math.round(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86_400_000);

/** Whole calendar days from today (business timezone) to the due date: 0 = due today, negative = past due. Null without a due date. */
export function dueInDays(value: unknown, now: Date = new Date()): number | null {
  const due = dueDateKey(value);
  return due ? dayNumber(due) - dayNumber(businessDateKey(now)) : null;
}

/** Past due = the due DATE is before today's date in the business timezone. Due today is never late. */
export function isPastDueDate(value: unknown, now: Date = new Date()): boolean {
  const days = dueInDays(value, now);
  return days != null && days < 0;
}

/** The first instant of today's business date as a UTC timestamp — the database cutoff for "due before today". */
export function businessTodayCutoff(now: Date = new Date()): Date {
  return new Date(`${businessDateKey(now)}T00:00:00.000Z`);
}

/** A date-picker value (YYYY-MM-DD) -> the timestamp stored for it (noon UTC, the same form Job settings uses on the host). */
export function parseDueDateInput(raw: unknown): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = KEY.test(text) ? new Date(`${text}T12:00:00.000Z`) : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Show a due date as its calendar date, identical on the server and in any browser timezone. */
export function formatDueDate(value: unknown, options: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" }, locale?: string): string {
  const key = dueDateKey(value);
  if (!key) return "";
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString(locale, { ...options, timeZone: "UTC" });
}
