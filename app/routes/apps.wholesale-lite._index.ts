import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createWholesaleApplication, getWholesaleConfig } from "../lib/wholesale.server";

async function tagsAdd(admin: any, id: string, tags: string[]) {
  const res = await admin.graphql(
    `#graphql
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { variables: { id, tags } },
  );
  const payload = await res.json();
  const errs = payload?.data?.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join(", "));
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return data({ ok: false, message: "App not installed." }, { status: 400 });
  }

  const body = await request.formData();
  const email = String(body.get("email") || "").trim();
  if (!email) return data({ ok: false, message: "Email is required." }, { status: 400 });

  const companyName = String(body.get("company_name") || "").trim() || null;
  const phone = String(body.get("phone") || "").trim() || null;
  const taxId = String(body.get("tax_id") || "").trim() || null;
  const resaleNumber = String(body.get("resale_number") || "").trim() || null;
  const notes = String(body.get("notes") || "").trim() || null;
  const firstName = String(body.get("first_name") || "").trim() || null;
  const lastName = String(body.get("last_name") || "").trim() || null;

  const settings = await getWholesaleConfig(session.shop);

  const searchRes = await admin.graphql(
    `#graphql
    query($query: String!) {
      customers(first: 1, query: $query) {
        nodes { id email }
      }
    }`,
    { variables: { query: `email:${email}` } },
  );
  const searchData = await searchRes.json();
  let customerId = searchData?.data?.customers?.nodes?.[0]?.id || null;

  if (!customerId) {
    const createRes = await admin.graphql(
      `#graphql
      mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            email,
            firstName,
            lastName,
            phone,
            tags: [settings.pendingTag],
          },
        },
      },
    );
    const createData = await createRes.json();
    const errs = createData?.data?.customerCreate?.userErrors || [];
    if (errs.length) {
      return data({ ok: false, message: errs.map((e: any) => e.message).join(", ") }, { status: 400 });
    }
    customerId = createData?.data?.customerCreate?.customer?.id;
  } else {
    await tagsAdd(admin, customerId, [settings.pendingTag]);
  }

  await createWholesaleApplication(session.shop, {
    customerId,
    email,
    companyName: companyName || undefined,
    phone: phone || undefined,
    taxId: taxId || undefined,
    resaleNumber: resaleNumber || undefined,
    notes: notes || undefined,
  });

  return data({ ok: true, message: "Application submitted." });
}