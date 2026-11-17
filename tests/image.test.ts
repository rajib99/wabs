import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { optimizeImage } from "@/lib/image";

const MB2 = 2 * 1024 * 1024;

/** A large photo full of noise (hard to compress), with EXIF that includes a GPS position. */
async function bigPhoto() {
  const w = 4000, h = 3000;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "23/1 48/1 0/1" } })
    .jpeg({ quality: 100 }).toBuffer();
}

describe("optimizeImage", () => {
  it("shrinks a large photo under 2 MB and strips its metadata", async () => {
    const input = await bigPhoto();
    expect(input.byteLength).toBeGreaterThan(MB2);
    expect((await sharp(input).metadata()).exif).toBeTruthy();
    const out = await optimizeImage({ bytes: new Uint8Array(input), mime: "image/jpeg" }, MB2);
    expect(out.mime).toBe("image/jpeg");
    expect(out.bytes.byteLength).toBeLessThanOrEqual(MB2);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
  });
  it("re-encodes a small PNG as JPEG, never enlarging it", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await optimizeImage({ bytes: new Uint8Array(png), mime: "image/png" }, MB2);
    const meta = await sharp(out.bytes).metadata();
    expect([out.mime, meta.width, meta.height]).toEqual(["image/jpeg", 40, 30]);
  });
  it("leaves files it cannot read as they were", async () => {
    const pdf = { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mime: "application/pdf" };
    expect(await optimizeImage(pdf, MB2)).toBe(pdf);
    const broken = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mime: "image/jpeg" };
    expect(await optimizeImage(broken, MB2)).toBe(broken);
  });
});
