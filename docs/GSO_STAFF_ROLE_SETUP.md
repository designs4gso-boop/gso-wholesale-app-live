# Staff Roles — What Must Be Set, and How to Check It

Written 2026-11-20. Roles are set on Render (the hosting service), not in the ERP. Nobody but the
owner can see those settings, so this page says exactly what "safe" looks like and where to look.
No secret values are written here.

## The fastest check — inside the ERP (1 minute)

Open **Admin → Staff Access & Readiness** (owner only).

| What the page shows | Meaning |
|---|---|
| **Owner enforcement — green**, "N owner Shopify staff ID(s) configured; enforcement is on" | SAFE |
| **Owner enforcement — red**, "temporary_all_staff — EVERY Shopify staff login is treated as owner" | **UNSAFE.** Every employee has owner access. Fix today (below). |
| **Owner enforcement — red**, "No owner IDs configured" | Nobody is the owner; owner pages are closed to everyone. Fix (below). |
| The **role list** shows each employee's staff ID with a role | Check it against the table below. |
| You cannot open this page at all | You are not set as an owner. Fix (below). |

## Where to change it

Render dashboard → service **gso-wholesale-app-live** → **Environment**. Saving restarts the app
(about two minutes).

## What each setting must be

| Setting | SAFE | UNSAFE | Today |
|---|---|---|---|
| `GSO_OWNER_ENFORCEMENT` | Not present, or `enforced` | `temporary_all_staff` | **UNKNOWN** — cannot be seen from the code. Check it. |
| `GSO_OWNER_SHOPIFY_USER_IDS` | The Shopify staff IDs of the owners (James, Raquel), comma separated | Empty, or an ID that is not an owner | **UNKNOWN** |
| `GSO_STAFF_ROLES` | One `id:role` per employee, comma separated | Missing people (they get no access); a seller with no role (cannot open Quotes) | **UNKNOWN** |
| `GSO_MANAGER_AUTHORIZED_USER_IDS` | Only managers who may see costs and margins. Empty is fine. | A manager who should not see money | **UNKNOWN** |

Roles you can assign in `GSO_STAFF_ROLES`: `manager`, `sales`, `print_operator`, `bagger`.

## Who needs what

| Person | Needs | Gets |
|---|---|---|
| James (owner, runs production) | Listed in `GSO_OWNER_SHOPIFY_USER_IDS` | Everything, including all production screens |
| Raquel (owner / admin) | Listed in `GSO_OWNER_SHOPIFY_USER_IDS` | Everything: admin, release, customers, plus production support |
| Production lead | `id:print_operator` | Board, New Job, job pages, Incoming Print Files, printer choice, reprints, QC, shipment / pickup. No quotes, customers, release, costs or settings. |
| Finisher / bagger | `id:bagger` | Board, job pages, QC, ready / shipment / pickup. Cannot create jobs, assign files or start reprints. |
| Anyone who sells | `id:sales` (or `id:manager`) | Quotes, Leads, Customers, Reorder. No production screens. |
| Manager | `id:manager` | Sales + production + release + approvals. Costs only if also listed as an authorized manager. |
| Not listed | — | Home only. A page tells them their own staff ID to give to the owner. |

Example shape (made-up numbers): `GSO_STAFF_ROLES` = `1111111111:print_operator,2222222222:sales,3333333333:bagger`

## How to find someone's Shopify staff ID

Have them open the ERP. With no role, Home shows "Your Shopify staff user ID is …". They give you
that number. (Owners see theirs on any owner-only page.)

## After changing anything

1. Wait for the restart, then open **Admin → Staff Access & Readiness** again: enforcement green,
   every person on the list with the right role.
2. Ask the production lead to open the Production Board, and a seller to open Quotes.
