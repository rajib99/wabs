import { asc } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { requireRole } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { createQuestionAction, deleteQuestionAction, moveQuestionAction, updateQuestionAction } from "../actions";

export const dynamic = "force-dynamic";

const TYPES = ["text", "number", "select", "multiselect", "range", "district", "location_list"];
const json = (v: unknown) => (v == null ? "" : JSON.stringify(v));

function Fields({ q }: { q?: typeof schema.questions.$inferSelect }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">প্রশ্ন (বাংলা)<Textarea name="bengali_text" defaultValue={q?.bengaliText} rows={2} required /></label>
      <label className="flex flex-col gap-1 text-sm">ধরন<Select name="field_type" defaultValue={q?.fieldType ?? "text"}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></label>
      <label className="flex flex-col gap-1 text-sm">Options (JSON)<Textarea name="options" defaultValue={json(q?.options)} rows={2} className="font-mono" dir="ltr" /></label>
      <label className="flex flex-col gap-1 text-sm">শর্ত (JSON, যেমন {'{"field":"gender","op":"eq","value":"female"}'})<Textarea name="ask_condition" defaultValue={json(q?.askCondition)} rows={2} className="font-mono" dir="ltr" /></label>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="required" defaultChecked={q?.required ?? true} />আবশ্যক</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={q?.active ?? true} />সক্রিয়</label>
      </div>
    </>
  );
}

export default async function QuestionsPage() {
  await requireRole("owner");
  const rows = await db().select().from(schema.questions).orderBy(asc(schema.questions.order));
  return (
    <>
      <PageTitle>প্রশ্ন ব্যাংক</PageTitle>
      <div className="flex flex-col gap-2">
        {rows.map((q) => (
          <Card key={q.key} className="p-3">
            <div className="flex items-start gap-2">
              <div className="flex flex-col gap-1">
                <form action={moveQuestionAction}>
                  <input type="hidden" name="key" value={q.key} /><input type="hidden" name="direction" value="up" />
                  <Button variant="outline" aria-label={`${q.key} উপরে`}>↑</Button>
                </form>
                <form action={moveQuestionAction}>
                  <input type="hidden" name="key" value={q.key} /><input type="hidden" name="direction" value="down" />
                  <Button variant="outline" aria-label={`${q.key} নিচে`}>↓</Button>
                </form>
              </div>
              <details className="min-w-0 flex-1">
                <summary className="cursor-pointer">
                  <span>{q.bengaliText}</span>
                  <span className="mt-1 flex flex-wrap gap-1"><Badge>{q.key}</Badge><Badge>{q.fieldType}</Badge>{q.required && <Badge>আবশ্যক</Badge>}{!q.active && <Badge>নিষ্ক্রিয়</Badge>}{q.askCondition != null && <Badge>শর্তসাপেক্ষ</Badge>}</span>
                </summary>
                <form action={updateQuestionAction} className="mt-3 flex flex-col gap-2">
                  <input type="hidden" name="key" value={q.key} />
                  <Fields q={q} />
                  <Button className="self-start">সংরক্ষণ</Button>
                </form>
                <form action={deleteQuestionAction} className="mt-2">
                  <input type="hidden" name="key" value={q.key} />
                  <Button variant="destructive">মুছুন</Button>
                </form>
              </details>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <h2 className="mb-2 font-medium">নতুন প্রশ্ন</h2>
        <form action={createQuestionAction} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">Key (ইংরেজি, যেমন spouse_job_type)<Input name="key" pattern="[a-z][a-z0-9_]*" required dir="ltr" /></label>
          <Fields />
          <Button className="self-start">যোগ করুন</Button>
        </form>
      </Card>
    </>
  );
}
