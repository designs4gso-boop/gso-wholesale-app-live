// Phase 15G.5E — owner-approved Stock Bag MOQ description update.
// Replaces the exact sentence "Minimum order 64 units" with
// "Minimum order 50 units" via productUpdate(product: { id, descriptionHtml })
// — NOTHING else is ever sent (no price/variant/title/handle/tag/collection
// fields exist in the mutation input by construction).
//
// SAFE BY DEFAULT: dry-run unless --execute is passed.
// Idempotent: successes checkpoint to tools/moq-cleanup-data/checkpoint-15g5e.json;
// reruns skip completed products; per-product freshness check fails closed.
// Run from the repo root AFTER tools/audit-moq-descriptions.mjs passes:
//   node tools/update-moq-descriptions.mjs            (dry run)
//   node tools/update-moq-descriptions.mjs --execute  (perform updates)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CHECKPOINT_FILE,
  NEW_SENTENCE,
  OLD_SENTENCE,
  ROLLBACK_FILE,
  countOccurrences,
  ensureDataDir,
  getAccessToken,
  replaceSentence,
  shopifyGraphql,
  sleep,
} from "./moq-description-lib.mjs";

const EXECUTE = process.argv.includes("--execute");
const MAX_CONSECUTIVE_FAILURES = 5;

const UPDATE_MUTATION = `mutation MoqDescriptionUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id descriptionHtml }
    userErrors { field message }
  }
}`;

const READ_QUERY = `query MoqDescriptionRead($id: ID!) {
  product(id: $id) { id handle descriptionHtml }
}`;

async function main() {
  ensureDataDir();
  if (!existsSync(ROLLBACK_FILE)) throw new Error(`Rollback artifact missing (${ROLLBACK_FILE}) — run the audit first`);
  const rollback = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  const checkpoint = existsSync(CHECKPOINT_FILE) ? JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8")) : { done: {}, skipped: {} };
  const saveCheckpoint = () => writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 1));

  const accessToken = await getAccessToken();
  const pending = rollback.products.filter((p) => !checkpoint.done[p.id]);
  console.log(`mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"} | candidates: ${rollback.products.length} | already done: ${rollback.products.length - pending.length} | pending: ${pending.length}`);

  let updated = 0;
  let skipped = 0;
  let consecutiveFailures = 0;

  for (const [index, product] of pending.entries()) {
    try {
      const read = await shopifyGraphql(accessToken, READ_QUERY, { id: product.id });
      const current = read.product?.descriptionHtml ?? null;
      if (current == null) {
        checkpoint.skipped[product.id] = { handle: product.handle, reason: "product not found" };
        skipped++;
        saveCheckpoint();
        continue;
      }

      if (countOccurrences(current, OLD_SENTENCE) === 0) {
        // Already clean (idempotent rerun) — count as done only if the new
        // sentence is present; otherwise record for review.
        if (countOccurrences(current, NEW_SENTENCE) > 0) {
          checkpoint.done[product.id] = { handle: product.handle, note: "already updated" };
        } else {
          checkpoint.skipped[product.id] = { handle: product.handle, reason: "sentence absent — content changed externally" };
          skipped++;
        }
        saveCheckpoint();
        continue;
      }

      // Fail closed on drift: only proceed when the audited snapshot still
      // matches, or the drifted content still contains the exact sentence
      // (then the drifted content becomes the rollback original).
      let base = product.descriptionHtml;
      if (current !== product.descriptionHtml) {
        base = current;
        checkpoint.skipped[product.id] = undefined;
        checkpoint.done[product.id] = undefined;
        checkpoint[`drift:${product.id}`] = { handle: product.handle, originalAtUpdate: current };
      }

      const next = replaceSentence(base);
      if (next === base || next.length !== base.length) {
        checkpoint.skipped[product.id] = { handle: product.handle, reason: "unexpected replacement result" };
        skipped++;
        saveCheckpoint();
        continue;
      }

      if (!EXECUTE) {
        updated++;
        if (index < 3) console.log(`[dry] ${product.handle}: "${OLD_SENTENCE}" -> "${NEW_SENTENCE}" (${countOccurrences(base, OLD_SENTENCE)} occurrence)`);
        continue;
      }

      const result = await shopifyGraphql(accessToken, UPDATE_MUTATION, { product: { id: product.id, descriptionHtml: next } });
      const errors = result.productUpdate?.userErrors || [];
      const after = result.productUpdate?.product?.descriptionHtml || "";
      if (errors.length) throw new Error(`userErrors: ${JSON.stringify(errors).slice(0, 300)}`);
      if (countOccurrences(after, OLD_SENTENCE) !== 0 || countOccurrences(after, NEW_SENTENCE) === 0) {
        throw new Error("post-mutation verification failed (old sentence still present or new missing)");
      }

      checkpoint.done[product.id] = { handle: product.handle, updatedAt: new Date().toISOString() };
      updated++;
      consecutiveFailures = 0;
      if (updated % 100 === 0) console.log(`progress: ${updated}/${pending.length} updated`);
      saveCheckpoint();
      await sleep(150);
    } catch (error) {
      consecutiveFailures++;
      checkpoint.skipped[product.id] = { handle: product.handle, reason: String(error.message || error).slice(0, 200) };
      skipped++;
      saveCheckpoint();
      console.error(`FAIL ${product.handle}: ${String(error.message || error).slice(0, 200)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Stopping: ${MAX_CONSECUTIVE_FAILURES} consecutive failures (systemic error). Checkpoint saved — rerun resumes safely.`);
        process.exit(2);
      }
    }
  }

  console.log(`\n${EXECUTE ? "UPDATED" : "WOULD UPDATE"}: ${updated} | skipped: ${skipped} | checkpoint: ${CHECKPOINT_FILE}`);
}

main().catch((error) => {
  console.error("UPDATE ERROR:", error.message || error);
  process.exit(1);
});
