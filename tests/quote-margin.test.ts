import { describe, expect, it } from "vitest";

import {
  LOW_MARGIN_APPROVAL_MARKER,
  LOW_MARGIN_THRESHOLD_PCT,
  itemMarginPct,
  lowMarginApprovalLine,
  quoteMarginState,
} from "../app/lib/quote-margin.server";

function item(overrides: Record<string, unknown> = {}) {
  return {
    productName: "Test item",
    sku: "TEST-1",
    quantity: 10,
    unitPrice: 10,
    unitCost: 5,
    ...overrides,
  };
}

describe("itemMarginPct", () => {
  it("computes actual margin from unitPrice and unitCost", () => {
    expect(itemMarginPct(item({ unitPrice: 10, unitCost: 5 }))).toBe(50);
    expect(itemMarginPct(item({ unitPrice: 10, unitCost: 6 }))).toBeCloseTo(40, 5);
  });

  it("returns null when unit price is not positive", () => {
    expect(itemMarginPct(item({ unitPrice: 0 }))).toBeNull();
    expect(itemMarginPct(item({ unitPrice: -5 }))).toBeNull();
  });
});

describe("quoteMarginState", () => {
  it("does not require approval for a healthy quote at or above the threshold", () => {
    const state = quoteMarginState({
      notes: "",
      items: [item({ unitPrice: 10, unitCost: 6 }), item({ unitPrice: 100, unitCost: 20 })],
    });

    expect(LOW_MARGIN_THRESHOLD_PCT).toBe(40);
    expect(state.isLowMargin).toBe(false);
    expect(state.approvalRequired).toBe(false);
    expect(state.approvalLabel).toBe("");
    expect(state.blockMessage).toBe("");
    expect(state.lowItems).toHaveLength(0);
  });

  it("requires approval for a below-threshold item and names it", () => {
    const state = quoteMarginState({
      notes: "",
      items: [item({ productName: "Thin sticker", unitPrice: 10, unitCost: 7 })],
    });

    expect(state.isLowMargin).toBe(true);
    expect(state.approvalRequired).toBe(true);
    expect(state.hasBelowThreshold).toBe(true);
    expect(state.hasUnknownCost).toBe(false);
    expect(state.approvalLabel).toBe("Low margin - approval required");
    expect(state.blockMessage).toContain("Thin sticker");
    expect(state.blockMessage).toContain("below 40%");
  });

  it("treats unknown cost (unitCost <= 0) as approval required with the unknown-cost label", () => {
    const state = quoteMarginState({
      notes: "",
      items: [item({ productName: "Resale jar", unitPrice: 10, unitCost: 0 })],
    });

    expect(state.isLowMargin).toBe(true);
    expect(state.hasUnknownCost).toBe(true);
    expect(state.hasBelowThreshold).toBe(false);
    expect(state.approvalLabel).toBe("Unknown cost - approval required");
    expect(state.blockMessage).toContain("unknown cost");
  });

  it("labels invalid price when unit price is not positive", () => {
    const state = quoteMarginState({
      notes: "",
      items: [item({ productName: "Broken line", unitPrice: 0, unitCost: 5 })],
    });

    expect(state.isLowMargin).toBe(true);
    expect(state.hasInvalidPrice).toBe(true);
    expect(state.approvalLabel).toBe("Invalid price - approval required");
    expect(state.blockMessage).toContain("invalid price");
  });

  it("shows the combined label when both below-threshold and unknown-cost items exist", () => {
    const state = quoteMarginState({
      notes: "",
      items: [
        item({ productName: "Thin sticker", unitPrice: 10, unitCost: 7 }),
        item({ productName: "Resale jar", unitPrice: 10, unitCost: 0 }),
      ],
    });

    expect(state.approvalLabel).toBe("Low margin / unknown cost - approval required");
    expect(state.lowItems).toHaveLength(2);
  });

  it("detects the approval marker and clears approvalRequired without weakening isLowMargin", () => {
    const items = [item({ unitPrice: 10, unitCost: 7 })];
    const blocked = quoteMarginState({ notes: "customer wants rush", items });
    const approved = quoteMarginState({
      notes: `customer wants rush\n${LOW_MARGIN_APPROVAL_MARKER}owner@example.com at 2026-07-07T00:00:00.000Z (threshold 40%, blended 30.0%, lowest item 30.0%): strategic deal`,
      items,
    });

    expect(blocked.approvalRequired).toBe(true);
    expect(approved.isLowMargin).toBe(true);
    expect(approved.isApproved).toBe(true);
    expect(approved.approvalRequired).toBe(false);
  });

  it("computes blended and lowest margins across items and quantities", () => {
    const state = quoteMarginState({
      notes: "",
      items: [
        item({ quantity: 10, unitPrice: 10, unitCost: 5 }),
        item({ quantity: 10, unitPrice: 10, unitCost: 8 }),
      ],
    });

    // revenue 200, cost 130 => blended 35%
    expect(state.blendedMarginPct).toBeCloseTo(35, 5);
    expect(state.lowestMarginPct).toBeCloseTo(20, 5);
    expect(state.hasBelowThreshold).toBe(true);
  });
});

describe("lowMarginApprovalLine", () => {
  it("contains marker, actor, threshold, blended, lowest, and reason", () => {
    const line = lowMarginApprovalLine({
      actor: "owner@example.com",
      blendedMarginPct: 33.333,
      lowestMarginPct: 21.5,
      reason: "strategic first order",
    });

    expect(line.startsWith(LOW_MARGIN_APPROVAL_MARKER)).toBe(true);
    expect(line).toContain("owner@example.com");
    expect(line).toContain("threshold 40%");
    expect(line).toContain("blended 33.3%");
    expect(line).toContain("lowest item 21.5%");
    expect(line).toContain("strategic first order");
  });

  it("prints n/a for the lowest margin when it is unknown", () => {
    const line = lowMarginApprovalLine({
      actor: "staff",
      blendedMarginPct: 0,
      lowestMarginPct: null,
      reason: "unknown cost approved",
    });

    expect(line).toContain("lowest item n/a");
  });
});
