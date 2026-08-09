// Phase 15G.1A — production-agent credential masking tests.
// Pure helper proofs + repo source pins. No Prisma, no Shopify, no
// server-module imports (repo test convention).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_MIN_LENGTH_FOR_SUFFIX,
  CREDENTIAL_PLACEHOLDER,
  credentialStatusLabel,
  maskCredential,
} from "../app/lib/security-guards-shared";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Realistic-shaped sample (NOT a live credential — generated for this test).
const SAMPLE_TOKEN = "gso_plog_9f31c07ab4de8812aa45cc90ffee1234deadbeef2349";

describe("maskCredential", () => {
  it("reports configured with a ****-prefixed 4-char suffix for real-length tokens", () => {
    const masked = maskCredential(SAMPLE_TOKEN);
    expect(masked.configured).toBe(true);
    expect(masked.maskedSuffix).toBe("****2349");
  });

  it("never reveals more than the last 4 characters — the token cannot be reconstructed", () => {
    const masked = maskCredential(SAMPLE_TOKEN);
    const serialized = JSON.stringify(masked);
    expect(serialized.includes(SAMPLE_TOKEN)).toBe(false);
    expect(serialized.includes("gso_plog_")).toBe(false);
    // everything except the final 4 characters is absent from the output
    expect(serialized.includes(SAMPLE_TOKEN.slice(0, -4))).toBe(false);
    // the only token-derived content is exactly 4 trailing characters
    expect(masked.maskedSuffix?.replace(/^\*+/, "").length).toBe(4);
  });

  it("shows no suffix at all for short credentials (too easy to reconstruct)", () => {
    expect(maskCredential("short-tok")).toEqual({ configured: true, maskedSuffix: null });
    expect("short-tok".length).toBeLessThan(CREDENTIAL_MIN_LENGTH_FOR_SUFFIX);
  });

  it("reports not-configured for missing/blank values", () => {
    expect(maskCredential(null)).toEqual({ configured: false, maskedSuffix: null });
    expect(maskCredential(undefined)).toEqual({ configured: false, maskedSuffix: null });
    expect(maskCredential("   ")).toEqual({ configured: false, maskedSuffix: null });
    expect(maskCredential(12345 as unknown as string)).toEqual({ configured: false, maskedSuffix: null });
  });

  it("labels configured / not-configured states for the UI", () => {
    expect(credentialStatusLabel(maskCredential(SAMPLE_TOKEN))).toBe("Configured (****2349)");
    expect(credentialStatusLabel(maskCredential("short-tok"))).toBe("Configured");
    expect(credentialStatusLabel(maskCredential(""))).toBe("Not configured");
  });

  it("pins the setup-command placeholder", () => {
    expect(CREDENTIAL_PLACEHOLDER).toBe("<PRINT_INTAKE_TOKEN>");
  });
});

describe("loader payloads carry only masked credential state", () => {
  it("a serialized loader payload built the new way never contains the token", () => {
    // Mirrors what the four routes now send to the browser.
    const payload = {
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      credential: maskCredential(SAMPLE_TOKEN),
      uploadTokenConfigured: Boolean(SAMPLE_TOKEN),
    };
    const serialized = JSON.stringify(payload);
    expect(serialized.includes(SAMPLE_TOKEN)).toBe(false);
    expect(serialized.includes("gso_plog_")).toBe(false);
    expect(serialized).toContain("****2349");
    expect(payload.credential.configured).toBe(true);
  });
});

describe("source pins — no route renders or serializes a full agent token", () => {
  const printIntake = readSource("app/routes/app.erp.print-intake.tsx");
  const printLogSettings = readSource("app/routes/app.erp.print-log-settings.tsx");
  const ripImports = readSource("app/routes/app.erp.rip-imports.tsx");
  const costCalculator = readSource("app/routes/app.erp.cost-calculator.tsx");

  it("Print Intake masks the credential and keeps routing wiring intact", () => {
    expect(printIntake).toContain("maskCredential(setting.uploadToken)");
    expect(printIntake).toContain("credentialStatusLabel");
    expect(printIntake.includes("uploadToken: setting.uploadToken")).toBe(false);
    expect(printIntake.includes("{uploadToken}")).toBe(false);
    // routing/outcome behavior untouched — same decode wiring as before
    expect(printIntake).toContain("decodeIntakeOutcomes(setting.notes)");
  });

  it("Print Log Settings never sends the raw token in loader data, HTML, or the PowerShell example", () => {
    expect(printLogSettings).toContain("credential: maskCredential(setting.uploadToken)");
    // the old raw render + template embed used this exact member expression
    expect(printLogSettings.includes("{setting.uploadToken}")).toBe(false);
    // the PowerShell example and setup copy use the imported placeholder constant
    expect(printLogSettings).toContain("CREDENTIAL_PLACEHOLDER");
    expect(printLogSettings).toContain('$Token = "${CREDENTIAL_PLACEHOLDER}"');
    // explicit non-secret projection instead of returning the whole row
    expect(printLogSettings).toContain("expectedTicketPattern: setting.expectedTicketPattern");
    // the ONLY full-token emission is the one-time rotation response
    expect(printLogSettings).toContain("rotatedTokenOnce");
    // no token logging
    expect(/console\.(log|error|warn)\([^)]*[Tt]oken/.test(printLogSettings)).toBe(false);
  });

  it("RIP Imports shows masked status only", () => {
    expect(ripImports).toContain("credential: maskCredential(setting.uploadToken)");
    expect(ripImports.includes("{setting.uploadToken}")).toBe(false);
  });

  it("Cost Calculator sync panel sends a configured flag, not the token", () => {
    expect(costCalculator).toContain("uploadTokenConfigured");
    expect(costCalculator.includes("uploadToken: setting?.uploadToken")).toBe(false);
    expect(costCalculator.includes('-Token "{uploadToken}"')).toBe(false);
    expect(costCalculator.includes("<code>{uploadToken}</code>")).toBe(false);
  });
});
