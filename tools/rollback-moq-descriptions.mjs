// Phase 15G.5E — rollback: restore the ORIGINAL descriptionHtml saved by the
// pre-write audit for every product the updater touched (or all candidates
// with --all). Dry-run unless --execute.
//   node tools/rollback-moq-descriptions.mjs            (dry run, touched only)
//   node tools/rollback-moq-descriptions.mjs --execute  (restore touched)
//   node tools/rollback-moq-descriptions.mjs --execute --all (restore every candidate)
import { existsSync, readFileSync } from "node:fs";
import {
  CHECKPOINT_FILE,
  ROLLBACK_FILE,
  getAccessToken,
  shopifyGraphql,
  sleep,
} from "./moq-description-lib.mjs";

const EXECUTE = process.argv.includes("--execute");
const ALL = process.argv.includes("--all");

const UPDATE_MUTATION = `mutation MoqDescriptionRollback($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id descriptionHtml }
    userErrors { field message }
  }
}`;

async function main() {
  if (!existsSync(ROLLBACK_FILE)) throw new Error(`Rollback artifact missing (${ROLLBACK_FILE})`);
  const accessToken = await getAccessToken();
  const rollback = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  const checkpoint = existsSync(CHECKPOINT_FILE) ? JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8")) : { done: {} };
  const targets = rollback.products.filter((p) => ALL || checkpoint.done?.[p.id]);
  console.log(`mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"} | restoring ${targets.length} of ${rollback.products.length} saved originals`);

  let restored = 0;
  for (const product of targets) {
    // Drifted content captured at update time wins as the true original.
    const original = checkpoint[`drift:${product.id}`]?.originalAtUpdate ?? product.descriptionHtml;
    if (!EXECUTE) { restored++; continue; }
    const result = await shopifyGraphql(accessToken, UPDATE_MUTATION, { product: { id: product.id, descriptionHtml: original } });
    const errors = result.productUpdate?.userErrors || [];
    if (errors.length) {
      console.error(`FAIL ${product.handle}: ${JSON.stringify(errors).slice(0, 200)}`);
      continue;
    }
    restored++;
    if (restored % 100 === 0) console.log(`progress: ${restored}/${targets.length}`);
    await sleep(150);
  }
  console.log(`${EXECUTE ? "RESTORED" : "WOULD RESTORE"}: ${restored}`);
}

main().catch((error) => {
  console.error("ROLLBACK ERROR:", error.message || error);
  process.exit(1);
});
