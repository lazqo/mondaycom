/**
 * Starter proposal content for the products in the first approved VIGI kit: customer-facing name,
 * one-line description, highlights and the manufacturer's product photo (content/vigi-kit.json).
 *
 * Applied once per product, and only into empty fields: anything Chris has entered is never
 * overwritten, and a product he clears is not refilled. The wording is marked provisional until he
 * reviews it. Images are stored in the CRM here, once; documents never fetch them.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, products } from "@/db/schema";
import { storeImage } from "./images";
import starter from "./content/vigi-kit.json";

type StarterProduct = {
  manufacturer: string;
  model: string;
  quoteDisplayName: string;
  quoteDescription: string;
  quoteHighlights: string[];
  quoteFeatureNotes: string | null;
  image: string | null;
  imageSourceUrl: string | null;
};
export type StarterContent = { version: number; products: StarterProduct[] };

export const STARTER = starter as StarterContent;
const KEY = "proposal_starter_content";
const IMAGES = path.join(process.cwd(), "src", "lib", "proposals", "content", "images");
const key = (p: { manufacturer: string; model: string }) => `${p.manufacturer}|${p.model}`;

let applied = false;

export async function applyStarterContent(content: StarterContent = STARTER): Promise<{ filled: number }> {
  if (applied) return { filled: 0 };
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, KEY) });
  const state = (row?.value as { done?: string[]; photoPending?: string[] } | undefined) ?? {};
  const done = new Set(state.done ?? []);
  // Wording already applied whose photo could not be stored: only the photo is tried again.
  const photoPending = new Set(state.photoPending ?? []);
  let filled = 0;
  for (const s of content.products) {
    if (done.has(key(s))) continue;
    const p = await db.query.products.findFirst({ where: and(eq(products.manufacturer, s.manufacturer), eq(products.model, s.model)) });
    if (!p) continue; // not in the catalogue yet; tried again next time
    const patch: Partial<typeof products.$inferInsert> = {};
    if (!photoPending.has(key(s))) {
      if (!p.quoteDisplayName) patch.quoteDisplayName = s.quoteDisplayName;
      if (!p.quoteDescription) patch.quoteDescription = s.quoteDescription;
      if (!p.quoteHighlights.length && s.quoteHighlights.length) patch.quoteHighlights = s.quoteHighlights;
      if (!p.quoteFeatureNotes && s.quoteFeatureNotes) patch.quoteFeatureNotes = s.quoteFeatureNotes;
    }
    let imagePending = false;
    if (!p.quoteImageId && s.image) {
      const file = path.join(IMAGES, s.image);
      try {
        if (fs.existsSync(file)) patch.quoteImageId = await storeImage({ content: fs.readFileSync(file), filename: s.image, sourceUrl: s.imageSourceUrl });
      } catch {
        imagePending = true; // the wording still goes in; the photo is tried again next time
      }
    }
    if (Object.keys(patch).length) {
      // Wording Chris has not reviewed stays provisional; an existing status is left alone.
      if (p.quoteContentStatus === "requires_review" && patch.quoteDisplayName) patch.quoteContentStatus = "getsecure_provisional";
      await db
        .update(products)
        .set({ ...patch, quoteContentUpdatedAt: new Date() })
        .where(eq(products.id, p.id));
      filled++;
    }
    if (imagePending) photoPending.add(key(s));
    else {
      photoPending.delete(key(s));
      done.add(key(s));
    }
  }
  const value = { version: content.version, done: [...done], photoPending: [...photoPending] };
  await db.insert(appSettings).values({ key: KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  applied = content.products.every((s) => done.has(key(s)));
  return { filled };
}

/** For tests: forget the in-process "already applied" marker. */
export function resetStarterMarker() {
  applied = false;
}
