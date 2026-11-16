// 2026-11-15 — LATE / OVERDUE uses the DATE in the business timezone.
//
// A due date is a calendar date. Before this change "late" was decided with
// the server's clock zone (UTC on the host), so a job due today turned LATE at
// 4:00 PM Pacific — the moment UTC crossed midnight — and the same job could
// be late on the board (server clock) but not on its own page (browser clock).
// New Job also stored the date at midnight UTC, which displays as the day
// before in Pacific time.
//
// Rule now (app/lib/business-date.ts): due DATE = the stored timestamp's UTC
// calendar date; TODAY = the date in America/Los_Angeles; late only when the
// due date is before today. Every instant below is an explicit UTC time, so
// these tests give the same answer on any machine in any timezone.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  businessDateKey,
  businessTodayCutoff,
  dueDateKey,
  dueInDays,
  formatDueDate,
  isPastDueDate,
  parseDueDateInput,
} from "../app/lib/business-date";
import { isJobOverdue, toBoardCard } from "../app/lib/simple-production";

// Pacific Standard Time in November is UTC-8; Pacific Daylight Time in July is UTC-7.
const at = (utc: string) => new Date(utc);
const NOV15_1130PM_PT = at("2026-11-16T07:30:00Z");
const NOV16_0900AM_PT = at("2026-11-16T17:00:00Z");
const NOV16_0400PM_PT = at("2026-11-17T00:00:00Z"); // UTC midnight — where the old rule flipped to LATE
const NOV16_1130PM_PT = at("2026-11-17T07:30:00Z");
const NOV16_1159PM_PT = at("2026-11-17T07:59:59Z");
const NOV17_MIDNIGHT_PT = at("2026-11-17T08:00:00Z");
const NOV17_1201AM_PT = at("2026-11-17T08:01:00Z");

// The two ways a due date of 2026-11-16 is stored today.
const DUE_NOON = "2026-11-16T12:00:00.000Z"; // Job settings / calendar
const DUE_MIDNIGHT = "2026-11-16T00:00:00.000Z"; // jobs created by New Job before this fix
const job = (dueDate: unknown, status = "printing") => ({ id: "j1", status, dueDate, items: [] });

describe("business timezone", () => {
  it("is America/Los_Angeles, and 'today' follows the Pacific calendar, not the UTC one", () => {
    expect(BUSINESS_TIME_ZONE).toBe("America/Los_Angeles");
    expect(businessDateKey(NOV15_1130PM_PT)).toBe("2026-11-15");
    expect(businessDateKey(NOV16_0400PM_PT)).toBe("2026-11-16"); // already Nov 17 in UTC
    expect(businessDateKey(NOV16_1159PM_PT)).toBe("2026-11-16");
    expect(businessDateKey(NOV17_MIDNIGHT_PT)).toBe("2026-11-17");
    // daylight time (UTC-7)
    expect(businessDateKey(at("2026-07-11T06:59:59Z"))).toBe("2026-07-10");
    expect(businessDateKey(at("2026-07-11T07:00:00Z"))).toBe("2026-07-11");
  });

  it("a stored due date keeps its calendar date in both storage forms", () => {
    expect(dueDateKey(DUE_NOON)).toBe("2026-11-16");
    expect(dueDateKey(DUE_MIDNIGHT)).toBe("2026-11-16");
    expect(dueDateKey(new Date(DUE_NOON))).toBe("2026-11-16");
    expect(dueDateKey("2026-11-16")).toBe("2026-11-16");
    for (const empty of [null, undefined, "", "not a date"]) expect(dueDateKey(empty)).toBeNull();
  });
});

describe.each([["noon UTC (Job settings / calendar)", DUE_NOON], ["midnight UTC (older New Job rows)", DUE_MIDNIGHT]])("a job due 2026-11-16, stored at %s", (_label, due) => {
  it("11:30 PM Pacific the night BEFORE: not late", () => {
    expect(isJobOverdue(job(due), NOV15_1130PM_PT)).toBe(false);
    expect(dueInDays(due, NOV15_1130PM_PT)).toBe(1);
  });

  it("on its due date it is never late — 9:00 AM, 4:00 PM (UTC midnight), 11:30 PM and 11:59 PM Pacific", () => {
    for (const now of [NOV16_0900AM_PT, NOV16_0400PM_PT, NOV16_1130PM_PT, NOV16_1159PM_PT]) {
      expect(isJobOverdue(job(due), now), now.toISOString()).toBe(false);
      expect(isPastDueDate(due, now), now.toISOString()).toBe(false);
      expect(dueInDays(due, now), now.toISOString()).toBe(0);
    }
  });

  it("it becomes late at midnight Pacific after its due date — not before", () => {
    expect(isJobOverdue(job(due), NOV17_MIDNIGHT_PT)).toBe(true);
    expect(isJobOverdue(job(due), NOV17_1201AM_PT)).toBe(true);
    expect(dueInDays(due, NOV17_1201AM_PT)).toBe(-1);
  });

  it("the board card and the job page reach the same answer for the same moment", () => {
    for (const [now, late] of [[NOV16_0400PM_PT, false], [NOV16_1130PM_PT, false], [NOV17_1201AM_PT, true]] as Array<[Date, boolean]>) {
      expect(toBoardCard(job(due), now).overdue, now.toISOString()).toBe(late); // board (server)
      expect(isJobOverdue(job(due), now), now.toISOString()).toBe(late); // job page
    }
  });

  it("it shows as Nov 16 everywhere (never the day before)", () => {
    expect(formatDueDate(due, { month: "short", day: "numeric" }, "en-US")).toBe("Nov 16");
    expect(formatDueDate(due, undefined, "en-US")).toBe("11/16/2026");
  });
});

