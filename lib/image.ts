import sharp from "sharp";
import { logger } from "@/lib/logger";

export type ImageFile = { bytes: Uint8Array; mime: string };

/** Longest side tried first, then smaller ones: large enough to read a biodata, small enough to send. */
const SIDES = [2048, 1600, 1280, 1024];
const QUALITIES = [82, 72, 62];

/**
 * Re-encodes a photo as a JPEG of at most `maxBytes`. Always re-encodes, even when small: that drops EXIF metadata
 * (which can hold the phone's GPS location) and turns the camera's rotation flag into real pixels.
 * Anything sharp cannot read (a PDF, a damaged file) is returned unchanged.
 */
export async function optimizeImage(file: ImageFile, maxBytes: number): Promise<ImageFile> {
  if (!file.mime.startsWith("image/")) return file;
  let smallest: Buffer | null = null;
  try {
    for (const side of SIDES) {
      for (const quality of QUALITIES) {
        const out = await sharp(file.bytes, { failOn: "error", limitInputPixels: 100_000_000 })
          .rotate()
          .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" }) // transparent PNGs become white, not black
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        if (out.byteLength <= maxBytes) return { bytes: new Uint8Array(out), mime: "image/jpeg" };
        if (!smallest || out.byteLength < smallest.byteLength) smallest = out;
      }
    }
  } catch (err) {
    logger.warn({ err, mime: file.mime, bytes: file.bytes.byteLength }, "image could not be optimized; storing it as sent");
    return file;
  }
  // Only a very unusual image is still over the limit at 1024px: keep the smallest version made.
  return { bytes: new Uint8Array(smallest!), mime: "image/jpeg" };
}
