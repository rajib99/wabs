import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

export type StoredFile = { bytes: Uint8Array; mime: string };

export interface FileStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  /** A short-lived URL an authenticated admin's browser can open. */
  signedUrl(key: string): Promise<string>;
}

export class LocalFileStore implements FileStore {
  private resolve(key: string) {
    const root = path.resolve(env.localStorageDir());
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) throw new Error("invalid storage key");
    return file;
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(`${file}.mime`, mime);
  }
  async get(key: string) {
    const file = this.resolve(key);
    const [bytes, mime] = await Promise.all([readFile(file), readFile(`${file}.mime`, "utf8")]);
    return { bytes: new Uint8Array(bytes), mime };
  }
  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.mime`, { force: true });
  }
  /** Served through the authenticated admin media route. */
  async signedUrl(key: string) {
    return `/api/admin/media?key=${encodeURIComponent(key)}`;
  }
}

export class R2FileStore implements FileStore {
  private cached?: { client: S3Client; bucket: string };
  private conn() {
    if (!this.cached) {
      const cfg = env.r2();
      this.cached = {
        bucket: cfg.R2_BUCKET,
        client: new S3Client({
          region: "auto",
          endpoint: `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY },
        }),
      };
    }
    return this.cached;
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    const { client, bucket } = this.conn();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
  }
  async get(key: string) {
    const { client, bucket } = this.conn();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { bytes: await res.Body!.transformToByteArray(), mime: res.ContentType ?? "application/octet-stream" };
  }
  async delete(key: string) {
    const { client, bucket } = this.conn();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  async signedUrl(key: string) {
    const { client, bucket } = this.conn();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
  }
}

let store: FileStore | undefined;

export function getStorage(): FileStore {
  store ??= env.storage() === "r2" ? new R2FileStore() : new LocalFileStore();
  return store;
}
