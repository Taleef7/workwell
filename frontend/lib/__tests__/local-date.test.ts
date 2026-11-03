/**
 * The browser's own calendar (#882): every default year, every "today" and every January-to-March check
 * reads the local date, which in Hawaii differs from UTC's from 2 PM to midnight.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

import { inCloseOutWindow, localIsoDate, localYear, newYearListNote } from "../local-date";

describe("the close-out window", () => {
  it("is January to March, by the local month", () => {
    expect([0, 1, 2].map((m) => inCloseOutWindow(new Date(2027, m, 15)))).toEqual([true, true, true]);
    expect(inCloseOutWindow(new Date(2027, 2, 31, 23, 59))).toBe(true);
    expect(inCloseOutWindow(new Date(2027, 3, 1, 0, 0))).toBe(false);
    expect(inCloseOutWindow(new Date(2026, 11, 31, 23, 59))).toBe(false);
  });

  it("an open list's note names the year that ended and the one that began, and only in the window", () => {
    setSubject("patient");
    expect(newYearListNote(new Date(2027, 1, 1))).toBe(
      "2026's gaps closed when 2027 began. 2027's gaps appear as patients are seen, so this list starts short in January.",
    );
    expect(newYearListNote(new Date(2027, 3, 1))).toBeNull();
  });

  it("is a patient deployment's only: an employee deployment's half-years and seasons do not turn on 1 January", () => {
    setSubject("employee");
    try {
      expect(newYearListNote(new Date(2027, 1, 1))).toBeNull();
    } finally {
      setSubject("patient");
    }
  });
});

describe("in Hawaii on the evening of 31 December", () => {
  const before = process.env.TZ;
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  beforeAll(() => {
    process.env.TZ = "Pacific/Honolulu";
  });
  afterAll(() => {
    process.env.TZ = before ?? resolved;
  });

  it("today is still 31 December 2026, while UTC says 1 January 2027", () => {
    const evening = new Date("2027-01-01T05:00:00Z");
    expect(evening.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(localIsoDate(evening)).toBe("2026-12-31");
    expect(localYear(evening)).toBe(2026);
    expect(inCloseOutWindow(evening)).toBe(false);
  });
});
