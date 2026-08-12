# 16B Owner Runbook — Navigation Skeleton + Remaining Safety Steps

The app has no write access to menus/pages/theme settings (by design — only
read scopes were approved). Everything below is owner-admin work; each step
is a few minutes. Code-side changes (quick-add CSS fix, read scopes) ship
with the next `shopify app deploy`.

## 0. Deploy + reauthorize (once)
Run `shopify app deploy`. This ships: the quick-add lockout CSS fix and the
new READ-ONLY scopes (read_content, read_online_store_navigation,
read_themes). On next opening of the embedded app, Shopify prompts to
approve the new scopes — accept. No write scopes were added.

## 1. Optional belt-and-braces: disable quick-add globally
Admin -> Online Store -> Customize -> Theme settings -> (Refresh) Product
cards / Quick add -> set to None. The deployed CSS already suppresses
quick-add on configurator-locked pages; this global toggle also removes it
from collection/search cards if you prefer a single behavior everywhere.

## 2. Set the custom domain primary (before launch)
Settings -> Domains: gsopack.com and www.gsopack.com are already attached
with SSL, but the PRIMARY is still 942075-2.myshopify.com. Set
gsopack.com as primary and redirect all traffic to it.

## 3. Create the core pages (Online Store -> Pages -> Add page)
Create these with EXACT handles (Edit website SEO -> URL handle). Keep
each marked "Hidden" until its content is reviewed; publish together with
the menu switch. Skeleton content below is intentionally structural —
final copy is a later pass. Mark placeholders visibly: [DRAFT COPY].

| Title | Handle | Skeleton sections |
|---|---|---|
| How It Works | how-it-works | 1) Pick your bag & options 2) Instant canonical pricing 3) Checkout or request a quote 4) Send artwork (ticket filename) 5) We print (Mimaki CMYK / Roland specialty) 6) QC & ship |
| Artwork Requirements | artwork-requirements | File types (PDF preferred), 300 DPI, bleed, safe area, 90% coverage note, naming: use your GSO ticket in the filename, [DRAFT COPY] |
| Turnaround & Shipping | turnaround-shipping | Standard turnaround, specialty adds, proof approval timing, shipping methods, [DRAFT COPY] |
| Quantity Pricing | quantity-pricing | Ladder explanation (50/100/250/500/1000/2500), volume quotes at 5,000+, specialty upcharges 1X–8X, minimum order 50 units |
| FAQ | faq | MOQ, materials, holographic/white, spot gloss levels, reorders, custom shapes, [DRAFT COPY] |
| Request a Quote | request-a-quote | Intro + what to include (product, qty, finish, deadline, artwork state) + contact form block (see §6) |
| About GSO | about-gso | Who we are, in-house Mimaki/Roland production, [DRAFT COPY] |
| Specialty Printing | specialty-printing | See §5 structure |

## 4. Build the launch menus (Online Store -> Navigation)
MAIN MENU (replace current items):
- Shop
  - Stock Bags -> /collections/stock-bags-1  (rename collection to
    handle "stock-bags" later in 16C; keep link in sync)
  - Specialty Printing -> /pages/specialty-printing
- Resources
  - How It Works -> /pages/how-it-works
  - Artwork Requirements -> /pages/artwork-requirements
  - Turnaround & Shipping -> /pages/turnaround-shipping
  - Quantity Pricing -> /pages/quantity-pricing
  - FAQ -> /pages/faq
  - Request a Quote -> /pages/request-a-quote
- About
  - About GSO -> /pages/about-gso
  - Contact -> /pages/contact

FOOTER MENU: Contact, Request a Quote, Shipping Policy, Refund Policy,
Privacy Policy, Terms of Service.

Do NOT add Jars / Stickers / DTP / Boxes to any menu until those families
are rebuilt (their products are drafted/hidden on purpose).

## 5. Specialty Printing page structure
Intro: raised UV specialty printing on stock bags, in-house.
Sections (each: 1 image + 2 sentences + CTA):
- Spot Gloss (1X) -> CTA "Shop Stock Bags" -> /collections/stock-bags-1
- Raised Gloss / High Raised (2X–5X) -> same CTA
- Ultra/Extreme Raised (6X–8X) -> same CTA
- Holographic -> same CTA (holo bags include required white)
- White Ink -> same CTA
- Custom Shapes & Deep Build (9X+) -> CTA "Request a Quote" ->
  /pages/request-a-quote
No standalone purchasable specialty products — every CTA lands in the
existing Stock Bag configurator journey or the quote page.

## 6. Quote entry point (16B = shell only)
Audit result: the ERP quote system (app.quotes) is admin-only; there is NO
safe public/app-proxy quote intake today, and none was built (per the
decision to avoid a disconnected form database). For 16B put Shopify's
native contact form block on /pages/request-a-quote (submissions arrive by
store email) with fields requested in the intro text. RECOMMENDED LATER
MICRO-PHASE (16C/16G window): a token-less app-proxy intake
(/apps/wholesale-lite/quote-request) that creates a DRAFT ERP quote +
notifies — reusing the existing quote model, no second system.

## 7. Homepage section order (Online Store -> Customize, Home template)
Target order (remove the "GET THE BAG" button wall and the miron-jars
promotion — those jar products are now drafted, so their links would 404):
1. Hero: value proposition ("Custom stock bags, printed in-house, from 50
   units") + CTA Shop Stock Bags
2. Featured collection: Stock Bags
3. Specialty capability strip -> /pages/specialty-printing
4. How it works (3–4 steps) -> /pages/how-it-works
5. Trust/turnaround blurb
6. Quote CTA -> /pages/request-a-quote
7. Footer (menu from §4)

## 8. Legacy page classification (from the 16A inventory; NO deletions yet)
- KEEP: contact, stock-bags (funnel — trim its weight in 16D),
  gso-packaging (About source material -> fold into about-gso),
  artwork-approval-form (production flow uses it).
- KEEP FOR REVIEW (services GSO still sells — consolidate in 16C/16D):
  design-services, basic/standard/premium/pro/elite-design (+ the older
  basic-design-form / standard-design-package duplicates — merge to ONE
  design-services page).
- REBUILD LATER (family roadmap; hide from nav until their phases):
  dtp, 4x5-dtp, 4x7-dtp, 2x6-dtp, 2x7-dtp (DTP family), custom-labels,
  4x5-label, 14x18-label, pop-top-label, jar-label, certified-label,
  stickers (stickers/labels family).
- HIDE: custom-shapes, urus-die, octane-die (+ other die pages) until the
  custom-shape offering is productized (Deep Build quote path covers it
  meanwhile).
Remaining pages from the 40 not listed here: classify on sight with the
same rules (design/DTP/label/die pattern).

## 9. After completing §3–§7, tell Claude to run the 16B navigation
verification (link resolution + no-404 sweep + purchase-path smoke).
