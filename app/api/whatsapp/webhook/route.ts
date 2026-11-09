import { NextResponse, type NextRequest } from "next/server";
import { verifyWhatsAppSignature } from "@/lib/channel/whatsapp";
import { getChannel } from "@/lib/channel";
import { ingestPayload } from "@/lib/conversation/ingest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function whatsappConfig() {
  try {
    return env.whatsapp();
  } catch (err) {
    logger.error({ err }, "WhatsApp webhook called but not configured");
    return null;
  }
}

const notConfigured = () => new NextResponse("not configured", { status: 503 });

export async function GET(req: NextRequest) {
  const cfg = whatsappConfig();
  if (!cfg) return notConfigured();
  const q = req.nextUrl.searchParams;
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === cfg.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  const cfg = whatsappConfig();
  if (!cfg) return notConfigured();
  const raw = await req.text();
  if (!verifyWhatsAppSignature(raw, req.headers.get("x-hub-signature-256"), cfg.WHATSAPP_APP_SECRET)) {
    return new NextResponse("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }
  try {
    await ingestPayload(getChannel().receiveMessage(payload));
  } catch (err) {
    // A non-2xx makes Meta redeliver; ingest is safe to repeat.
    logger.error({ err }, "webhook ingest failed");
    return new NextResponse("retry", { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
