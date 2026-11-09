import { desc, ilike, or } from "drizzle-orm";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireRole("owner");
  const q = ((await searchParams).q ?? "").trim();
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = await db().select().from(schema.users)
    .where(q ? or(ilike(schema.users.phone, like), ilike(schema.users.name, like)) : undefined)
    .orderBy(desc(schema.users.createdAt)).limit(100);
  return (
    <>
      <PageTitle>ব্যবহারকারী</PageTitle>
      <form className="flex gap-2">
        <Input name="q" defaultValue={q} placeholder="ফোন নম্বর বা নাম" aria-label="খুঁজুন" />
        <Button>খুঁজুন</Button>
      </form>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left"><tr><th className="p-2 pl-4">ফোন</th><th className="p-2">নাম</th><th className="p-2">অবস্থা</th><th className="p-2 pr-4">প্রোফাইল</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.phone} className="border-t">
                <td className="p-2 pl-4"><Link className="underline" href={`/admin/users/${encodeURIComponent(u.phone)}`}>{u.phone}</Link></td>
                <td className="p-2">{u.name ?? "—"}</td>
                <td className="p-2"><Badge>{u.status}</Badge>{u.blocked && <Badge className="ml-1">blocked</Badge>}</td>
                <td className="p-2 pr-4">{u.profileComplete ? "সম্পূর্ণ" : "অসম্পূর্ণ"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="p-4 text-muted-foreground">কাউকে পাওয়া যায়নি।</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
