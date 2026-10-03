/** Image conversion for print (no database), shared by storage and tests. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PX = 800;

export class ImageError extends Error {}

export type PreparedImage = { content: Buffer; contentType: "image/jpeg" | "image/png"; width: number; height: number };

/** Convert any common image (JPEG, PNG, WebP, GIF, AVIF, TIFF) to a print-ready JPEG/PNG. */
export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  if (!input.length) throw new ImageError("The file is empty.");
  if (input.length > MAX_IMAGE_BYTES) throw new ImageError("The image is larger than 8 MB.");
  const sharp = (await import("sharp")).default;
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ImageError("That file is not an image the CRM can read (use JPEG, PNG or WebP).");
  }
  if (!meta.width || !meta.height) throw new ImageError("That file is not a readable image.");
  const base = sharp(input).rotate().resize({ width: MAX_PX, height: MAX_PX, fit: "inside", withoutEnlargement: true });
  const out = meta.hasAlpha ? await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true }) : await base.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  return { content: out.data, contentType: meta.hasAlpha ? "image/png" : "image/jpeg", width: out.info.width, height: out.info.height };
}
