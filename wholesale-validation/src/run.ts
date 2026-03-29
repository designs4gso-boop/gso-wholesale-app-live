export function run(input: any) {
  const raw = input?.validation?.metafield?.value;
  if (!raw) return { operations: [] };

  const config = JSON.parse(raw);
  const customerTags: string[] = input?.cart?.buyerIdentity?.customer?.tags || [];
  if (!customerTags.includes(config.wholesaleTag)) return { operations: [] };

  const subtotal = Number(input?.cart?.cost?.subtotalAmount?.amount || 0);
  if (subtotal >= Number(config.minimumSubtotal || 0)) return { operations: [] };

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message: `Wholesale minimum order is $${Number(config.minimumSubtotal || 0).toFixed(2)}.`,
              target: "$",
            },
          ],
        },
      },
    ],
  };
}
