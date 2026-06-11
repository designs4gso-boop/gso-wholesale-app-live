// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

function attr(line, key) {
  if (key === "_gso_configurator") return line.attribute?.value || "";
  if (key === "ERP Price Each") return line.erpPriceEach?.value || "";
  if (key === "ERP Matched Tier") return line.erpMatchedTier?.value || "";
  return "";
}

function money(value) {
  const clean = String(value || "").replace(/[^0-9.]/g, "");
  const number = Number(clean);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(2);
}

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = [];

  for (const line of input.cart.lines || []) {
    const isGsoConfigured = attr(line, "_gso_configurator") === "true";
    const priceEach = money(attr(line, "ERP Price Each"));

    if (!isGsoConfigured || !priceEach) continue;

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: priceEach,
            },
          },
        },
      },
    });
  }

  return operations.length ? { operations } : NO_CHANGES;
}
