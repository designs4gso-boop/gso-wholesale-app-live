import { describe, expect, it } from "vitest";

import { approvalFromProofPortal, productionArtReadiness, recordApproval, registerNewVersion, type ApprovalRecord, type ArtVersion } from "../app/lib/ops/art-approval";
import { runArtPreflight } from "../app/lib/ops/art-preflight.server";

const now = new Date("2026-10-03T05:00:00Z");
const v1: ArtVersion = { versionId: "v1", fileHash: "sha256:a", fileName: "a.pdf", createdAt: now.toISOString() };

describe("art preflight", () => {
  const clean = { fileName: "a.pdf", artboardWidthIn: 4, artboardHeightIn: 5, colorSpace: "CMYK" as const, minRasterDpi: 300, hasCutlineLayer: true, fontsOutlined: true };

  it("passes clean 4x5 art and derives the GSO cutline", () => {
    const r = runArtPreflight({ family: "sticker-bags", widthIn: 4, heightIn: 5, cutType: "rectangular" }, [clean]);
    expect(r.status).toBe("PASS");
    expect(r.expectedCutline).toBe("3.875 x 4.875 in");
    expect(r.routing?.printer).toBe("mimaki");
    expect(r.technicalPassEligible).toBe(true);
  });

  it("fails on format, artboard mismatch, low dpi, no files and Mimaki+white", () => {
    expect(runArtPreflight({ family: "stickers-labels" }, []).status).toBe("FAIL");
    expect(runArtPreflight({ family: "stickers-labels", widthIn: 3, heightIn: 3 }, [{ ...clean, fileName: "a.docx" }]).findings.map((f) => f.code)).toContain("FORMAT_UNSUPPORTED");
    expect(runArtPreflight({ family: "stickers-labels", widthIn: 3, heightIn: 3 }, [clean]).findings.map((f) => f.code)).toContain("ARTBOARD_MISMATCH");
    expect(runArtPreflight({ family: "banners", widthIn: 4, heightIn: 5 }, [{ ...clean, minRasterDpi: 72 }]).status).toBe("FAIL");
    const m = runArtPreflight({ family: "stickers-labels", widthIn: 4, heightIn: 5, whiteLayers: 1, printerSelection: "mimaki" }, [clean]);
    expect(m.status).toBe("FAIL");
    expect(m.findings.map((f) => f.code)).toContain("MIMAKI_SPECIALTY_UNSUPPORTED");
  });

  it("warns on RGB, rotation, fonts, missing cutline and white coverage; NEEDS_DESIGNER on unknowns", () => {
    const w = runArtPreflight({ family: "stickers-labels", widthIn: 5, heightIn: 4, cutType: "contour", whiteLayers: 1 }, [{ ...clean, colorSpace: "RGB", fontsOutlined: false, hasCutlineLayer: false }]);
    expect(w.status).toBe("WARN");
    expect(w.routing?.printer).toBe("roland");
    expect(w.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["COLOR_SPACE", "ARTBOARD_ROTATED", "FONTS_NOT_OUTLINED", "CUTLINE_MISSING", "WHITE_COVERAGE_REQUIRED"]));
    const u = runArtPreflight({ family: "stickers-labels", widthIn: 4, heightIn: 5, cutType: "contour" }, [{ fileName: "a.ai" }]);
    expect(u.status).toBe("NEEDS_DESIGNER");
    expect(u.technicalPassEligible).toBe(false);
  });
});

describe("art approval contract", () => {
  it("agents may only record technical pass; customer and final need humans", () => {
    let records: ApprovalRecord[] = [];
    const t = recordApproval(records, { version: v1, state: "TECHNICAL_PREFLIGHT_PASSED", approverType: "agent", approverId: "art_preflight", source: "agent", now });
    expect(t.ok).toBe(true);
    if (t.ok) records = t.records;
    expect(recordApproval(records, { version: v1, state: "CUSTOMER_APPROVED", approverType: "agent", approverId: "x", source: "agent", now }).ok).toBe(false);
    expect(recordApproval(records, { version: v1, state: "FINAL_ART_APPROVED", approverType: "agent", approverId: "x", source: "agent", now }).ok).toBe(false);
    expect(recordApproval(records, { version: v1, state: "CUSTOMER_APPROVED", approverType: "staff", approverId: "s", source: "erp", now }).ok).toBe(false); // no evidence
    expect(recordApproval(records, { version: v1, state: "FINAL_ART_APPROVED", approverType: "owner", approverId: "o", source: "erp", now }).ok).toBe(false); // customer missing
    const c = recordApproval(records, { version: v1, state: "CUSTOMER_APPROVED", approverType: "staff", approverId: "s", source: "erp", onBehalfOfCustomer: true, evidence: "email from dana 10/02", now });
    expect(c.ok).toBe(true);
    if (c.ok) records = c.records;
    const f = recordApproval(records, { version: v1, state: "FINAL_ART_APPROVED", approverType: "staff", approverId: "s", source: "slack:U1", now });
    expect(f.ok).toBe(true);
    if (f.ok) records = f.records;
    expect(productionArtReadiness(records, v1).ready).toBe(true);
    const dup = recordApproval(records, { version: v1, state: "FINAL_ART_APPROVED", approverType: "staff", approverId: "s", source: "slack:U1", now });
    expect(dup.ok && dup.duplicate).toBe(true);
  });

  it("approvals bind to version + hash; a new version invalidates them", () => {
    let records: ApprovalRecord[] = [];
    const portal = approvalFromProofPortal({ proofStatus: "approved", proofApprovedAt: now, proofCustomerEmail: "d@example.com" }, v1);
    expect(portal?.approverType).toBe("customer_portal");
    const r = recordApproval(records, portal!);
    if (r.ok) records = r.records;
    expect(approvalFromProofPortal({ proofStatus: "sent" }, v1)).toBeNull();
    const sameIdNewHash: ArtVersion = { ...v1, fileHash: "sha256:b" };
    expect(productionArtReadiness(records, sameIdNewHash).states).toEqual([]);
    const inv = registerNewVersion(records, { ...v1, versionId: "v2", fileHash: "sha256:c" }, now);
    expect(inv.invalidated).toBe(1);
    expect(inv.records[0].invalidatedBy).toBe("v2");
    expect(recordApproval([], { version: { ...v1, fileHash: "" }, state: "TECHNICAL_PREFLIGHT_PASSED", approverType: "agent", approverId: "a", source: "s" }).ok).toBe(false);
  });
});
