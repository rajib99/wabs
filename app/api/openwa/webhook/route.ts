import { NextResponse, type NextRequest } from "next/server";
import { OpenWAAdapter, parseOpenWAEvent, verifyOpenWASignature } from "@/lib/channel/openwa";
import { recordSessionEvent } from "@/lib/channel/openwa-session";
import { handleUnresolvedSenders, ingestPayload } from "@/lib/conversation/ingest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Receives OpenWA deliveries. Same contract as the Cloud API route: verify, persist, enqueue, return. */
export async function POST(req: NextRequest) {
  if (env.channel() !== "openwa") return new NextResponse("not active", { status: 503 });
  const raw = await req.text();
  if (!verifyOpenWASignature(raw, req.headers.get("x-openwa-signature"), env.openwa().OPENWA_WEBHOOK_SECRET)) {
    return new NextResponse("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }
  try {
    const { messages, statuses, session, unresolved } = parseOpenWAEvent(payload);
    await ingestPayload({ messages, statuses });
    if (unresolved.length) await handleUnresolvedSenders(new OpenWAAdapter(), unresolved);
    if (session) await recordSessionEvent(session);
  } catch (err) {
    // A non-2xx makes OpenWA redeliver; ingest is safe to repeat.
    logger.error({ err }, "OpenWA webhook ingest failed");
    return new NextResponse("retry", { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
