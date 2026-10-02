# Verified product research

Source data for the Business Brain reference catalogue. Each JSON file holds products whose
specifications were read on the date shown from the manufacturer's own product page or datasheet
(`sourceUrl`), in the format described in `FORMAT.md`. Values that the source did not publish, or
where two manufacturer sources disagreed, are left out and listed in each product's `unverified`
and `notes`. No prices.

Rebuild the catalogue the app loads after editing these files:

    node scripts/build-reference-catalogue.mjs

This writes `src/lib/brain/reference/catalogue.json`. On start-up the CRM adds any product it has not
added before; products already added (or deleted) in Settings are never overwritten or re-added.

Known gaps at v0.2:

- hikvision.com blocks automated access; Hikvision specs come from the official Hikvision datasheet
  PDFs that IT Plus hosts on its product pages.
- Hikvision's AcuSeek camera-compatibility checklist lists series patterns only, so those
  camera ↔ recorder links are not imported (same-family matching covers Hikvision on Hikvision).
- Tiandy publishes no specs for its 6MP wired turrets/bullets; a 4MP and an 8MP model are used.
- Many cameras publish no bitrate (Ajax, Axis, Hanwha, VIGI C340); Get Secure's expected bitrate has
  to be set on those for storage and bandwidth to be calculated.
