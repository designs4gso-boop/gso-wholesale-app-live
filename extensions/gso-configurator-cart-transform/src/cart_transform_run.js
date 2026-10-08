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

// 2026-10-07: the live theme writes `_GSO Price Each` / `_GSO Matched Tier`
// (see extensions/wholesale-theme/assets/gso-product-configurator.js); the
// `_GSO ERP ...` spelling is kept for compatibility. Either key is honoured.
function attr(line, key) {
  if (key === "_gso_configurator") return line.gsoConfigurator?.value || "";
  if (key === "_GSO ERP Price Each") return line.gsoErpPriceEach?.value || line.gsoPriceEach?.value || "";
  if (key === "_GSO ERP Matched Tier") return line.gsoErpMatchedTier?.value || line.gsoMatchedTier?.value || "";
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
    const priceEach = money(attr(line, "_GSO ERP Price Each"));

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
