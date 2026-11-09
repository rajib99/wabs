import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { currentQr, sessionState } from "@/lib/channel/openwa-session";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** The QR grants access to the WhatsApp account, so it is owner-only and never cached. */
export async function GET() {
  const session = await auth();
  if ((session?.user as { role?: string } | undefined)?.role !== "owner") return new NextResponse("forbidden", { status: 403 });
  if (env.channel() !== "openwa") return NextResponse.json({ status: null, qr: null });
  const state = await sessionState();
  const qr = state.status === "qr_ready" ? await currentQr() : null;
  return NextResponse.json({ status: state.status, reachable: state.reachable, qr }, { headers: { "Cache-Control": "no-store" } });
}
