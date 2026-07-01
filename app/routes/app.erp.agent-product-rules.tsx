import { allProductFamilySalesRules } from "../lib/product-family-sales-rules";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  return Response.json({
    ok: true,
    version: "2026-07-01-phase-4b",
    mode: "read_only",
    shop: session.shop,
    purpose: "Official GSO product family MOQ and sales-rule guidance for staff-approved agent workflows.",
    guardrails: {
      canCreateShopifyProducts: false,
      canEditPricing: false,
      canActivateProducts: false,
      canCreateDraftOrders: false,
      canSendCustomerMessages: false,
      canCreateProductionJobs: false,
      canApproveQuotes: false,
      canRunMarketingCampaigns: false,
    },
    blockedData: [
      "costs",
      "margins",
      "vendor costs",
      "customer records",
      "quotes",
      "orders",
      "Shopify tokens",
      "production jobs",
      "draft order creation",
      "price editing",
      "product activation",
    ],
    families: allProductFamilySalesRules(),
  });
}
