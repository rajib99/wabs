import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { rejectPaymentAction, verifyPaymentAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  await requireRole("owner", "verifier");
  // Claims waiting for a decision first. The payer's name helps match the claim to the bKash statement.
  const rows = await db().select({ p: schema.payments, payerName: schema.users.name }).from(schema.payments)
    .leftJoin(schema.users, eq(schema.users.phone, schema.payments.payerPhone))
    .orderBy(sql`CASE WHEN ${schema.payments.status} = 'pending' THEN 0 ELSE 1 END`, desc(schema.payments.createdAt)).limit(200);
  const pending = rows.filter((r) => r.p.status === "pending").length;
  return (
    <>
      <PageTitle>পেমেন্ট</PageTitle>
      <p className="mb-3 text-sm text-muted-foreground">যাচাইয়ের অপেক্ষায়: {pending}। অনুমোদন দিলে পেমেন্টকারী সঙ্গে সঙ্গে অন্য পক্ষের নম্বর পাবেন।</p>
      {rows.length === 0 && <p className="text-muted-foreground">এখনো কোনো পেমেন্ট নেই।</p>}
      <div className="flex flex-col gap-3">
        {rows.map(({ p, payerName }) => (
          <Card key={p.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-semibold">{p.trxId ?? "TrxID নেই"}</span>
              <Badge>{p.status}</Badge>
              <span className="tabular-nums">৳{p.amount}</span>
            </div>
            <div className="text-sm">
              <Link className="underline" href={`/admin/users/${encodeURIComponent(p.payerPhone)}`}>{payerName ?? p.payerPhone}</Link>
              <span className="text-muted-foreground"> · প্রস্তাব {p.matchId.slice(0, 8)}</span>
            </div>
            {p.claimDetails && <div className="text-sm">ব্যবহারকারী জানিয়েছেন: {p.claimDetails}</div>}
            <div className="text-sm text-muted-foreground">
              {p.senderWalletNumber ? `পাঠানো নম্বরের শেষ ৪: ${p.senderWalletNumber}` : "নম্বরের শেষ ৪ দেওয়া হয়নি"} · {p.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}
              {p.note && ` · ${p.note}`}{p.verifiedBy && ` · ${p.verifiedBy}`}
            </div>
            {p.status === "pending" && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <ActionForm action={verifyPaymentAction}><input type="hidden" name="id" value={p.id} /><Button className="w-full sm:w-auto">অনুমোদন (নম্বর পাঠান)</Button></ActionForm>
                <ActionForm action={rejectPaymentAction} className="flex flex-1 gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <Input name="note" placeholder="বাতিলের কারণ (ব্যবহারকারীকে পাঠানো হবে)" aria-label="বাতিলের কারণ" />
                  <Button variant="destructive">বাতিল</Button>
                </ActionForm>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
