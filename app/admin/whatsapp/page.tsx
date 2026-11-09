import { desc, like } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { sessionState } from "@/lib/channel/openwa-session";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { connectWhatsAppAction, disconnectWhatsAppAction, saveAllowlistAction, setBotPausedAction } from "../actions";
import { LiveStatus } from "./live";

export const dynamic = "force-dynamic";

export default async function WhatsAppPage() {
  await requireRole("owner");
  const channel = env.channel();
  const [allowlist, enabled, paused, llm] = await Promise.all([
    getSetting<string[]>("live_allowlist"), getSetting<boolean>("live_allowlist_enabled"), getSetting<boolean>("bot_paused"), Promise.resolve(env.llmProvider()),
  ]);
  const state = channel === "openwa" ? await sessionState() : null;
  const events = await db().select().from(schema.auditLog).where(like(schema.auditLog.action, "session.%")).orderBy(desc(schema.auditLog.createdAt)).limit(10);

  return (
    <>
      <PageTitle>WhatsApp সংযোগ</PageTitle>
      <Card className="flex flex-wrap items-center gap-2"><span>চ্যানেল:</span><Badge>{channel}</Badge><span>LLM:</span><Badge>{llm}</Badge></Card>

      {channel !== "openwa" && (
        <Card><p>এই পেজের সংযোগ অংশ শুধু <code>CHANNEL=openwa</code> অবস্থায় কাজ করে। <code>.env</code> বদলে অ্যাপ আবার চালু করুন।</p></Card>
      )}

      {channel === "openwa" && (
        <Card className="flex flex-col gap-3">
          {state?.restriction && <p role="alert" className="font-medium text-destructive">WhatsApp এই নম্বরে সীমাবদ্ধতা দিয়েছে ({state.restriction.kind ?? "অজানা"})। মেসেজ পাঠানো কমান।</p>}
          <LiveStatus />
          {state?.lastError && <p className="break-words text-sm text-muted-foreground">{state.lastError}</p>}
          {llm === "mock" && <p role="alert" className="text-destructive">LLM_PROVIDER=mock আসল মানুষের সঙ্গে কথা বলতে পারে না। DeepSeek কী দিন।</p>}
          <form action={connectWhatsAppAction}><Button>{state?.exists ? "আবার সংযোগ করুন" : "সংযোগ শুরু করুন"}</Button></form>
        </Card>
      )}

      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">BS চালু/বিরতি</h2>
        <p className="text-sm text-muted-foreground">বিরতিতে মেসেজ জমা থাকে, চালু করলে উত্তর যায় (২৪ ঘণ্টার মধ্যের মেসেজ)। STOP সবসময় কাজ করে।</p>
        <form action={setBotPausedAction}>
          <input type="hidden" name="paused" value={String(!paused)} />
          <Button variant={paused ? "default" : "outline"}>{paused ? "BS চালু করুন" : "BS বিরতি দিন"}</Button>
        </form>
        {paused && <p role="status" className="font-medium">BS এখন বিরতিতে আছে।</p>}
      </Card>

      <Card>
        <form action={saveAllowlistAction} className="flex flex-col gap-3">
          <h2 className="font-medium">পরীক্ষকের তালিকা</h2>
          <p className="text-sm text-muted-foreground">চালু থাকলে BS শুধু এই নম্বরগুলোর উত্তর দেয়; অন্যদের মেসেজ সংরক্ষণও হয় না। সবার জন্য খোলার আগে এটি বন্ধ করবেন না।</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={enabled} />শুধু তালিকার নম্বরকে উত্তর দিন</label>
          <label className="flex flex-col gap-1 text-sm">নম্বর (প্রতি লাইনে একটি, যেমন 01712345678)
            <Textarea name="allowlist" rows={4} defaultValue={allowlist.join("\n")} dir="ltr" className="font-mono" />
          </label>
          <Button className="self-start">সংরক্ষণ</Button>
        </form>
      </Card>

      {events.length > 0 && (
        <Card>
          <h2 className="mb-2 font-medium">সেশনের সাম্প্রতিক ঘটনা</h2>
          <ul className="text-sm">
            {events.map((e) => (
              <li key={e.id} className="break-words border-t py-1">{e.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })} · {e.action} {JSON.stringify(e.details)}</li>
            ))}
          </ul>
        </Card>
      )}

      {channel === "openwa" && state?.exists && (
        <Card className="flex flex-col gap-2 border-destructive">
          <h2 className="font-medium">নম্বর আনলিংক করুন</h2>
          <p className="text-sm text-muted-foreground">BS আর মেসেজ পাবে না; আবার QR স্ক্যান করতে হবে। নিশ্চিত করতে UNLINK লিখুন।</p>
          <form action={disconnectWhatsAppAction} className="flex gap-2">
            <Input name="confirm" placeholder="UNLINK" aria-label="নিশ্চিত করুন" autoComplete="off" />
            <Button variant="destructive">আনলিংক</Button>
          </form>
        </Card>
      )}
    </>
  );
}
