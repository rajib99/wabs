import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { sessionState } from "@/lib/channel/openwa-session";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db().execute(sql`select 1`);
    // The WhatsApp session can drop while the app stays healthy, so it is reported but does not fail the check.
    const whatsapp = env.channel() === "openwa" ? (await sessionState()).status ?? "unreachable" : undefined;
    return NextResponse.json({ status: "ok", db: "ok", whatsapp });
  } catch {
    return NextResponse.json({ status: "degraded", db: "down" }, { status: 503 });
  }
}
