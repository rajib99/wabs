import { desc, like, or } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { messengerStatus } from "@/lib/channel/messenger";
import { sessionState } from "@/lib/channel/openwa-session";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import {
  applyMessengerSetupAction, connectWhatsAppAction, disconnectWhatsAppAction, saveAllowlistAction, saveTakeoverHoursAction, setBotPausedAction,
} from "../actions";
import { LiveStatus } from "./live";

export const dynamic = "force-dynamic";

export default async function ChannelPage() {
  await requireRole("owner");
  const channel = env.channel();
  const [allowlist, enabled, paused, takeoverHours] = await Promise.all([
    getSetting<string[]>("live_allowlist"), getSetting<boolean>("live_allowlist_enabled"), getSetting<boolean>("bot_paused"), getSetting<number>("human_takeover_hours"),
  ]);
  const llm = env.llmProvider();
  const openwa = channel === "openwa" ? await sessionState() : null;
  const messenger = channel === "messenger" ? await messengerStatus() : null;
  const events = await db().select().from(schema.auditLog)
    .where(or(like(schema.auditLog.action, "session.%"), like(schema.auditLog.action, "messenger.%"), like(schema.auditLog.action, "conversation.human_takeover")))
    .orderBy(desc(schema.auditLog.createdAt)).limit(10);

  return (
    <>
      <PageTitle>চ্যানেল</PageTitle>
      <Card className="flex flex-wrap items-center gap-2"><span>চ্যানেল:</span><Badge>{channel}</Badge><span>LLM:</span><Badge>{llm}</Badge></Card>
      {llm === "mock" && channel !== "mock" && <Card role="alert" className="border-destructive">LLM_PROVIDER=mock আসল মানুষের সঙ্গে কথা বলতে পারে না। DeepSeek কী দিন।</Card>}

      {channel === "messenger" && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">Facebook Messenger</h2>
          {messenger?.ok
            ? <p>Page সংযুক্ত: <strong>{messenger.page}</strong></p>
            : <p role="alert" className="text-destructive">Page token কাজ করছে না: {messenger?.error}</p>}
          <p className="text-sm text-muted-foreground">Meta app-এর Webhooks-এ এই URL দিন: <code className="break-all">{env.publicUrl()}/api/messenger/webhook</code></p>
          <p className="text-sm text-muted-foreground">নিচের বোতাম Get Started, স্বাগত বার্তা ও মেনু (মানুষের সাহায্য, তথ্য মুছুন, গোপনীয়তা নীতি) সেট করে এবং Page-এর ইভেন্টে app যুক্ত করে।</p>
          <form action={applyMessengerSetupAction}><Button>Messenger সেটআপ প্রয়োগ করুন</Button></form>
          <form action={saveTakeoverHoursAction} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">Page inbox থেকে কেউ উত্তর দিলে BS কত ঘণ্টা চুপ থাকবে
              <Input type="number" name="human_takeover_hours" min="1" max="168" defaultValue={takeoverHours} className="w-32" />
            </label>
            <Button variant="outline">সংরক্ষণ</Button>
          </form>
        </Card>
      )}

      {channel === "openwa" && (
        <Card className="flex flex-col gap-3">
          {openwa?.restriction && <p role="alert" className="font-medium text-destructive">WhatsApp এই নম্বরে সীমাবদ্ধতা দিয়েছে ({openwa.restriction.kind ?? "অজানা"})।</p>}
          <LiveStatus />
          <form action={connectWhatsAppAction}><Button>{openwa?.exists ? "আবার সংযোগ করুন" : "সংযোগ শুরু করুন"}</Button></form>
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

      {(channel === "openwa" || channel === "whatsapp") && (
        <Card>
          <form action={saveAllowlistAction} className="flex flex-col gap-3">
            <h2 className="font-medium">পরীক্ষকের তালিকা</h2>
            <p className="text-sm text-muted-foreground">চালু থাকলে BS শুধু এই নম্বরগুলোর উত্তর দেয়; অন্যদের মেসেজ সংরক্ষণও হয় না।</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={enabled} />শুধু তালিকার নম্বরকে উত্তর দিন</label>
            <label className="flex flex-col gap-1 text-sm">নম্বর (প্রতি লাইনে একটি)
              <Textarea name="allowlist" rows={4} defaultValue={allowlist.join("\n")} dir="ltr" className="font-mono" />
            </label>
            <Button className="self-start">সংরক্ষণ</Button>
          </form>
        </Card>
      )}
      {channel === "messenger" && (
        <Card><p className="text-sm text-muted-foreground">Messenger-এ পরীক্ষকের তালিকা নেই: App Review-এর আগে Meta নিজেই শুধু app-এর Admin/Developer/Tester ভূমিকার মানুষকে Page-এ মেসেজ করতে দেয়।</p></Card>
      )}

      {events.length > 0 && (
        <Card>
          <h2 className="mb-2 font-medium">সাম্প্রতিক ঘটনা</h2>
          <ul className="text-sm">
            {events.map((e) => (
              <li key={e.id} className="break-words border-t py-1">{e.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })} · {e.action}</li>
            ))}
          </ul>
        </Card>
      )}

      {channel === "openwa" && openwa?.exists && (
        <Card className="flex flex-col gap-2 border-destructive">
          <h2 className="font-medium">নম্বর আনলিংক করুন</h2>
          <form action={disconnectWhatsAppAction} className="flex gap-2">
            <Input name="confirm" placeholder="UNLINK" aria-label="নিশ্চিত করুন" autoComplete="off" />
            <Button variant="destructive">আনলিংক</Button>
          </form>
        </Card>
      )}
    </>
  );
}
