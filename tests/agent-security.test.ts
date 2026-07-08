import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AGENT_AUTH_FAILURE_BRAKE_LIMIT,
  AGENT_AUTH_FAILURE_BRAKE_WINDOW_MINUTES,
  AGENT_INTAKE_SCOPE,
  AGENT_RATE_LIMIT_BURST_PER_MINUTE,
  AGENT_RATE_LIMIT_PER_HOUR,
  AGENT_REPLAY_WINDOW_MINUTES,
  AGENT_TIMESTAMP_TOLERANCE_MS,
  credentialAllowsIntake,
  familyAllowed,
  parseAgentBearer,
  parseAgentTimestamp,
  sha256Hex,
  timingSafeEqualString,
  verifyAgentSignature,
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

describe("parseAgentBearer", () => {
  it("parses the canonical dot format, splitting on the first dot", () => {
    expect(parseAgentBearer("Bearer gso_abc.secret123")).toEqual({ tokenId: "gso_abc", tokenSecret: "secret123" });
    expect(parseAgentBearer("Bearer id.se.cret")).toEqual({ tokenId: "id", tokenSecret: "se.cret" });
    expect(parseAgentBearer("bearer gso_abc.secret123")?.tokenId).toBe("gso_abc");
  });

  it("tolerates the legacy colon separator when no valid dot exists", () => {
    expect(parseAgentBearer("Bearer gso_abc:secret123")).toEqual({ tokenId: "gso_abc", tokenSecret: "secret123" });
  });

  it("rejects malformed headers", () => {
    expect(parseAgentBearer(null)).toBeNull();
    expect(parseAgentBearer("")).toBeNull();
    expect(parseAgentBearer("Bearer nodothere")).toBeNull();
    expect(parseAgentBearer("Bearer .secretonly")).toBeNull();
    expect(parseAgentBearer("Bearer idonly.")).toBeNull();
    expect(parseAgentBearer("Basic gso_abc.secret")).toBeNull();
  });
});

describe("parseAgentTimestamp", () => {
  const NOW = 1_782_000_000_000; // fixed millisecond clock for determinism

  it("accepts unix milliseconds inside the tolerance window", () => {
    expect(parseAgentTimestamp(String(NOW), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBe(NOW);
    expect(parseAgentTimestamp(String(NOW - 4 * 60 * 1000), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).not.toBeNull();
  });

  it("accepts unix seconds by normalizing to milliseconds (the 10A.1 root-cause case)", () => {
    const seconds = Math.floor(NOW / 1000);
    expect(parseAgentTimestamp(String(seconds), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBe(seconds * 1000);
  });

  it("rejects timestamps outside the tolerance window", () => {
    expect(parseAgentTimestamp(String(NOW - 6 * 60 * 1000), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBeNull();
    expect(parseAgentTimestamp(String(Math.floor(NOW / 1000) - 6 * 60), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBeNull();
  });

  it("rejects garbage and accepts parseable date strings", () => {
    expect(parseAgentTimestamp("not-a-time", AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBeNull();
    expect(parseAgentTimestamp(new Date(NOW).toISOString(), AGENT_TIMESTAMP_TOLERANCE_MS, NOW)).toBe(NOW);
  });
});

describe("auth crypto", () => {
  it("sha256Hex matches the known test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("timingSafeEqualString compares safely", () => {
    expect(timingSafeEqualString("same", "same")).toBe(true);
    expect(timingSafeEqualString("same", "diff")).toBe(false);
    expect(timingSafeEqualString("short", "longer-string")).toBe(false);
  });

  it("verifyAgentSignature round-trips an HMAC computed the documented way", () => {
    const secret = "test-secret";
    const timestamp = "1782000000000";
    const rawBody = '{"productFamily":"labels-stickers","quantity":"100"}';
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

    expect(verifyAgentSignature(secret, timestamp, rawBody, expected)).toBe(true);
    expect(verifyAgentSignature(secret, timestamp, rawBody, expected.toUpperCase())).toBe(true);
    expect(verifyAgentSignature("wrong-secret", timestamp, rawBody, expected)).toBe(false);
    expect(verifyAgentSignature(secret, "1782000000001", rawBody, expected)).toBe(false);
    expect(verifyAgentSignature(secret, timestamp, rawBody + " ", expected)).toBe(false);
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
