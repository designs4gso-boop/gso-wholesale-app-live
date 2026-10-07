# GSO Market Pricing Master — October 2026 (status page)

Classification: **MARKET RESEARCH** index. This page records what market evidence the repository actually holds as of 2026-10-06 so that no pricing decision cites research that is not here.

## Present in the repository

| Item | File | Scope | Date | Class |
|---|---|---|---|---|
| Competitor + margin study (bags / labels) | `docs/GSO_ERP_COMPETITOR_MARGIN_STUDY.md` | sticker bags (Sticker Farmer "from $115", Mylar Legends quote-based), spot-gloss label vendors (configurator-gated), interim 3x3 / banner anchors | 2026-07-25 | MARKET RESEARCH (incomplete; manual quote capture never performed) |
| 4x5 bag market targets (low / median / high / negotiation floor) | `commercial-pricing-policy.server.ts` `BAGS_4X5_FRONT_LADDER`, Pricing Settings section F | 4x5 sticker bags | 2026-07-26 | MARKET RESEARCH ratified by owner |
| 4x5 calibration matrix | `docs/GSO_ERP_4X5_CALIBRATION_MATRIX.md` | owner-implied margins on bags | 2026-07 | OWNER DATA |
| Jar launch ladder | `app/lib/canonical-jar-pricing.ts` | Miron / standard jars | 2026-08-12 | OWNER-APPROVED (market-driven by owner decision; no competitor data in repo) |
| DTP owner sell ladders + floors | `app/lib/dtp-owner-pricing.server.ts` | 4 legacy DTP sizes | 2026-07-24 | OWNER-APPROVED (study not in repo) |

## NOT present in the repository (named by the owner, not found)

- Spektra / Flex Packaging live price matrix, pricing rules and old-vs-current notes dated 2026-10-06 (`docs/vendor-research/*`).
- A "master market-pricing research" document for DTP pouches or jars.
- Beastcoast jar research; any competitor jar price; the 100ml Wide target schedule; the $620.80 historical order record.

## Consequence for DTP commercial position

With no public DTP market reference and no observed current vendor cost loaded, the DTP position (competitive lower-middle / middle target, "MARKET BELOW CURRENT VENDOR ECONOMICS" flags) cannot be computed. Pricing Intelligence states this on screen instead of guessing. Once the research files are committed, fill the table in `GSO_PRICING_AUTHORITY_MATRIX.md` and record the owner's decision per size and tier.
