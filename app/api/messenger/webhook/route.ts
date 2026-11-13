import { NextResponse, type NextRequest } from "next/server";
import { parseMessengerEvent, verifyMessengerSignature } from "@/lib/channel/messenger";
import { ingestPayload, markReadUpTo, recordPageEcho } from "@/lib/conversation/ingest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function config() {
  try {
    return env.channel() === "messenger" ? env.messenger() : null;
  } catch (err) {
    logger.error({ err }, "Messenger webhook called but not configured");
    return null;
  }
}

export async function GET(req: NextRequest) {
  const cfg = config();
  if (!cfg) return new NextResponse("not active", { status: 503 });
  const q = req.nextUrl.searchParams;
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === cfg.MESSENGER_VERIFY_TOKEN) {
    return new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/** Verify, persist, enqueue, return 200 fast: Meta disables webhooks that are slow or keep failing. */
export async function POST(req: NextRequest) {
  const cfg = config();
  if (!cfg) return new NextResponse("not active", { status: 503 });
  const raw = await req.text();
  if (!verifyMessengerSignature(raw, req.headers.get("x-hub-signature-256"), cfg.MESSENGER_APP_SECRET)) {
    return new NextResponse("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }
  try {
    const { messages, statuses, reads, echoes } = parseMessengerEvent(payload, cfg.MESSENGER_APP_ID);
    for (const echo of echoes) await recordPageEcho(echo);
    await ingestPayload({ messages, statuses });
    for (const r of reads) await markReadUpTo(r.userKey, r.watermark);
  } catch (err) {
    logger.error({ err }, "Messenger webhook ingest failed");
    return new NextResponse("retry", { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
