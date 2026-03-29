# Wholesale Lite for Shopify

Custom Shopify app that replaces paid wholesale apps (Wholesale Gorilla, etc.) on Shopify Basic.

## Features

- **Wholesale application form** on storefront via theme app block
- **Approve / reject applicants** in the embedded admin UI
- **Tag-based segmentation**: `wholesale_approved` and `wholesale_pending`
- **Tiered wholesale pricing** via Shopify Discount Function:
  - Storewide fallback (e.g. 20% off everything)
  - Collection-level rules
  - Product-level rules
  - Variant-level overrides
- **Minimum order subtotal** enforcement via Cart Validation Function
- **Storefront pricing display**: "Save up to X% off" + retail vs wholesale price table on product pages, visible before login

## Rule precedence

1. **Variant override** (priority 10) — most specific, always wins
2. **Product rule** (priority 20) — matches by product GID
3. **Collection rule** (priority 30) — matches if product is in the collection. If multiple collection rules match, highest discount wins.
4. **Storewide fallback** — the % set in Core Settings

## Local development

### Prerequisites

- Node.js 18+
- Shopify CLI: `npm install -g @shopify/cli`
- A Shopify Partner account and a development store
- An app created in the Dev Dashboard

### Steps

```bash
cd wholesale-lite-mvp
npm install
cp .env.example .env
# Fill in SHOPIFY_API_KEY and SHOPIFY_API_SECRET from your Dev Dashboard

npx prisma migrate dev --name init
shopify app dev
```

The CLI starts the app server, creates a tunnel, and opens the embedded admin. It auto-fills `SHOPIFY_APP_URL`.

## Deploy

```bash
shopify app deploy
```

Deploy your web app to your host first, then run `shopify app deploy` to push Shopify app configuration and extensions (discount function, validation function, theme blocks). After both are live, open the embedded admin and click **Save settings & sync functions** to create or update the discount and validation owners in your store.

## Setup after deploy

1. Open the embedded admin → **Wholesale Lite**
2. Set core settings: wholesale tag, storewide %, minimum subtotal
3. Click **Save settings & sync functions**
4. Optionally add pricing rules for specific collections, products, or variants
5. Add theme blocks (see below)
6. Create a page at `/pages/wholesale-application` for the registration form

## Theme customization

Go to **Online Store → Customize** in your Shopify admin.

### Product pages — Wholesale Pricing block

1. Navigate to a product page template
2. Click **Add block** → look under **Apps** → **Wholesale pricing**
3. Configure heading, guest message, and apply URL
4. Shows "Save up to X% off", entry pricing, and quantity tier tables to guests before login

### Wholesale application page

1. Create a page in Shopify admin: Content → Pages → `/pages/wholesale-application`
2. In the theme customizer, navigate to that page and add the **Wholesale registration** block (under Apps)
3. Visitors submit applications that appear in your admin for review

## Where to edit things

| What | Where |
|------|-------|
| Core settings (tag, %, min subtotal) | Admin → Wholesale Lite → Settings |
| Pricing rules | Admin → Wholesale Lite → Pricing rules |
| Approve / reject applicants | Admin → Wholesale Lite → Settings → Pending section |
| Theme blocks | Online Store → Customize → Add block (under Apps) |
| Database schema | `prisma/schema.prisma` |
| Discount logic | `extensions/wholesale-discount/src/run.ts` |
| Validation logic | `extensions/wholesale-validation/src/run.ts` |
| Storefront pricing API | `app/routes/apps.wholesale-lite.pricing.ts` |

## How tags work

**When a visitor submits the application form:**
1. App creates or finds the customer in Shopify
2. Adds the `wholesale_pending` tag
3. Saves a database record with status `pending`

**When you approve in admin:**
1. Adds `wholesale_approved` tag
2. Removes `wholesale_pending` tag
3. Updates database status to `approved`

**When you reject in admin:**
1. Removes `wholesale_pending` tag
2. Updates database status to `rejected`

The discount function only activates for customers tagged `wholesale_approved`.
The validation function only enforces minimum subtotal for `wholesale_approved`.

## How collection rules work (technical note)

Shopify Function input queries are **static** — you cannot dynamically pass collection IDs at runtime. To solve this, the app pre-computes a `productToCollections` map when you save settings or rules. It queries Shopify for all products in each collection that has a rule, then bakes that mapping into the discount function's config JSON.

**Tradeoff**: if you add a product to a collection after the last sync, it won't get the collection discount until you re-save settings. This is intentional to avoid webhook-based sync complexity on Shopify Basic.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_API_KEY` | Yes | From Dev Dashboard |
| `SHOPIFY_API_SECRET` | Yes | From Dev Dashboard |
| `SHOPIFY_APP_URL` | Auto | Set by `shopify app dev` |
| `SCOPES` | Yes | See `.env.example` |
| `DATABASE_URL` | Yes | `file:dev.sqlite` locally, `postgres://...` in production |

## Notes

- Quantity tiers are configured as separate rules using the same scope with different **Minimum quantity** values.
- Tier matching is per cart line. Example: if a variant has rules at 12+ and 48+, the 48+ tier applies only when that line quantity is 48 or more.
- Collection rules are snapshotted into the function config each time you sync settings or rules. If you add products to a collection later, click **Save settings & sync functions** again so the collection map refreshes.
