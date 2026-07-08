import { describe, expect, it } from "vitest";

import {
  AGENT_AUTH_FAILURE_BRAKE_LIMIT,
  AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES,
  AGENT_INTAKE_SCOPE,
  AGENT_RATE_LIMIT_BURST_PER_MINUTE,
  AGENT_RATE_LIMIT_PER_HOUR,
  AGENT_REPLAY_WINDOW_MINUTES,
  credentialAllowsIntake,
  familyAllowed,
} from "../app/lib/agent-security.server";

describe("rate limit constants", () => {
  it("matches the owner-approved values", () => {
    expect(AGENT_RATE_LIMIT_PER_HOUR).toBe(60);
    expect(AGENT_RATE_LIMIT_BURST_PER_MINUTE).toBe(10);
    expect(AGENT_AUTH_FAILURE_BRAKE_LIMIT).toBe(100);
    expect(AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES).toBe(5);
    expect(AGENT_REPLAY_WINDOW_MINUTES).toBe(10);
    expect(AGENT_INTAKE_SCOPE).toBe("intake:create");
  });
});

describe("credentialAllowsIntake", () => {
  it("grandfathers null/undefined scopes as allowed", () => {
    expect(credentialAllowsIntake(null)).toBe(true);
    expect(credentialAllowsIntake(undefined)).toBe(true);
  });

  it("allows scope lists that include intake:create", () => {
    expect(credentialAllowsIntake(["intake:create"])).toBe(true);
    expect(credentialAllowsIntake(["INTAKE:CREATE"])).toBe(true);
    expect(credentialAllowsIntake(["review_queue:read", "intake:create"])).toBe(true);
  });

  it("denies scope lists without intake:create", () => {
    expect(credentialAllowsIntake([])).toBe(false);
    expect(credentialAllowsIntake(["review_queue:read"])).toBe(false);
    expect(credentialAllowsIntake(["quote_draft:prepare"])).toBe(false);
  });

  it("denies malformed non-null scope shapes safely", () => {
    expect(credentialAllowsIntake("intake:create")).toBe(false);
    expect(credentialAllowsIntake({ scope: "intake:create" })).toBe(false);
    expect(credentialAllowsIntake(42)).toBe(false);
    expect(credentialAllowsIntake([42, {}, null])).toBe(false);
  });
});

describe("familyAllowed", () => {
  it("allows all families when the restriction is null/undefined", () => {
    expect(familyAllowed(null, "jars")).toBe(true);
    expect(familyAllowed(undefined, "custom-other")).toBe(true);
  });

  it("accepts a normalized family present in the list", () => {
    expect(familyAllowed(["jars", "banners"], "jars")).toBe(true);
    expect(familyAllowed(["LABELS-STICKERS"], "labels-stickers")).toBe(true);
  });

  it("denies families not in the list", () => {
    expect(familyAllowed(["jars"], "banners")).toBe(false);
    expect(familyAllowed([], "jars")).toBe(false);
  });

  it("denies malformed restriction shapes safely", () => {
    expect(familyAllowed("jars", "jars")).toBe(false);
    expect(familyAllowed({ family: "jars" }, "jars")).toBe(false);
  });
});
