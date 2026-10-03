/**
 * The branded Get Secure proposal PDF. Renders ProposalData (customer-facing content only) with the
 * Get Secure logo, palette and type (Outfit headings, Inter body), on A4. Normally 2–3 pages for a
 * residential quote. A product without an image simply has no picture; nothing is left blank.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ProposalData, ProposalProduct } from "./data";

export const BRAND = {
  forest: "#053225",
  forestSoft: "#13392d",
  sage: "#b5d2ad",
  sageLight: "#eaf2e7",
  beige: "#e7d7ca",
  cream: "#f8f4ef",
  ink: "#1d2a25",
  muted: "#5b6b64",
  rule: "#d9e4d5",
  white: "#ffffff",
};

const root = process.cwd();
const fontFile = (family: string, weight: number) => path.join(root, "src", "lib", "proposals", "fonts", `${family}-${weight}.ttf`);
let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  Font.register({ family: "Inter", fonts: [400, 500, 600, 700].map((w) => ({ src: fontFile("Inter", w), fontWeight: w })) });
  Font.register({ family: "Outfit", fonts: [500, 600, 700].map((w) => ({ src: fontFile("Outfit", w), fontWeight: w })) });
  // Keep words whole (no automatic hyphenation of product names).
  Font.registerHyphenationCallback((word) => [word]);
  fontsReady = true;
}

let logos: { onDark: Buffer; onLight: Buffer } | null = null;
function brandLogos() {
  if (!logos) {
    const dir = path.join(root, "public", "brand");
    logos = { onDark: fs.readFileSync(path.join(dir, "getsecure-logo-beige.png")), onLight: fs.readFileSync(path.join(dir, "getsecure-logo-forest.png")) };
  }
  return logos;
}

export type ProposalImage = { data: Buffer; contentType: string };

const money = (n: number) => `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nzDate = (iso: string) => new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "Pacific/Auckland" });

const s = StyleSheet.create({
  page: { fontFamily: "Inter", fontSize: 9.5, color: BRAND.ink, paddingTop: 36, paddingBottom: 56, paddingHorizontal: 0 },
  // Line height lives here, not on the Page: on the Page it breaks the page-number text.
  body: { paddingHorizontal: 40, lineHeight: "13.3pt" },
  band: { backgroundColor: BRAND.forest, marginTop: -36, paddingHorizontal: 40, paddingTop: 30, paddingBottom: 26, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  bandRight: { alignItems: "flex-end" },
  eyebrow: { fontFamily: "Outfit", fontWeight: 600, fontSize: 8.5, letterSpacing: 1.6, color: BRAND.sage, textTransform: "uppercase" },
  bandTitle: { fontFamily: "Outfit", fontWeight: 600, fontSize: 18, lineHeight: 1.2, color: BRAND.white, marginTop: 4 },
  meta: { flexDirection: "row", marginTop: 14, marginBottom: 2 },
  metaCell: { flexGrow: 1, flexBasis: 0, paddingRight: 10 },
  metaLabel: { fontSize: 7.5, color: BRAND.muted, textTransform: "uppercase", letterSpacing: 0.8 },
  metaValue: { fontFamily: "Inter", fontWeight: 600, fontSize: 10, marginTop: 2 },
  customer: { fontFamily: "Outfit", fontWeight: 700, fontSize: 22, lineHeight: 1.2, color: BRAND.forest, marginTop: 18 },
  site: { fontSize: 10.5, color: BRAND.muted, marginTop: 2 },
  h2: { fontFamily: "Outfit", fontWeight: 600, fontSize: 14, lineHeight: 1.2, color: BRAND.forest, marginTop: 16, marginBottom: 7 },
  h3: { fontFamily: "Outfit", fontWeight: 600, fontSize: 10.5, color: BRAND.forest, marginBottom: 4 },
  para: { fontSize: 10.5, lineHeight: "15.5pt" },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  chip: { backgroundColor: BRAND.sageLight, color: BRAND.forest, fontSize: 8.5, fontWeight: 500, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10, marginRight: 5, marginBottom: 5 },
  invest: { flexDirection: "row", backgroundColor: BRAND.cream, borderRadius: 6, padding: 14, marginTop: 14, alignItems: "center", justifyContent: "space-between", borderLeftWidth: 4, borderLeftColor: BRAND.forest },
  investLabel: { fontFamily: "Outfit", fontWeight: 600, fontSize: 11, color: BRAND.forest },
  investSub: { fontSize: 8.5, color: BRAND.muted, marginTop: 2 },
  investTotal: { fontFamily: "Outfit", fontWeight: 700, fontSize: 24, lineHeight: 1.2, color: BRAND.forest },
  card: { flexDirection: "row", borderWidth: 0.75, borderColor: BRAND.rule, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 7, backgroundColor: BRAND.white },
  imageBox: { width: 74, height: 74, marginRight: 14, alignItems: "center", justifyContent: "center" },
  image: { maxWidth: 74, maxHeight: 74, objectFit: "contain" },
  cardMain: { flexGrow: 1, flexBasis: 0 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  cardName: { fontFamily: "Outfit", fontWeight: 600, fontSize: 12.5, lineHeight: 1.25, color: BRAND.forest, flexGrow: 1, flexBasis: 0, paddingRight: 8 },
  badge: { backgroundColor: BRAND.forest, color: BRAND.white, fontWeight: 600, fontSize: 9, paddingVertical: 2.5, paddingHorizontal: 8, borderRadius: 9 },
  model: { fontSize: 7.5, color: BRAND.muted, marginTop: 0, marginBottom: 3 },
  highlights: { flexDirection: "row", flexWrap: "wrap", marginTop: 5 },
  highlight: { width: "50%", flexDirection: "row", marginBottom: 2.5, paddingRight: 6 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: BRAND.forest, marginTop: 4.2, marginRight: 6 },
  check: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: BRAND.sage, borderWidth: 1.5, borderColor: BRAND.forest, marginTop: 3, marginRight: 6 },
  bulletRow: { flexDirection: "row", marginBottom: 2.5 },
  table: { borderWidth: 0.75, borderColor: BRAND.rule, borderRadius: 6 },
  tr: { flexDirection: "row", paddingVertical: 3.5, paddingHorizontal: 10, borderBottomWidth: 0.5, borderBottomColor: BRAND.rule },
  th: { fontSize: 7.5, color: BRAND.muted, textTransform: "uppercase", letterSpacing: 0.8 },
  totalRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 3, paddingHorizontal: 10 },
  totalLabel: { width: 130, textAlign: "right", color: BRAND.muted },
  totalValue: { width: 90, textAlign: "right" },
  grand: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8, paddingHorizontal: 10, backgroundColor: BRAND.forest, borderBottomLeftRadius: 5, borderBottomRightRadius: 5 },
  twoCol: { flexDirection: "row" },
  col: { flexGrow: 1, flexBasis: 0, paddingRight: 12 },
  footer: { position: "absolute", bottom: 20, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 0.75, borderTopColor: BRAND.sage, paddingTop: 6, fontSize: 7.5, color: BRAND.muted },
  watermark: { position: "absolute", top: 380, left: 60, fontFamily: "Outfit", fontWeight: 700, fontSize: 64, color: "#c0392b", opacity: 0.12, transform: "rotate(-30deg)" },
});

function Bullets({ items, tick }: { items: string[]; tick?: boolean }) {
  return (
    <View>
      {items.map((t, i) => (
        <View key={i} style={s.bulletRow} wrap={false}>
          <View style={tick ? s.check : s.dot} />
          <Text style={{ flexGrow: 1, flexBasis: 0 }}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

function ProductCard({ p, image }: { p: ProposalProduct; image?: ProposalImage }) {
  return (
    <View style={s.card} wrap={false}>
      {image ? (
        <View style={s.imageBox}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
          <Image style={s.image} src={{ data: image.data, format: image.contentType === "image/png" ? "png" : "jpg" }} />
        </View>
      ) : null}
      <View style={s.cardMain}>
        <View style={s.cardHead}>
          <Text style={s.cardName}>{p.name}</Text>
          <Text style={s.badge}>× {p.quantity}</Text>
        </View>
        {p.model !== p.name ? <Text style={s.model}>{p.model}</Text> : <View style={{ height: 3 }} />}
        {p.description ? <Text>{p.description}</Text> : null}
        {p.highlights.length ? (
          <View style={s.highlights}>
            {p.highlights.map((h, i) => (
              <View key={i} style={s.highlight}>
                <View style={s.check} />
                <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: 9 }}>{h}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {p.featureNotes ? <Text style={{ fontSize: 8.5, color: BRAND.muted, marginTop: 4 }}>{p.featureNotes}</Text> : null}
      </View>
    </View>
  );
}

export function ProposalDocument({ data: d, images }: { data: ProposalData; images: Record<string, ProposalImage> }) {
  registerFonts();
  const logo = brandLogos();
  const t = d.totals;
  const notes = [...d.notes, ...(d.warranty.length ? [{ heading: "Warranty and support", items: d.warranty }] : [])];
  return (
    <Document title={`${d.heading} ${d.quoteNumber}`} author={d.company.name} subject={d.quoteTitle} creator="Get Secure CRM" producer="Get Secure CRM">
      <Page size="A4" style={s.page}>
        {/* Inline: react-pdf drops fixed elements wrapped in a component. */}
        <View style={s.footer} fixed>
          <Text>{[d.company.name, d.company.phone, d.company.email, d.company.website, d.company.gstNumber ? `GST ${d.company.gstNumber}` : null].filter(Boolean).join("  ·  ")}</Text>
          <Text render={({ pageNumber, totalPages }) => `${d.quoteNumber}  ·  Page ${pageNumber} of ${totalPages}`} />
        </View>
        {d.draft ? (
          <Text style={s.watermark} fixed>
            DRAFT: NOT APPROVED
          </Text>
        ) : null}
        <View style={s.band}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
          <Image src={{ data: logo.onDark, format: "png" }} style={{ width: 175 }} />
          <View style={s.bandRight}>
            <Text style={s.eyebrow}>Proposal {d.quoteNumber}</Text>
            <Text style={s.bandTitle}>{d.heading}</Text>
          </View>
        </View>

        <View style={s.body}>
          <Text style={{ ...s.eyebrow, color: BRAND.muted, marginTop: 18 }}>Prepared for</Text>
          <Text style={{ ...s.customer, marginTop: 2 }}>{d.customer.name}</Text>
          {d.customer.site ? <Text style={s.site}>{d.customer.site}</Text> : null}

          <View style={s.meta}>
            <View style={s.metaCell}>
              <Text style={s.metaLabel}>Quote</Text>
              <Text style={s.metaValue}>{d.quoteNumber}</Text>
            </View>
            <View style={s.metaCell}>
              <Text style={s.metaLabel}>Date</Text>
              <Text style={s.metaValue}>{nzDate(d.date)}</Text>
            </View>
            {d.validUntil ? (
              <View style={s.metaCell}>
                <Text style={s.metaLabel}>Valid until</Text>
                <Text style={s.metaValue}>{nzDate(d.validUntil)}</Text>
              </View>
            ) : null}
          </View>

          <Text style={s.h2}>Our recommendation</Text>
          <Text style={s.para}>{d.summary}</Text>
          {d.coverage.length ? (
            <View style={s.chips}>
              {d.coverage.map((c, i) => (
                <Text key={i} style={s.chip}>
                  {c}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={s.invest} wrap={false}>
            <View>
              <Text style={s.investLabel}>Total investment</Text>
              <Text style={s.investSub}>
                {money(t.subtotalExGst)} + GST ({t.gstRatePct}%) {money(t.gst)}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={s.investTotal}>{money(t.totalIncGst)}</Text>
              <Text style={s.investSub}>including GST</Text>
            </View>
          </View>

          {d.products.length ? (
            <View>
              <Text style={s.h2}>Your system</Text>
              {d.products.map((p) => (
                <ProductCard key={p.productId} p={p} image={p.imageId ? images[p.imageId] : undefined} />
              ))}
            </View>
          ) : null}

          {d.installation ? (
            <View wrap={false}>
              <Text style={s.h2}>Installation</Text>
              <Text style={{ fontWeight: 600, marginBottom: 4 }}>{d.installation.description}</Text>
              <Bullets items={d.installation.includes} tick />
            </View>
          ) : null}

          <View wrap={false}>
            <Text style={s.h2}>Investment summary</Text>
            <View style={s.table}>
              <View style={{ ...s.tr, backgroundColor: BRAND.sageLight }}>
                <Text style={{ ...s.th, flexGrow: 1, flexBasis: 0 }}>Item</Text>
                <Text style={{ ...s.th, width: 40, textAlign: "right" }}>Qty</Text>
              </View>
              {d.items.map((it, i) => (
                <View key={i} style={s.tr}>
                  <Text style={{ flexGrow: 1, flexBasis: 0 }}>{it.description}</Text>
                  <Text style={{ width: 40, textAlign: "right" }}>{it.quantity}</Text>
                </View>
              ))}
              <View style={{ paddingTop: 6 }}>
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Subtotal (excl. GST)</Text>
                  <Text style={s.totalValue}>{money(t.subtotalExGst)}</Text>
                </View>
                <View style={{ ...s.totalRow, paddingBottom: 8 }}>
                  <Text style={s.totalLabel}>GST ({t.gstRatePct}%)</Text>
                  <Text style={s.totalValue}>{money(t.gst)}</Text>
                </View>
                <View style={s.grand}>
                  <Text style={{ ...s.totalLabel, color: BRAND.sage, fontWeight: 600 }}>Total (incl. GST)</Text>
                  <Text style={{ ...s.totalValue, color: BRAND.white, fontFamily: "Outfit", fontWeight: 700, fontSize: 12 }}>{money(t.totalIncGst)}</Text>
                </View>
              </View>
            </View>
          </View>

          <Text style={s.h2}>Good to know</Text>
          <View style={s.twoCol}>
            {[0, 1].map((col) => (
              <View key={col} style={s.col}>
                {notes
                  .filter((_, i) => i % 2 === col)
                  .map((n) => (
                    <View key={n.heading} style={{ marginBottom: 8 }} wrap={false}>
                      <Text style={s.h3}>{n.heading}</Text>
                      <Bullets items={n.items} />
                    </View>
                  ))}
              </View>
            ))}
          </View>

          {d.nextSteps ? (
            <View style={{ marginTop: 16, padding: 14, borderRadius: 6, backgroundColor: BRAND.forest }} wrap={false}>
              <Text style={{ fontFamily: "Outfit", fontWeight: 600, fontSize: 12, color: BRAND.white }}>Next steps</Text>
              <Text style={{ color: BRAND.beige, marginTop: 4 }}>
                {d.nextSteps}
                {d.validUntil ? ` This proposal is valid until ${nzDate(d.validUntil)}.` : ""}
              </Text>
              <Text style={{ color: BRAND.sage, marginTop: 6, fontWeight: 600 }}>{[d.company.phone, d.company.email, d.company.website].filter(Boolean).join("   ·   ")}</Text>
            </View>
          ) : null}
        </View>
      </Page>
    </Document>
  );
}

export async function renderProposalPdf(data: ProposalData, images: Record<string, ProposalImage>): Promise<Buffer> {
  return renderToBuffer(<ProposalDocument data={data} images={images} />);
}
