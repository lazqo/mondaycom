/**
 * Product images for proposals. An image is converted once, when it is stored (to JPEG, or PNG when
 * it has transparency, at most 800 px), so a PDF never needs to fetch or convert anything. Images
 * are added by upload or by a one-time download from a manufacturer's page; nothing is scraped when
 * a document is generated.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { catalogueImages, products } from "@/db/schema";
import { ImageError, MAX_IMAGE_BYTES, prepareImage } from "./image-prep";

export { ImageError, prepareImage };

export async function storeImage(input: { content: Buffer; filename: string; sourceUrl?: string | null; uploadedById?: string | null }): Promise<string> {
  const img = await prepareImage(input.content);
  const sha256 = createHash("sha256").update(img.content).digest("hex");
  const ext = img.contentType === "image/png" ? "png" : "jpg";
  const [row] = await db
    .insert(catalogueImages)
    .values({
      filename: `${input.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 80) || "image"}.${ext}`,
      contentType: img.contentType,
      width: img.width,
      height: img.height,
      size: img.content.length,
      sha256,
      sourceUrl: input.sourceUrl ?? null,
      content: img.content,
      uploadedById: input.uploadedById ?? null,
    })
    .returning({ id: catalogueImages.id });
  return row.id;
}

/** Make an image the product's proposal image. The previous one is removed if nothing else uses it. */
export async function setProductImage(productId: string, imageId: string | null): Promise<void> {
  const before = await db.query.products.findFirst({ where: eq(products.id, productId), columns: { quoteImageId: true } });
  if (!before) throw new ImageError("Product not found.");
  await db.update(products).set({ quoteImageId: imageId, quoteContentUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(products.id, productId));
  const old = before.quoteImageId;
  if (old && old !== imageId) {
    const still = await db.query.products.findFirst({ where: eq(products.quoteImageId, old), columns: { id: true } });
    if (!still) await db.delete(catalogueImages).where(eq(catalogueImages.id, old)).catch(() => {});
  }
}

const privateV4 = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const privateV6 = (ip: string) => /^(::1|::|fc|fd|fe80)/i.test(ip) || ip.toLowerCase().startsWith("::ffff:") && privateV4(ip.slice(7));

/**
 * Download an image once from a public https address (a manufacturer's product page image).
 * Refuses anything that is not a public host, follows no redirects to private addresses, and stops
 * at 8 MB.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ImageError("That is not a valid web address.");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:") throw new ImageError("Use an https:// image address.");
    if (u.username || u.password) throw new ImageError("Addresses with a login are not allowed.");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) || /(^|\.)localhost$/i.test(host) || !host.includes(".")) throw new ImageError("Use the manufacturer's public image address.");
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new ImageError(`Could not find ${host}.`);
    if (addrs.some((a) => (a.family === 4 ? privateV4(a.address) : privateV6(a.address)))) throw new ImageError("That address is not a public website.");
    const res = await fetch(u, { redirect: "manual", headers: { accept: "image/png,image/jpeg,image/webp,image/*;q=0.8", "user-agent": "GetSecureCRM/1.0 (catalogue image)" }, signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location")!, u);
      continue;
    }
    if (!res.ok) throw new ImageError(`The image could not be downloaded (HTTP ${res.status}).`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new ImageError("That address is a web page, not an image. Right-click the product photo and copy the image address.");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) throw new ImageError("The image is larger than 8 MB.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new ImageError("The image is larger than 8 MB.");
    return buf;
  }
  throw new ImageError("Too many redirects.");
}
