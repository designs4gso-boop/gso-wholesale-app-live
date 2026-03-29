import { json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { validateCart } from "../lib/wholesale.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return json({ ok: false, errors: ["App not installed."] }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return json({ ok: false, errors: ["Invalid request body."] }, { status: 400 });
  }

  const result = await validateCart(session.shop, {
    customerTags: body.customerTags || [],
    subtotal: Number(body.subtotal || 0),
    cartQuantity: Number(body.cartQuantity || 0),
    lines: Array.isArray(body.lines) ? body.lines : [],
  });

  return json(result);
}
