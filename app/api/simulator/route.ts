import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { mockMediaKey } from "@/lib/channel/mock";
import { ingestPayload } from "@/lib/conversation/ingest";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Exists only with the mock channel. Needs an owner session, or SIMULATOR_TOKEN for the test script. */
async function allowed(req: NextRequest) {
  if (env.channel() !== "mock") return false;
  const token = process.env.SIMULATOR_TOKEN;
  if (token && req.headers.get("x-simulator-token") === token) return true;
  const session = await auth();
  return (session?.user as { role?: string } | undefined)?.role === "owner";
}

const body = z.object({
  phone: z.string().regex(/^\+\d{8,15}$/),
  type: z.enum(["text", "voice", "image"]).default("text"),
  text: z.string().max(4000).optional(),
  media_base64: z.string().optional(),
  media_mime: z.string().optional(),
});

export async function POST(req: NextRequest) {
  if (!(await allowed(req))) return new NextResponse("forbidden", { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { phone, type, text, media_base64, media_mime } = parsed.data;
  let mediaId: string | undefined;
  if (media_base64) {
    mediaId = randomUUID();
    await getStorage().put(mockMediaKey(mediaId), Buffer.from(media_base64, "base64"), media_mime ?? "application/octet-stream");
  }
  const waMessageId = `sim-${randomUUID()}`;
  await ingestPayload({ messages: [{ waMessageId, phone, type, text, mediaId, mediaMime: media_mime, timestamp: new Date() }], statuses: [] });
  return NextResponse.json({ waMessageId });
}

export async function GET(req: NextRequest) {
  if (!(await allowed(req))) return new NextResponse("forbidden", { status: 403 });
  const phone = req.nextUrl.searchParams.get("phone");
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });
  const rows = await db().select().from(schema.messages).where(eq(schema.messages.phone, phone)).orderBy(asc(schema.messages.createdAt));
  return NextResponse.json({
    messages: rows.map((m) => ({
      id: m.id, direction: m.direction, type: m.type, text: m.transcript ?? m.rawText, status: m.status, dedupe_key: m.dedupeKey, created_at: m.createdAt,
    })),
  });
}
