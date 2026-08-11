// Phase 15G.5E — READ-ONLY pre-write audit for the Stock Bag MOQ description
// cleanup. Writes NO Shopify data. Produces the rollback artifact
// (tools/moq-cleanup-data/rollback-15g5e.json — git-ignored) plus an audit
// summary. Run from the repo root: node tools/audit-moq-descriptions.mjs
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  NEW_SENTENCE,
  OLD_SENTENCE,
  ROLLBACK_FILE,
  countOccurrences,
  ensureDataDir,
  getAccessToken,
  shopifyGraphql,
} from "./moq-description-lib.mjs";

const LOOSE = /minimum\s+order\s+64\s+units/i;

async function main() {
  ensureDataDir();
  // NEVER silently overwrite an existing rollback artifact — after the update
  // has run, re-auditing would capture the ALREADY-UPDATED descriptions and
  // destroy the only copy of the originals. Post-write checks belong to
  // tools/verify-moq-descriptions.mjs.
  if (existsSync(ROLLBACK_FILE) && !process.argv.includes("--refresh-rollback")) {
    throw new Error(`${ROLLBACK_FILE} already exists. Use verify-moq-descriptions.mjs for post-write checks, or pass --refresh-rollback to intentionally rebuild the artifact.`);
  }
  const accessToken = await getAccessToken();

  const nodes = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(
      accessToken,
      `query Audit($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title status productType tags descriptionHtml seo { title description } }
        }
      }`,
      { cursor },
    );
    nodes.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  const candidates = [];
  const looseOnly = [];
  const nonBagWithSentence = [];
  const multiOccurrence = [];
  const preExisting50 = [];
  const seoManual = [];
  const statusCounts = {};

  for (const node of nodes) {
    const desc = node.descriptionHtml || "";
    const exact = countOccurrences(desc, OLD_SENTENCE);
    const isBag = node.productType === "Stock Bag";
    if (countOccurrences(desc, NEW_SENTENCE) > 0) preExisting50.push(node.handle);
    if (exact > 0 && !isBag) nonBagWithSentence.push(`${node.handle} [${node.productType || "(empty)"}]`);
    if (exact === 0 && LOOSE.test(desc)) looseOnly.push(`${node.handle} [${node.productType || "(empty)"}]`);
    if (isBag && exact > 0) {
      statusCounts[node.status] = (statusCounts[node.status] || 0) + 1;
      if (exact > 1) multiOccurrence.push(`${node.handle} x${exact}`);
      const seoDesc = node.seo?.description || "";
      if (seoDesc.trim()) seoManual.push(`${node.handle}: ${seoDesc.slice(0, 90)}`);
      candidates.push({ id: node.id, handle: node.handle, title: node.title, status: node.status, descriptionHtml: desc });
    }
  }

  // Replacement-safety proof: same length (64 -> 50), occurrence counts flip
  // exactly, and split/join cannot alter any byte outside the exact sentence.
  let unsafe = 0;
  for (const c of candidates) {
    const next = c.descriptionHtml.split(OLD_SENTENCE).join(NEW_SENTENCE);
    const before = countOccurrences(c.descriptionHtml, OLD_SENTENCE);
    if (
      next.length !== c.descriptionHtml.length ||
      countOccurrences(next, OLD_SENTENCE) !== 0 ||
      countOccurrences(next, NEW_SENTENCE) !== before + countOccurrences(c.descriptionHtml, NEW_SENTENCE)
    ) {
      unsafe++;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    totalProducts: nodes.length,
    candidateCount: candidates.length,
    excludedCount: nodes.length - candidates.length,
    statusCounts,
    nonBagWithSentence,
    looseOnlyMatches: looseOnly,
    multiOccurrence,
    preExisting50Count: preExisting50.length,
    seoManualDescriptions: seoManual,
    replacementUnsafeCount: unsafe,
  };

  writeFileSync(ROLLBACK_FILE, JSON.stringify({ shop: "942075-2.myshopify.com", oldSentence: OLD_SENTENCE, newSentence: NEW_SENTENCE, savedAt: summary.generatedAt, products: candidates }, null, 1));
  writeFileSync(path.join(DATA_DIR, "audit-summary-15g5e.json"), JSON.stringify(summary, null, 1));

  console.log("=== 15G.5E PRE-WRITE AUDIT (read-only) ===");
  console.log(`products scanned:        ${summary.totalProducts}`);
  console.log(`candidates (Stock Bag + exact sentence): ${summary.candidateCount}`);
  console.log(`excluded:                ${summary.excludedCount}`);
  console.log(`by status:               ${JSON.stringify(statusCounts)}`);
  console.log(`non-Stock-Bag with sentence: ${nonBagWithSentence.length} ${nonBagWithSentence.slice(0, 5).join("; ")}`);
  console.log(`loose-but-not-exact matches: ${looseOnly.length} ${looseOnly.slice(0, 5).join("; ")}`);
  console.log(`multi-occurrence candidates: ${multiOccurrence.length} ${multiOccurrence.slice(0, 5).join("; ")}`);
  console.log(`pre-existing "${NEW_SENTENCE}": ${preExisting50.length}`);
  console.log(`manually-saved SEO descriptions on candidates: ${seoManual.length}`);
  console.log(`replacement-unsafe candidates: ${unsafe}`);
  console.log(`rollback artifact: ${ROLLBACK_FILE}`);
  const pass = nonBagWithSentence.length === 0 && unsafe === 0;
  console.log(pass ? "AUDIT: PASS" : "AUDIT: FAIL — do not proceed");
}

main().catch((error) => {
  console.error("AUDIT ERROR:", error.message || error);
  process.exit(1);
});