describe("late rule — the rest of it", () => {
  it("fulfilled, completed and cancelled jobs are never late; a job with no due date is never late", () => {
    for (const status of ["completed", "shipped", "picked_up", "cancelled"]) expect(isJobOverdue(job("2026-01-01T12:00:00Z", status), NOV17_1201AM_PT), status).toBe(false);
    for (const status of ["new", "prepress", "printing", "qc", "packing", "ready_for_pickup", "on_hold", "reprint_needed"]) expect(isJobOverdue(job("2026-01-01T12:00:00Z", status), NOV17_1201AM_PT), status).toBe(true);
    for (const due of [null, undefined, "", "garbage"]) expect(isJobOverdue(job(due), NOV17_1201AM_PT)).toBe(false);
  });

  it("daylight time: due July 10 is on time until 11:59 PM PDT and late at midnight PDT", () => {
    expect(isPastDueDate("2026-07-10T12:00:00Z", at("2026-07-11T06:59:59Z"))).toBe(false);
    expect(isPastDueDate("2026-07-10T12:00:00Z", at("2026-07-11T07:00:00Z"))).toBe(true);
  });

  it("month and year boundaries count calendar days", () => {
    expect(dueInDays("2026-12-01T12:00:00Z", at("2026-12-01T07:30:00Z"))).toBe(1); // still Nov 30 in Pacific
    expect(dueInDays("2027-01-01T12:00:00Z", at("2027-01-01T07:59:00Z"))).toBe(1); // still Dec 31 in Pacific
    expect(dueInDays("2026-12-31T12:00:00Z", at("2027-01-01T08:00:00Z"))).toBe(-1);
    expect(dueInDays(null)).toBeNull();
  });

  it("Home counts late jobs with the same cutoff: due before the start of today's Pacific date", () => {
    // 4:30 PM Pacific on Nov 16 (already Nov 17 in UTC): the cutoff is still Nov 16
    expect(businessTodayCutoff(at("2026-11-17T00:30:00Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    const cutoff = businessTodayCutoff(NOV16_1130PM_PT).getTime();
    expect(new Date(DUE_NOON).getTime() < cutoff).toBe(false); // due today: not counted
    expect(new Date(DUE_MIDNIGHT).getTime() < cutoff).toBe(false);
    expect(new Date("2026-11-15T12:00:00Z").getTime() < cutoff).toBe(true); // due yesterday: counted
    expect(new Date("2026-11-15T00:00:00Z").getTime() < cutoff).toBe(true);
    const home = readFileSync("app/routes/app._index.tsx", "utf8");
    expect(home).toContain("const startOfToday = businessTodayCutoff(now);");
    expect(home).not.toContain("new Date(now.getFullYear(), now.getMonth(), now.getDate())");
  });
});

describe("New Job stores a picked date at noon UTC (it used to be midnight UTC = the previous afternoon in Pacific)", () => {
  it("parses a date-picker value, keeps a full timestamp, and never invents a date", () => {
    expect(parseDueDateInput("2026-11-16")?.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(parseDueDateInput(" 2026-11-16 ")?.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(parseDueDateInput("2026-11-16T20:15:00Z")?.toISOString()).toBe("2026-11-16T20:15:00.000Z");
    for (const empty of ["", null, undefined, "tomorrow-ish"]) expect(parseDueDateInput(empty)).toBeNull();
    // and that stored value reads back as the same date, on time all day
    const stored = parseDueDateInput("2026-11-16")!;
    expect(dueDateKey(stored)).toBe("2026-11-16");
    expect(isPastDueDate(stored, NOV16_1159PM_PT)).toBe(false);
  });

  it("the job-creation service, the board, the job page, the Advanced view and the calendar all use the shared helpers", () => {
    const read = (path: string) => readFileSync(path, "utf8");
    expect(read("app/lib/production-job-source.server.ts")).toContain("return parseDueDateInput(clean(source.payload.dueDate));");
    expect(read("app/lib/simple-production.ts")).toContain("return isPastDueDate(due, now);");
    expect(read("app/routes/app.erp.production-board.tsx")).toContain('return formatDueDate(card.dueDate, { month: "short", day: "numeric" });');
    expect(read("app/routes/app.erp.production-job.$id.tsx")).toContain("formatDueDate(job.dueDate)");
    const advanced = read("app/routes/app.erp.production.tsx");
    expect(advanced).toContain('return { text: formatDueDate(job.dueDate), tone: isJobOverdue(job) ? "critical" : undefined };');
    expect(advanced).not.toContain("Date.now() - 24 * 60 * 60 * 1000");
    const calendar = read("app/routes/app.erp.production-calendar.tsx");
    expect(calendar).toContain("return dueInDays(to) ?? 0;");
    expect(calendar).toContain("const due = new Date(`${businessDateKey()}T12:00:00.000Z`);"); // "today + N days" starts from the Pacific date
    // no page decides lateness with the machine's local midnight any more
    for (const path of ["app/lib/simple-production.ts", "app/routes/app._index.tsx"]) expect(read(path)).not.toMatch(/new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)\)/);
  });
});
