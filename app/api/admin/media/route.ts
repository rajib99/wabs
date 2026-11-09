import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Admin access to private media. R2 redirects to a short-lived signed URL; local files are streamed. */
export async function GET(req: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return new NextResponse("unauthorized", { status: 401 });
  const key = req.nextUrl.searchParams.get("key");
  if (!key || key.startsWith("mock-inbound/")) return new NextResponse("not found", { status: 404 });
  await audit(email, "media.viewed", "media", key);
  const storage = getStorage();
  if (env.storage() === "r2") return NextResponse.redirect(await storage.signedUrl(key));
  try {
    const file = await storage.get(key);
    return new NextResponse(Buffer.from(file.bytes), { headers: { "Content-Type": file.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
