import db from "../db.server";
import { appendIntakeAudit, dispositionOf } from "../lib/print-intake-review.server";

// Phase 15H.3 — intake disposition endpoint. The agent's local JSONL ledger
// is a CACHE: before honoring a ledgered needs_review/rejected skip, the
// agent asks this endpoint what the SERVER currently says about the hash.
// Token-authenticated (existing PrintLogAutoImportSetting.uploadToken — no
// second credential system); shop derived from the token; minimal payload
// (no pricing/cost/customer data). Side effect (deliberate, idempotent): a
// ledgered hash the server has never seen gets a durable review row
// (legacy_ledger_blocked) so the owner can release it from the ERP —
// that is how pre-15F.0J.5 ledger debt becomes visible without touching
// the agent ledger by hand.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const HASH_RE = /^[0-9a-f]{64}$/;

export async function action({ request }: { request: Request }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400);
  }
  const token = String(body.token || "").trim();
  if (!token) return json({ ok: false, error: "Missing upload token." }, 401);
  const setting = await db.printLogAutoImportSetting.findUnique({ where: { uploadToken: token } });
  if (!setting || !setting.enabled) return json({ ok: false, error: "Invalid or disabled upload token." }, 403);

  // 15H.5: pending-retries list — ONE bounded call per agent pass returns the
  // hashes whose server disposition says re-process (owner reprint / release /
  // assignment), so a ledger-"routed" hash can be re-delivered without the
  // agent ever polling per-file. Minimal payload; no job/cost data.
  if (body.pending === true) {
    const rows = await db.printIntake.findMany({
      where: { shop: setting.shop, status: { in: ["retry_allowed", "assigned"] } },
      select: { fileHashSha256: true, originalFilename: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return json({ ok: true, pending: rows.map((row) => ({ hash: row.fileHashSha256, fileName: row.originalFilename, status: row.status })) });
  }

  const rawItems = Array.isArray(body.items)
    ? (body.items as Array<Record<string, unknown>>)
    : [{ hash: body.hash, fileName: body.fileName }];
  const items = rawItems
    .map((item) => ({
      hash: String(item?.hash || "").trim().toLowerCase(),
      fileName: String(item?.fileName || "").trim().slice(0, 200),
    }))
    .filter((item) => HASH_RE.test(item.hash))
    .slice(0, 50);
  if (!items.length) return json({ ok: false, error: "Provide hash (or items[]) with full SHA-256 value(s)." }, 400);

  const results: Record<string, unknown>[] = [];
  for (const item of items) {
    let row = await db.printIntake.findUnique({
      where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: item.hash } },
    });
    if (!row && item.fileName) {
      // Ledger-blocked file the server never recorded (pre-15F.0J.5 review):
      // create the durable review object so the ERP queue can show it.
      try {
        row = await db.printIntake.create({
          data: {
            shop: setting.shop,
            originalFilename: item.fileName,
            fileHashSha256: item.hash,
            status: "review",
            reviewReason: "legacy_ledger_blocked",
            rawParsedHints: appendIntakeAudit(null, {
              at: new Date().toISOString(),
              actor: "print-intake-agent",
              action: "review_row_created_from_ledger_reconciliation",
              reason: "legacy_ledger_blocked",
            }),
          },
        });
      } catch {
        // unique race: another reconciliation won — read the winner
        row = await db.printIntake.findUnique({
          where: { shop_fileHashSha256: { shop: setting.shop, fileHashSha256: item.hash } },
        });
      }
    }
    const { disposition, retryAllowed } = dispositionOf(row);
    results.push({
      hash: item.hash,
      status: row?.status || "unknown",
      disposition,
      retryAllowed,
      reasonCode: row?.reviewReason || null,
      productionJobId: row?.generatedProductionJobId || row?.matchedProductionJobId || null,
      authoritativeTicket: row?.authoritativeTicket || null,
    });
  }
  return json({ ok: true, results });
}

export const loader = () =>
  new Response(
    JSON.stringify({ ok: true, endpoint: "POST JSON {token, hash|items:[{hash,fileName?}]} for intake disposition. Ledger is a cache; this is the truth." }),
    { headers: { "Content-Type": "application/json" } },
  );
