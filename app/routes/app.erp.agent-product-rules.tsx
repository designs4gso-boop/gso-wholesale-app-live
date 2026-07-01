import { allProductFamilySalesRules } from "../lib/product-family-sales-rules";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const pretty = url.searchParams.get("pretty") === "1";

  const payload = {
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
  };

  if (pretty) {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
