# GSO Market Pricing Master — October 2026 (status page)

Classification: **MARKET RESEARCH** index. This page records what market evidence the repository actually holds as of 2026-10-06 so that no pricing decision cites research that is not here.

## Present in the repository

| Item | File | Scope | Date | Class |
|---|---|---|---|---|
| Competitor + margin study (bags / labels) | `docs/GSO_ERP_COMPETITOR_MARGIN_STUDY.md` | sticker bags (Sticker Farmer "from $115", Mylar Legends quote-based), spot-gloss label vendors (configurator-gated), interim 3x3 / banner anchors | 2026-07-25 | MARKET RESEARCH (incomplete; manual quote capture never performed) |
| 4x5 bag market targets (low / median / high / negotiation floor) | `commercial-pricing-policy.server.ts` `BAGS_4X5_FRONT_LADDER`, Pricing Settings section F | 4x5 sticker bags | 2026-07-26 | MARKET RESEARCH ratified by owner |
| 4x5 calibration matrix | `docs/GSO_ERP_4X5_CALIBRATION_MATRIX.md` | owner-implied margins on bags | 2026-07 | OWNER DATA |
| Jar launch ladder | `app/lib/canonical-jar-pricing.ts` | Miron / standard jars | 2026-08-12 | OWNER-APPROVED (market-driven by owner decision; no competitor data in repo) |
| DTP owner sell ladders + floors | `app/lib/dtp-owner-pricing.server.ts` | 4x5x2 OWNER-APPROVED 2026-10-06 ($1.30 / $0.71 / $0.46 / $0.37); 5x4x2 / 6x5x2 / 8x5x2 2026-07-24 ladders (OWNER PRICING REVIEW REQUIRED) | 2026-10-06 / 2026-07-24 | OWNER-APPROVED |
| **Design & Customize 4x5 published pricing** | `app/lib/dtp-market-benchmark.ts`, `docs/GSO_DTP_4X5_OWNER_PRICING_2026-10-06.md` | DTP 4x5: base $1.00 / $0.80 / $0.60 / $0.40 / $0.30 at 1,000 / 1,500 / 2,500 / 5,000 / 10,000; CR +5%, spot +5%, holo +5%, shape +10%, inside print +15%, rush +20% | 2026-10-06 (owner-supplied) | MARKET RESEARCH — **PRIMARY / CONTROLLING DTP COMPETITOR** (benchmark of record until more true 1:1 premium domestic competitors are verified) |

## Present since 2026-10-06 (vendor research, not market research)

- Spektra / Flex Packaging live price matrix (1,084 rows), pricing rules and old-vs-current notes (`docs/vendor-research/*`) — VENDOR OBSERVED DATA. These are vendor COSTS; they do not establish a customer market price.

## NOT present in the repository (named by the owner, not found)

- A "master market-pricing research" document for DTP pouches or jars.
- Beastcoast jar research; any competitor jar price; the 100ml Wide target schedule; the $620.80 historical order record.

## Consequence for DTP commercial position

Design & Customize is the DTP benchmark of record. GSO 4x5x2 is intentionally modestly premium to its comparable CR reference (+23.8% / +12.7% / +9.5% / +17.5% at 1,000 / 2,500 / 5,000 / 10,000) under the PREMIUM DOMESTIC DTP position ("premium / heavy-duty pouch positioning"; no thickness claim until documented). Competitor prices are evidence only and never change GSO prices automatically; the other DTP sizes have no published competitor price on file and remain OWNER PRICING REVIEW REQUIRED.
