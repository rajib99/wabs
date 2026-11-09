import { and, desc, eq, gte } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { MATCH_STATES } from "@/lib/matches";
import type { BreakdownEntry } from "@/lib/matching/score";

export const dynamic = "force-dynamic";

export default async function MatchesPage({ searchParams }: { searchParams: Promise<{ state?: string; min?: string; id?: string }> }) {
  await requireRole("owner");
  const { state, min, id } = await searchParams;
  const minScore = Number(min);
  const rows = await db().select().from(schema.matches).where(and(
    state ? eq(schema.matches.state, state) : undefined,
    Number.isFinite(minScore) && min ? gte(schema.matches.score, minScore) : undefined,
    id && /^[0-9a-f-]{36}$/.test(id) ? eq(schema.matches.id, id) : undefined,
  )).orderBy(desc(schema.matches.createdAt)).limit(100);
  return (
    <>
      <PageTitle>ম্যাচ</PageTitle>
      <form className="flex flex-col gap-2 sm:flex-row">
        <Select name="state" defaultValue={state ?? ""} aria-label="অবস্থা"><option value="">সব অবস্থা</option>{MATCH_STATES.map((s) => <option key={s}>{s}</option>)}</Select>
        <Input name="min" type="number" defaultValue={min} placeholder="সর্বনিম্ন স্কোর" aria-label="সর্বনিম্ন স্কোর" />
        <Button>ফিল্টার</Button>
      </form>
      {rows.length === 0 && <p className="text-muted-foreground">কোনো ম্যাচ নেই।</p>}
      <div className="flex flex-col gap-3">
        {rows.map((m) => (
          <Card key={m.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold tabular-nums">{m.score}%</span><Badge>{m.state}</Badge>
              {m.closeReason && <Badge>{m.closeReason}</Badge>}
              <span className="break-all text-sm text-muted-foreground">{m.userA} · {m.userB}</span>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm">স্কোরের হিসাব</summary>
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-sm tabular-nums">
                  <thead className="text-left text-muted-foreground"><tr><th className="p-1">ক্ষেত্র</th><th className="p-1 text-right">ওজন</th><th className="p-1 text-right">A→B</th><th className="p-1 text-right">B→A</th><th className="p-1 text-right">পয়েন্ট</th></tr></thead>
                  <tbody>{(m.breakdown as BreakdownEntry[]).map((b) => (
                    <tr key={b.field} className="border-t"><td className="p-1">{b.field}</td><td className="p-1 text-right">{b.weight}</td><td className="p-1 text-right">{b.a_to_b.toFixed(2)}</td><td className="p-1 text-right">{b.b_to_a.toFixed(2)}</td><td className="p-1 text-right">{b.points.toFixed(1)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
              <ul className="mt-2 text-xs text-muted-foreground">{Object.entries(m.stateTimestamps).map(([s, t]) => <li key={s}>{s}: {new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}</li>)}</ul>
            </details>
          </Card>
        ))}
      </div>
    </>
  );
}
