# GSO ERP — Employee Filename Compatibility (15F.0J, 2026-07-25)

Employees keep their habits; the parser adapts. Sample corpus available in
this session: the owner example ("Flame Society_rainbow cherry slushie_
matte_150 ML_Roland.pdf"), routed-archive conventions from configs, and the
token families the routing code already anticipates. A fuller corpus pull
(_routed-archive listing) is a data task the NAS-connected machine can run
read-only (dir > csv) — listed as collection step 1 in the calibration plan.

## Token reliability (observed/expected)
RELIABLE when present: explicit printer words (Roland/Mimaki), finish words
(matte, holo/holographic, gloss, spot gloss, emboss, white), size tokens
(4x5, 150 ML, 3.5g), customer + product/strain names (position 1-2, space/
underscore separated). UNRELIABLE: bare NX counts ("3x" can be strain/size
multiplier), capitalization (must be case-insensitive), delimiter choice
(space vs _ vs -; treat all as one), Windows copy suffixes (" - Copy",
" (2)", "Copy 2"), edit words (final, revised, new, fix, v2) — all must
normalize OFF before identity matching but be RECORDED as revision hints.
Unicode/emoji: sanitize for routed copies; originals untouched. RIP name
truncation: keep routed names <=120 chars (RasterLink) — long employee
names never propagate (system name replaces them).

## Hazard rules (never loose substrings)
- Printer: word-boundary only (existing hasRolandFilenameTag pattern; add
  the mirror MIMAKI token).
- Mode: NX parses ONLY with finish context within 2 tokens:
  /(?<![a-z0-9])([1-4])\s*x(?:\s|-|_)*(?=(spot\s*)?(gloss|uv|emboss))/i
  and the reverse order ("spot gloss 3x"). "Rainbow 3x OG" never matches.
- White: word "white" only when a finish context or label-side context
  exists ("white ink", "white layer", "+white", "holo white"); "white
  widow" (strain) protected by requiring finish adjacency — otherwise the
  hint downgrades to low-confidence and quarantines rather than routes.
- Matte/holographic feed MATERIAL hints (holographic currently has NO
  material record — quoting blocker, listed owner decision).
- Copy-suffix normalization: strip /( - Copy( \d+)?|\(\d+\)|copy ?\d*)$/i
  plus edit words for IDENTITY ONLY; a stripped-identity match with a NEW
  hash = revision candidate -> review, never silent.

## Parser contract (design)
parseEmployeeFilename(name) -> { customerHint, productHint, sizeHint,
materialHint, printerToken, modeHint{white,glossLayers}, revisionHint,
confidence } — pure, test-covered against a REAL corpus fixture file before
enabling; used ONLY at precedence levels 3-4 (after ERP metadata and
explicit tokens) and any sub-high confidence result quarantines instead of
routing. Employees are never asked to change anything.

## 15F.0J.4A inbox note (2026-07-26)
Filename habits unchanged; FOLDER contract clarified: drop new printable
files DIRECTLY into Prints For Today (the root). Files placed in any
subfolder are treated as storage/work copies and are not auto-routed.

## 15F.0J.5 — the compat parser is LIVE (2026-07-26)
parseFilenamePrintHints now routes unmatched files: NX counts only with
gloss/uv/emboss context; "white" only with finish adjacency (ink/layer/hd/
holo/Nx); ROLAND/MIMAKI word-boundary tokens; conflicts block. Employees
change NOTHING — a plain "Customer_Product_matte.pdf" auto-creates a
Mimaki CMYK print-intake job with its own GSO ticket.
