const EMPTY_CART_DISCOUNT = {
  discountApplicationStrategy: "ALL",
  discounts: [],
};

export function cartLinesDiscountsGenerateRun(input) {
  const tagResults =
   input.cart?.buyerIdentity?.customer?.hasTags || [];

  const isWholesale =
   tagResults.some((item) => item.hasTag);

  if (!isWholesale) return EMPTY_CART_DISCOUNT;

  const discounts = [];

  for (const line of input.cart.lines || []) {
    const qty = Number(line.quantity || 0);
    if (qty < 64) continue;

    const currentPrice = Number(line.cost?.amountPerQuantity?.amount || 0);
    const targetPrice = 0.65;
    const amountOff = currentPrice - targetPrice;

    if (amountOff <= 0) continue;

    discounts.push({
      targets: [
        {
          cartLine: {
            id: line.id,
          },
        },
      ],
      value: {
        fixedAmount: {
          amount: amountOff.toFixed(2),
          appliesToEachItem: true,
        },
      },
      message: "GSO wholesale pricing",
    });
  }

  return {
    discountApplicationStrategy: "ALL",
    discounts,
  };
}

export function cartDeliveryOptionsDiscountsGenerateRun() {
  return {
    discounts: [],
  };
}