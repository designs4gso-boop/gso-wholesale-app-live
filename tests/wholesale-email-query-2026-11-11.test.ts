// 2026-11-11 — App Proxy customer lookups search ONE exact email; caller text
// cannot add Shopify search syntax, and a non-matching result is ignored.
import { describe, expect, it } from "vitest";
import { exactEmailCustomerQuery, isSameEmail } from "../app/lib/wholesale.server";

describe("exact email customer query", () => {
  it("quotes the email and strips quotes/backslashes", () => {
    expect(exactEmailCustomerQuery("a@b.com")).toBe('email:"a@b.com"');
    expect(exactEmailCustomerQuery('x" OR tag:wholesale_approved')).toBe('email:"x OR tag:wholesale_approved"');
    expect(exactEmailCustomerQuery('a\\"@b.com')).toBe('email:"a@b.com"');
  });
  it("accepts only the exact requested email (case-insensitive)", () => {
    expect(isSameEmail("A@B.com", "a@b.com")).toBe(true);
    expect(isSameEmail("other@b.com", "a@b.com")).toBe(false);
    expect(isSameEmail(null, "")).toBe(false);
  });
});
