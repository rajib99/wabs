import { desc, sql } from "drizzle-orm";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { resolveEscalationAction } from "../actions";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = { human: "মানুষের সাহায্য", report: "অভিযোগ", refund: "রিফান্ড সিদ্ধান্ত" };

export default async function InboxPage() {
  const { role } = await requireRole("owner", "verifier");
  const rows = await db().select().from(schema.escalations)
    .orderBy(sql`CASE WHEN ${schema.escalations.status} = 'open' THEN 0 ELSE 1 END`, desc(schema.escalations.createdAt)).limit(200);
  return (
    <>
      <PageTitle>ইনবক্স</PageTitle>
      {rows.length === 0 && <p className="text-muted-foreground">কোনো বিষয় নেই।</p>}
      <div className="flex flex-col gap-3">
        {rows.map((e) => (
          <Card key={e.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{KIND[e.kind] ?? e.kind}</Badge><Badge>{e.status}</Badge>
              {role === "owner"
                ? <Link className="text-sm underline" href={`/admin/users/${encodeURIComponent(e.phone)}`}>{e.phone}</Link>
                : <span className="text-sm">{e.phone}</span>}
              <span className="text-sm text-muted-foreground">{e.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}</span>
            </div>
            <p className="whitespace-pre-wrap break-words">{e.reason}</p>
            {e.status === "open" && (
              <form action={resolveEscalationAction}><input type="hidden" name="id" value={e.id} /><Button variant="outline">সমাধান হয়েছে</Button></form>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
