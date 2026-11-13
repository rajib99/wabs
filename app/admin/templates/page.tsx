import { Button } from "@/components/ui/button";
import { Card, PageTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { getSetting } from "@/lib/settings";
import { DEFAULT_MESSAGES } from "@/lib/settings-defaults";
import { saveMessagesAction, savePricingAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  await requireRole("owner");
  const [price, bkash, trx, perMin, perDay, lang, templates, messages, prompt, mtemplates] = await Promise.all([
    getSetting<number>("price_bdt"), getSetting<string>("bkash_number"), getSetting<string>("trx_id_pattern"),
    getSetting<number>("rate_limit_per_minute"), getSetting<number>("rate_limit_per_day"), getSetting<string>("template_language"),
    getSetting<Record<string, string>>("templates"), getSetting<Record<string, string>>("messages"), getSetting<string>("system_prompt"),
    getSetting<Record<string, string>>("messenger_templates"),
  ]);
  const merged = { ...DEFAULT_MESSAGES, ...messages };
  return (
    <>
      <PageTitle>বার্তা ও মূল্য</PageTitle>
      <form action={savePricingAction}>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">মূল্য ও bKash</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">মূল্য (টাকা)<Input type="number" name="price_bdt" defaultValue={price} min="1" required /></label>
            <label className="flex flex-col gap-1 text-sm">bKash নম্বর<Input name="bkash_number" defaultValue={bkash} placeholder="01XXXXXXXXX" dir="ltr" /></label>
            <label className="flex flex-col gap-1 text-sm">Transaction ID pattern<Input name="trx_id_pattern" defaultValue={trx} className="font-mono" dir="ltr" required /></label>
            <label className="flex flex-col gap-1 text-sm">প্রতি মিনিটে বার্তার সীমা<Input type="number" name="rate_limit_per_minute" defaultValue={perMin} min="1" required /></label>
            <label className="flex flex-col gap-1 text-sm">প্রতিদিন বার্তার সীমা<Input type="number" name="rate_limit_per_day" defaultValue={perDay} min="1" required /></label>
          </div>
          <h2 className="mt-2 font-medium">Messenger utility টেমপ্লেট</h2>
          <p className="text-sm text-muted-foreground">২৪ ঘণ্টার বাইরে Messenger-এ শুধু অনুমোদিত UTILITY টেমপ্লেট যায়: পেমেন্ট বা অ্যাকাউন্টের অবস্থা, কোনো প্রচার নয়। নতুন প্রস্তাবের খবর ইচ্ছাকৃতভাবে এখানে নেই। খালি থাকলে মেসেজ যায় না।</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {["match_update", "payment_reminder", "contact_release"].map((k) => (
              <label key={k} className="flex flex-col gap-1 text-sm">{k}<Input name={`mtemplate_${k}`} defaultValue={mtemplates[k] ?? ""} dir="ltr" /></label>
            ))}
          </div>
          <h2 className="mt-2 font-medium">WhatsApp টেমপ্লেটের নাম</h2>
          <p className="text-sm text-muted-foreground">২৪ ঘণ্টার বাইরে শুধু অনুমোদিত টেমপ্লেট পাঠানো যায়। খালি থাকলে বার্তা বাদ পড়বে; ব্যবহারকারী ফিরে এলে BS জানাবে।</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.keys({ match_intro: 1, match_update: 1, payment_reminder: 1, contact_release: 1 }).map((k) => (
              <label key={k} className="flex flex-col gap-1 text-sm">{k}<Input name={`template_${k}`} defaultValue={templates[k] ?? ""} dir="ltr" /></label>
            ))}
            <label className="flex flex-col gap-1 text-sm">ভাষা কোড<Input name="template_language" defaultValue={lang} dir="ltr" /></label>
          </div>
          <Button className="self-start">সংরক্ষণ</Button>
        </Card>
      </form>
      <form action={saveMessagesAction}>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">BS-এর নির্দেশনা</h2>
          <Textarea name="system_prompt" defaultValue={prompt} rows={14} aria-label="সিস্টেম প্রম্পট" required />
          <h2 className="mt-2 font-medium">স্বয়ংক্রিয় বার্তা</h2>
          <p className="text-sm text-muted-foreground">{"{amount}"} ধরনের অংশ সিস্টেম পূরণ করে; এগুলো রাখুন।</p>
          {Object.entries(merged).map(([k, v]) => (
            <label key={k} className="flex flex-col gap-1 text-sm">{k}<Textarea name={`msg_${k}`} defaultValue={v} rows={3} /></label>
          ))}
          <Button className="self-start">সংরক্ষণ</Button>
        </Card>
      </form>
    </>
  );
}
