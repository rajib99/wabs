import { and, asc, isNull, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { PhotoReview } from "@/components/photo-review";
import { Card, PageTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function PhotosPage() {
  const { role } = await requireRole("owner", "verifier");
  const rows = await db().select().from(schema.photos)
    .where(and(isNull(schema.photos.approvedByAdmin), isNotNull(schema.photos.ownerConfirmedAt)))
    .orderBy(asc(schema.photos.createdAt)).limit(50);
  const storage = getStorage();
  const items = await Promise.all(rows.map(async (p) => ({ ...p, url: await storage.signedUrl(p.r2Key) })));
  return (
    <>
      <PageTitle>ছবি যাচাই</PageTitle>
      {items.length === 0 && <p className="text-muted-foreground">অপেক্ষমাণ কোনো ছবি নেই।</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => (
          <Card key={p.id} className="flex flex-col gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt="যাচাইয়ের অপেক্ষায় থাকা প্রোফাইল ছবি" className="aspect-square w-full rounded-md bg-muted object-contain" />
            {role === "owner" && <Link className="text-sm underline" href={`/admin/users/${encodeURIComponent(p.phone)}`}>{p.phone}</Link>}
            <PhotoReview id={p.id} />
          </Card>
        ))}
      </div>
    </>
  );
}
