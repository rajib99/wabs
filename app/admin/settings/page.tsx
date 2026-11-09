import { Button } from "@/components/ui/button";
import { Card, PageTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import type { FieldRule } from "@/lib/matching/score";
import { getSetting } from "@/lib/settings";
import { saveMatchingSettingsAction } from "../actions";
import { ThresholdSlider } from "./threshold";

export const dynamic = "force-dynamic";

const hours = (s: number) => Math.round((s / 3600) * 1000) / 1000;

export default async function SettingsPage() {
  await requireRole("owner");
  const [threshold, limit, weights, resp, first, second, minAge] = await Promise.all([
    getSetting<number>("match_threshold"), getSetting<number>("daily_intro_limit"), getSetting<FieldRule[]>("match_weights"),
    getSetting<number>("match_response_timeout_seconds"), getSetting<number>("first_payment_timeout_seconds"), getSetting<number>("second_payment_timeout_seconds"),
    getSetting<{ male: number; female: number }>("min_match_age"),
  ]);
  const num = (name: string, label: string, value: number, step = "1") => (
    <label className="flex flex-col gap-1 text-sm">{label}<Input type="number" name={name} defaultValue={value} step={step} min="0" required /></label>
  );
  return (
    <>
      <PageTitle>ম্যাচিং সেটিংস</PageTitle>
      <form action={saveMatchingSettingsAction} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <ThresholdSlider initial={threshold} />
          {num("daily_intro_limit", "প্রতিদিন একজনের জন্য সর্বোচ্চ নতুন প্রস্তাব", limit)}
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">ক্ষেত্রের ওজন</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {weights.map((w) => <div key={w.field}>{num(`weight_${w.field}`, `${w.field} (${w.rule})`, w.weight, "any")}</div>)}
          </div>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">সময়সীমা (ঘণ্টা)</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {num("match_response_hours", "প্রস্তাবে সাড়া দেওয়ার সময়", hours(resp), "any")}
            {num("first_payment_hours", "প্রথম পেমেন্টের সময়", hours(first), "any")}
            {num("second_payment_hours", "দ্বিতীয় পেমেন্টের সময়", hours(second), "any")}
          </div>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">ম্যাচের ন্যূনতম বয়স</h2>
          <p className="text-sm text-muted-foreground">বাল্যবিবাহ নিরোধ আইন ২০১৭ অনুযায়ী পুরুষ ২১, নারী ১৮। আইনি পরামর্শ ছাড়া কমাবেন না।</p>
          <div className="grid grid-cols-2 gap-3">
            {num("min_age_male", "পুরুষ", minAge.male)}
            {num("min_age_female", "নারী", minAge.female)}
          </div>
        </Card>
        <Button className="self-start">সংরক্ষণ</Button>
      </form>
    </>
  );
}
