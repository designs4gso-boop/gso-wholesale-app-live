// 2026-11-12 — calibration monitoring (no invented sample size, never auto-change)
// and the customer-notification foundation (never sends).

import { describe, expect, it } from "vitest";
import { CALIBRATION_REVIEW_VARIANCE_PCT, configuredMinSamples, evaluateCalibrationVariance } from "../app/lib/calibration-monitoring";
import { CUSTOMER_NOTIFICATION_CHANNELS, CUSTOMER_NOTIFICATION_EVENTS, planCustomerNotification } from "../app/lib/customer-notification-events";

const jobs = (n: number, pct: number) => Array.from({ length: n }, (_v, i) => ({ estimated: 100, actual: 100 * (1 + pct / 100), at: new Date(2026, 10, i + 1) }));

describe("calibration monitoring", () => {
  it("without an owner-configured minimum sample count it NEVER recommends a review", () => {
    expect(configuredMinSamples({})).toBeNull();
    const r = evaluateCalibrationVariance(jobs(50, 40), null);
    expect(r.status).toBe("SAMPLE_SIZE_AUTHORITY_MISSING");
    expect(r.autoChange).toBe(false);
  });

  it("uses the approved 10% and the owner's count; a single noisy job is not 'sustained'", () => {
    expect(CALIBRATION_REVIEW_VARIANCE_PCT).toBe(10);
    expect(configuredMinSamples({ GSO_CALIBRATION_REVIEW_MIN_SAMPLES: "8" })).toBe(8);
    expect(configuredMinSamples({ GSO_CALIBRATION_REVIEW_MIN_SAMPLES: "1" })).toBeNull(); // a single job is never a sample size
    expect(evaluateCalibrationVariance(jobs(3, 40), 8).status).toBe("INSUFFICIENT_SAMPLES");
    expect(evaluateCalibrationVariance(jobs(8, 9.9), 8).status).toBe("WITHIN_TOLERANCE");
    const review = evaluateCalibrationVariance(jobs(8, 12), 8);
    expect(review).toMatchObject({ status: "OWNER_REVIEW_RECOMMENDED", direction: "actual_higher", autoChange: false, samplesUsed: 8 });
    // one outlier among normal jobs does not trigger it
    const mixed = [...jobs(7, 1), { estimated: 100, actual: 160, at: new Date(2026, 10, 30) }];
    expect(evaluateCalibrationVariance(mixed, 8).status).toBe("WITHIN_TOLERANCE");
  });
});

describe("customer notification foundation", () => {
  it("defines the owner's events and channels and never sends", () => {
    expect(CUSTOMER_NOTIFICATION_EVENTS.map((e) => e.key)).toEqual(["proof_ready", "payment_required", "in_production", "ready_for_pickup", "shipped"]);
    expect([...CUSTOMER_NOTIFICATION_CHANNELS]).toEqual(["email", "sms"]);
    for (const e of CUSTOMER_NOTIFICATION_EVENTS) for (const c of CUSTOMER_NOTIFICATION_CHANNELS) {
      expect(planCustomerNotification(e.key, c, true)).toMatchObject({ send: false, reason: "NO_PROVIDER_CONFIGURED" });
    }
    expect(planCustomerNotification("marketing_blast", "email", true).reason).toBe("UNKNOWN_EVENT");
    expect(planCustomerNotification("shipped", "sms", false, { email: "x", sms: "y" })).toMatchObject({ send: false, reason: "PREFERENCE_DISABLED" });
  });
});
