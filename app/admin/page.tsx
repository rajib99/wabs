import { sql } from "drizzle-orm";
import { Card, PageTitle, Stat } from "@/components/ui/card";
import { requireRole } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

const bdt = (n: number) => `৳${n.toLocaleString("en-IN")}`;

export default async function StatsPage() {
  await requireRole("owner");
  const one = async <T,>(q: ReturnType<typeof sql>) => (await db().execute(q)).rows[0] as T;
  const users = await one<{ total: number; consented: number; complete: number; today: number }>(sql`
    SELECT count(*) FILTER (WHERE status <> 'deleted')::int total,
           count(*) FILTER (WHERE consent_at IS NOT NULL)::int consented,
           count(*) FILTER (WHERE profile_complete)::int complete,
           count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka') AND status <> 'deleted')::int today
    FROM users`);
  const matches = await one<{ total: number; both: number; released: number }>(sql`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE state_timestamps ? 'both_interested')::int both,
           count(*) FILTER (WHERE state = 'contact_released')::int released
    FROM matches`);
  const pay = await one<{ pending: number; verified: number; revenue: number }>(sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int pending,
           count(*) FILTER (WHERE status = 'verified')::int verified,
           coalesce(sum(amount) FILTER (WHERE status = 'verified'), 0)::int revenue
    FROM payments`);
  const open = await one<{ n: number }>(sql`SELECT count(*)::int n FROM escalations WHERE status = 'open'`);
  const days = (await db().execute(sql`
    WITH d AS (SELECT generate_series(0, 13) AS back),
    day AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') - back * interval '1 day')::date AS day FROM d)
    SELECT day::text,
      (SELECT count(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Asia/Dhaka')::date = day AND u.status <> 'deleted')::int AS new_users,
      (SELECT count(*) FROM matches m WHERE (m.created_at AT TIME ZONE 'Asia/Dhaka')::date = day)::int AS matches,
      (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.status = 'verified' AND (p.verified_at AT TIME ZONE 'Asia/Dhaka')::date = day)::int AS revenue
    FROM day ORDER BY day DESC`)).rows as { day: string; new_users: number; matches: number; revenue: number }[];
  const rate = users.consented ? Math.round((100 * users.complete) / users.consented) : 0;
  const bkash = await getSetting<string>("bkash_number");

  return (
    <>
      <PageTitle>পরিসংখ্যান</PageTitle>
      {!bkash && (
        <Card role="alert" className="border-destructive">
          bKash নম্বর সেট করা নেই। এটি ছাড়া পেমেন্ট ধাপ চলবে না। <a className="underline" href="/admin/templates">এখনই সেট করুন</a>।
        </Card>
      )}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="আজ নতুন ব্যবহারকারী" value={users.today} hint={`মোট ${users.total}`} />
        <Stat label="প্রোফাইল সম্পূর্ণের হার" value={`${rate}%`} hint={`সম্মতিদাতা ${users.consented} জনের ${users.complete} জন`} />
        <Stat label="ম্যাচ" value={matches.total} hint={`দুই পক্ষ আগ্রহী ${matches.both}, নম্বর বিনিময় ${matches.released}`} />
        <Stat label="মোট আয়" value={bdt(pay.revenue)} hint={`যাচাই ${pay.verified}, অপেক্ষমাণ ${pay.pending}`} />
      </section>
      {open.n > 0 && <p><a className="underline" href="/admin/inbox">ইনবক্সে {open.n}টি খোলা বিষয় আছে</a></p>}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="p-4 text-left font-medium">গত ১৪ দিন (বাংলাদেশ সময়)</caption>
          <thead className="bg-muted text-left"><tr><th className="p-2 pl-4">তারিখ</th><th className="p-2 text-right">নতুন ব্যবহারকারী</th><th className="p-2 text-right">ম্যাচ</th><th className="p-2 pr-4 text-right">আয়</th></tr></thead>
          <tbody className="tabular-nums">
            {days.map((d) => (
              <tr key={d.day} className="border-t"><td className="p-2 pl-4">{d.day}</td><td className="p-2 text-right">{d.new_users}</td><td className="p-2 text-right">{d.matches}</td><td className="p-2 pr-4 text-right">{bdt(d.revenue)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
