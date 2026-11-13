import { desc, sql } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { rejectPaymentAction, verifyPaymentAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  await requireRole("owner", "verifier");
  const rows = await db().select().from(schema.payments)
    .orderBy(sql`CASE WHEN ${schema.payments.status} = 'pending' THEN 0 ELSE 1 END`, desc(schema.payments.createdAt)).limit(200);
  return (
    <>
      <PageTitle>পেমেন্ট</PageTitle>
      {rows.length === 0 && <p className="text-muted-foreground">এখনো কোনো পেমেন্ট নেই।</p>}
      <div className="flex flex-col gap-3">
        {rows.map((p) => (
          <Card key={p.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-semibold">{p.trxId}</span>
              <Badge>{p.status}</Badge>
              <span className="tabular-nums">৳{p.amount}</span>
            </div>
            <div className="text-sm text-muted-foreground">
              {p.senderWalletNumber ? `পাঠানো নম্বরের শেষ ৪: ${p.senderWalletNumber}` : "নম্বরের শেষ ৪ দেওয়া হয়নি"} · {p.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}
              {p.note && ` · ${p.note}`}{p.verifiedBy && ` · ${p.verifiedBy}`}
            </div>
            {p.status === "pending" && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <form action={verifyPaymentAction}><input type="hidden" name="id" value={p.id} /><Button className="w-full sm:w-auto">যাচাই হয়েছে</Button></form>
                <form action={rejectPaymentAction} className="flex flex-1 gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <Input name="note" placeholder="বাতিলের কারণ (ব্যবহারকারীকে পাঠানো হবে)" aria-label="বাতিলের কারণ" />
                  <Button variant="destructive">বাতিল</Button>
                </form>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
