import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { conditionMet, getNextQuestion, isProfileComplete, loadAnswers, loadQuestions, pendingQuestions, saveAnswer, savePreference, validateAnswer } from "@/lib/profile";
import { eq } from "drizzle-orm";

const P = "+8801711000100";
const user = () => db().insert(schema.users).values({ phone: P, status: "active" });
const save = (questionKey: string, value: unknown, confidence = 0.95, source: "asked" | "volunteered" | "inferred" = "asked") =>
  saveAnswer({ phone: P, questionKey, value, source, confidence });

describe("validation", () => {
  it("normalizes each type", () => {
    expect(validateAnswer({ key: "age", fieldType: "number", options: { min: 18, max: 80 } }, "২৭")).toEqual({ ok: true, value: 27 });
    expect(validateAnswer({ key: "age", fieldType: "number", options: { min: 18, max: 80 } }, 12).ok).toBe(false);
    expect(validateAnswer({ key: "h", fieldType: "number", options: { min: 120, max: 220, unit: "cm" } }, "৫ ফুট ৬ ইঞ্চি")).toEqual({ ok: true, value: 168 });
    expect(validateAnswer({ key: "x", fieldType: "range", options: null }, "২৫ থেকে ৩০")).toEqual({ ok: true, value: { min: 25, max: 30 } });
    expect(validateAnswer({ key: "x", fieldType: "range", options: null }, [30, 25])).toEqual({ ok: true, value: { min: 25, max: 30 } });
    expect(validateAnswer({ key: "d", fieldType: "district", options: null }, "কুমিল্লা")).toEqual({ ok: true, value: "cumilla" });
    expect(validateAnswer({ key: "d", fieldType: "district", options: null }, "Mars").ok).toBe(false);
    expect(validateAnswer({ key: "l", fieldType: "location_list", options: null }, ["ঢাকা বিভাগ", "সিলেট"])).toEqual({ ok: true, value: ["div:dhaka", "sylhet"] });
    const options = [{ value: "govt", label: "সরকারি" }];
    expect(validateAnswer({ key: "j", fieldType: "select", options }, "সরকারি")).toEqual({ ok: true, value: "govt" });
    expect(validateAnswer({ key: "j", fieldType: "select", options }, "pilot").ok).toBe(false);
  });
});

describe("ask conditions", () => {
  it("evaluates rule shapes", () => {
    expect(conditionMet(null, {})).toBe(true);
    expect(conditionMet({ field: "gender", value: "female" }, { gender: "female" })).toBe(true);
    expect(conditionMet({ field: "gender", value: "female" }, { gender: "male" })).toBe(false);
    expect(conditionMet({ field: "gender", value: "female" }, {})).toBe(false);
    expect(conditionMet({ all: [{ field: "a", op: "exists" }, { field: "b", op: "neq", value: 1 }] }, { a: 1, b: 2 })).toBe(true);
    expect(conditionMet({ any: [{ field: "a", op: "in", value: [1, 2] }] }, { a: 3 })).toBe(false);
  });
  it("hides a conditional question until its condition holds", async () => {
    await user();
    await db().insert(schema.questions).values({ key: "spouse_job_type", bengaliText: "x", fieldType: "text", order: 1, askCondition: { field: "gender", op: "eq", value: "female" } });
    expect((await getNextQuestion(P))!.key).toBe("name");
    await save("gender", "female");
    expect((await getNextQuestion(P))!.key).toBe("spouse_job_type");
  });
});

describe("question engine", () => {
  it("asks by priority, skipping confident answers", async () => {
    await user();
    expect((await getNextQuestion(P))!.key).toBe("name");
    await save("name", "রহিম");
    expect((await getNextQuestion(P))!.key).toBe("age");
  });
  it("re-asks a low-confidence answer only until it has been confirmed once", async () => {
    await user();
    await save("name", "রহিম", 0.5);
    expect((await getNextQuestion(P))!.key).toBe("name");
    await db().update(schema.profileAnswers).set({ confirmAskedAt: new Date() }).where(eq(schema.profileAnswers.phone, P));
    expect((await getNextQuestion(P))!.key).toBe("age");
  });
  it("inference never overwrites a more certain stated answer", async () => {
    await user();
    await save("district", "ঢাকা", 0.95);
    expect(await save("district", "সিলেট", 0.7, "inferred")).toMatchObject({ ok: true, stored: false });
    expect((await loadAnswers(P))[0]!.value).toBe("dhaka");
    expect(await save("district", "সিলেট", 0.95, "volunteered")).toMatchObject({ ok: true, stored: true, profileChanged: true });
  });
  it("completes exactly once, when all required keys are answered, ignoring optional ones", async () => {
    await user();
    const questions = await loadQuestions();
    const required = questions.filter((q) => q.required);
    const values: Record<string, unknown> = {
      name: "ক", age: 25, gender: "male", created_by_relation: "self", religion: "muslim", marital_status: "never_married", district: "ঢাকা", current_location: "ঢাকা",
      education: "bachelor", profession: "শিক্ষক", job_type: "govt", family_details: "ভালো", preferred_age_range: [20, 25], preferred_education: ["any"], preferred_job_type: ["any"], preferred_location: ["any"],
    };
    const completions = [];
    for (const q of required) completions.push(await save(q.key, values[q.key]));
    expect(completions.filter((c) => c.ok && c.profileCompleted)).toHaveLength(1);
    expect(completions.at(-1)).toMatchObject({ profileCompleted: true });
    expect(isProfileComplete(questions, await loadAnswers(P))).toBe(true);
    expect(pendingQuestions(questions, await loadAnswers(P)).map((q) => q.key)).toEqual(["income_range", "height_cm"]);
  });
  it("mirrors key answers on the users row and rejects unknown keys", async () => {
    await user();
    await save("gender", "মহিলা");
    const [u] = await db().select().from(schema.users).where(eq(schema.users.phone, P));
    expect(u!.gender).toBe("female");
    expect(await save("is_verified", true)).toMatchObject({ ok: false });
  });
});

describe("preferences", () => {
  it("normalizes values and rejects unfit operators", async () => {
    await user();
    expect(await savePreference({ phone: P, field: "job_type", operator: "in", value: ["সরকারি", "semi_govt"], isDealbreaker: true })).toEqual({ ok: true });
    const [p] = await db().select().from(schema.preferences);
    expect(p!.value).toEqual(["govt", "semi_govt"]);
    expect((await savePreference({ phone: P, field: "job_type", operator: "gte", value: 5, isDealbreaker: true })).ok).toBe(false);
    expect((await savePreference({ phone: P, field: "phone", operator: "eq", value: "x", isDealbreaker: true })).ok).toBe(false);
    expect((await savePreference({ phone: P, field: "age", operator: "between", value: [25, 30], isDealbreaker: true })).ok).toBe(true);
  });
});
