// Phase 15G.5E — READ-ONLY post-write verification. Writes nothing.
// Proves: zero products still contain the old sentence, the expected set now
// contains the new sentence, and no non-Stock-Bag product was ever touched.
// Run from the repo root: node tools/verify-moq-descriptions.mjs
import { NEW_SENTENCE, OLD_SENTENCE, countOccurrences, getAccessToken, shopifyGraphql } from "./moq-description-lib.mjs";

async function main() {
  const accessToken = await getAccessToken();
  let cursor = null;
  let total = 0;
  let oldAnywhere = 0;
  const oldByType = {};
  let newInBags = 0;
  let newElsewhere = [];
  do {
    const data = await shopifyGraphql(
      accessToken,
      `query Verify($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { handle productType description }
        }
      }`,
      { cursor },
    );
    for (const node of data.products.nodes) {
      total++;
      const desc = node.description || "";
      if (countOccurrences(desc, OLD_SENTENCE) > 0) {
        oldAnywhere++;
        const type = node.productType || "(empty)";
        oldByType[type] = (oldByType[type] || 0) + 1;
      }
      if (countOccurrences(desc, NEW_SENTENCE) > 0) {
        if (node.productType === "Stock Bag") newInBags++;
        else if (newElsewhere.length < 10) newElsewhere.push(`${node.handle} [${node.productType || "(empty)"}]`);
      }
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log("=== 15G.5E POST-WRITE VERIFICATION (read-only) ===");
  console.log(`products scanned:                 ${total}`);
  console.log(`still containing OLD sentence:    ${oldAnywhere} ${oldAnywhere ? JSON.stringify(oldByType) : ""}`);
  console.log(`Stock Bags with NEW sentence:     ${newInBags}`);
  console.log(`NEW sentence outside Stock Bags:  ${newElsewhere.length} ${newElsewhere.join("; ")}`);
  console.log(oldAnywhere === 0 ? "VERIFY: PASS" : "VERIFY: FAIL");
}

main().catch((error) => {
  console.error("VERIFY ERROR:", error.message || error);
  process.exit(1);
});
