import { allAgentQuotePrepDraftShape } from "../lib/agent-quote-prep-draft";
import { authenticate } from "../shopify.server";

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shape = allAgentQuotePrepDraftShape();
  const url = new URL(request.url);
  const pretty = url.searchParams.get("pretty") === "1";

  const payload = {
    ok: true,
    version: shape.version,
    mode: shape.mode,
    shop: session.shop,
    purpose:
      "Official GSO internal agent quote-prep draft packet shape for staff-reviewed handoff workflows.",
    ...shape,
  };

  if (pretty) {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
