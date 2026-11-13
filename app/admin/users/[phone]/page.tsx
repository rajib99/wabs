import { asc, desc, eq, or } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PhotoReview } from "@/components/photo-review";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { endTakeoverAction, eraseUserAction, setBlockedAction, setContactVerifiedAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function UserPage({ params }: { params: Promise<{ phone: string }> }) {
  await requireRole("owner");
  const phone = decodeURIComponent((await params).phone);
  const d = db();
  const [user] = await d.select().from(schema.users).where(eq(schema.users.phone, phone));
  if (!user) notFound();
  const [answers, prefs, photos, messages, matches] = await Promise.all([
    d.select().from(schema.profileAnswers).where(eq(schema.profileAnswers.phone, phone)),
    d.select().from(schema.preferences).where(eq(schema.preferences.phone, phone)),
    d.select().from(schema.photos).where(eq(schema.photos.phone, phone)).orderBy(desc(schema.photos.createdAt)),
    d.select().from(schema.messages).where(eq(schema.messages.phone, phone)).orderBy(asc(schema.messages.createdAt)).limit(500),
    d.select().from(schema.matches).where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone))).orderBy(desc(schema.matches.createdAt)),
  ]);
  const storage = getStorage();
  const urlFor = (key: string) => storage.signedUrl(key);
  const photoItems = await Promise.all(photos.map(async (p) => ({ ...p, url: await urlFor(p.r2Key) })));
  const messageItems = await Promise.all(messages.map(async (m) => ({ ...m, url: m.mediaKey && m.direction === "inbound" ? await urlFor(m.mediaKey) : null })));

  return (
    <>
      <PageTitle>{user.name ?? phone}</PageTitle>
      <Card className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span>যোগাযোগ নম্বর: <strong>{user.contactPhone ?? "দেওয়া হয়নি"}</strong></span>
          {user.contactPhone && <Badge>{user.contactPhoneVerified ? "যাচাইকৃত" : "যাচাই হয়নি"}</Badge>}
          {user.contactPhoneSource && <Badge>{user.contactPhoneSource}</Badge>}
          {user.contactPhone && (
            <form action={setContactVerifiedAction} className="ml-auto">
              <input type="hidden" name="phone" value={phone} /><input type="hidden" name="verified" value={String(!user.contactPhoneVerified)} />
              <Button variant="outline">{user.contactPhoneVerified ? "যাচাই বাতিল" : "ফোন করে যাচাই করেছি"}</Button>
            </form>
          )}
        </div>
        {user.humanUntil && user.humanUntil.getTime() > Date.now() && (
          <div className="flex flex-wrap items-center gap-2">
            <span>Page inbox থেকে একজন কথা বলছেন; BS চুপ থাকবে {user.humanUntil.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })} পর্যন্ত।</span>
            <form action={endTakeoverAction} className="ml-auto"><input type="hidden" name="phone" value={phone} /><Button variant="outline">BS-কে ফিরিয়ে দিন</Button></form>
          </div>
        )}
      </Card>
      <Card className="flex flex-wrap items-center gap-2">
        <span className="break-all">{phone}</span><Badge>{user.status}</Badge>{user.blocked && <Badge>blocked</Badge>}
        <form action={setBlockedAction} className="ml-auto">
          <input type="hidden" name="phone" value={phone} /><input type="hidden" name="blocked" value={String(!user.blocked)} />
          <Button variant="outline">{user.blocked ? "আনব্লক" : "ব্লক"}</Button>
        </form>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-x-auto">
          <h2 className="mb-2 font-medium">প্রোফাইল</h2>
          <table className="w-full text-sm"><tbody>
            {answers.map((a) => (
              <tr key={a.id} className="border-t"><th className="p-1 text-left font-normal text-muted-foreground">{a.questionKey}</th>
                <td className="break-words p-1">{typeof a.value === "string" ? a.value : JSON.stringify(a.value)}</td>
                <td className="p-1 text-xs text-muted-foreground">{a.source} {a.confidence}</td></tr>
            ))}
          </tbody></table>
          {prefs.length > 0 && <>
            <h3 className="mb-1 mt-4 font-medium">পছন্দ</h3>
            <ul className="text-sm">{prefs.map((p) => <li key={p.id}>{p.field} {p.operator} {JSON.stringify(p.value)} {p.isDealbreaker && <Badge>dealbreaker</Badge>}</li>)}</ul>
          </>}
        </Card>
        <Card>
          <h2 className="mb-2 font-medium">ছবি</h2>
          {photoItems.length === 0 && <p className="text-sm text-muted-foreground">কোনো ছবি নেই।</p>}
          <div className="grid grid-cols-2 gap-2">
            {photoItems.map((p) => (
              <div key={p.id} className="flex flex-col gap-1">
                {p.approvedByAdmin !== false
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={p.url} alt="প্রোফাইল ছবি" className="aspect-square w-full rounded-md bg-muted object-contain" />
                  : <div className="flex aspect-square items-center justify-center rounded-md bg-muted text-sm">বাতিল ও মুছে ফেলা</div>}
                <span className="text-xs text-muted-foreground">{p.approvedByAdmin === null ? "অপেক্ষমাণ" : p.approvedByAdmin ? "অনুমোদিত" : "বাতিল"}</span>
                {p.approvedByAdmin === null && <PhotoReview id={p.id} />}
              </div>
            ))}
          </div>
          <h2 className="mb-2 mt-4 font-medium">ম্যাচ</h2>
          <ul className="text-sm">
            {matches.map((m) => <li key={m.id}><Link className="underline" href={`/admin/matches?id=${m.id}`}>{m.state} · {m.score}%</Link></li>)}
            {matches.length === 0 && <li className="text-muted-foreground">কোনো ম্যাচ নেই।</li>}
          </ul>
        </Card>
      </div>

      <Card>
        <h2 className="mb-2 font-medium">কথোপকথন</h2>
        <ol className="flex flex-col gap-2">
          {messageItems.map((m) => (
            <li key={m.id} className={`max-w-[85%] rounded-lg p-2 text-sm ${m.direction === "inbound" ? "self-start bg-muted" : "self-end border"}`}>
              {m.type === "voice" && m.url && <audio controls preload="none" src={m.url} className="mb-1 w-56 max-w-full" />}
              {m.type === "image" && m.url && <a className="underline" href={m.url}>[ছবি]</a>}
              <p className="whitespace-pre-wrap break-words">{m.transcript ?? m.rawText}</p>
              <p className="mt-1 text-xs text-muted-foreground">{m.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}{m.direction === "outbound" && ` · ${m.status}`}{m.usageSeconds != null && ` · ${m.usageSeconds}s`}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="flex flex-col gap-2 border-destructive">
        <h2 className="font-medium">সব তথ্য মুছে ফেলুন</h2>
        <p className="text-sm text-muted-foreground">প্রোফাইল, ছবি, কথোপকথন স্থায়ীভাবে মুছে যাবে। নিশ্চিত করতে ERASE লিখুন।</p>
        <form action={eraseUserAction} className="flex gap-2">
          <input type="hidden" name="phone" value={phone} />
          <Input name="confirm" placeholder="ERASE" aria-label="নিশ্চিত করুন" autoComplete="off" />
          <Button variant="destructive">মুছুন</Button>
        </form>
      </Card>
    </>
  );
}
