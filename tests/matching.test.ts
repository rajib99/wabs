import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { findMatches, hardFilteredCandidates } from "@/lib/matching/find";
import { setSetting } from "@/lib/settings";
import { makeMatch, makeUser } from "./helpers";

const M = "+8801711000001";
const F = "+8801711000002";
const dealbreaker = (phone: string, field: string, operator: string, value: unknown) =>
  db().insert(schema.preferences).values({ phone, field, operator, value, isDealbreaker: true });

describe("findMatches", () => {
  it("proposes a good opposite-gender pair with a stored breakdown", async () => {
    await makeUser(M, "male"); await makeUser(F, "female");
    const created = await findMatches(M);
    expect(created).toHaveLength(1);
    const [row] = await db().select().from(schema.matches);
    expect(row).toMatchObject({ userA: M, userB: F, state: "proposed" });
    expect((row!.breakdown as unknown[]).length).toBe(6);
    expect(row!.score).toBe(100);
  });

  it("never matches the same gender", async () => {
    await makeUser(M, "male"); await makeUser("+8801711000003", "male");
    expect(await findMatches(M)).toHaveLength(0);
  });

  it("dealbreaker overrides a perfect score: her requirement excludes private job holders", async () => {
    await makeUser(M, "male", { job_type: "private" }); await makeUser(F, "female");
    await dealbreaker(F, "job_type", "in", ["govt", "semi_govt"]);
    expect(await findMatches(M)).toHaveLength(0); // the other side's dealbreaker applies too
    expect(await findMatches(F)).toHaveLength(0); // and from her side
  });

  it("dealbreaker satisfied allows the match", async () => {
    await makeUser(M, "male", { job_type: "semi_govt" }); await makeUser(F, "female");
    await dealbreaker(F, "job_type", "in", ["govt", "semi_govt"]);
    expect(await findMatches(M)).toHaveLength(1);
  });

  it("a dealbreaker on an unanswered field excludes the candidate", async () => {
    await makeUser(M, "male"); await makeUser(F, "female");
    await dealbreaker(M, "height_cm", "gte", 150);
    expect(await hardFilteredCandidates(M, "male")).toHaveLength(0);
  });

  it("numeric between dealbreakers work", async () => {
    await makeUser(M, "male", { age: 40 }); await makeUser(F, "female");
    await dealbreaker(F, "age", "between", [25, 30]);
    expect(await findMatches(F)).toHaveLength(0);
  });

  it("threshold binds: exactly at threshold passes, just above threshold fails", async () => {
    await makeUser(M, "male"); await makeUser(F, "female", { religion: "hindu" }); // loses religion weight 20 → 80
    await setSetting("match_threshold", 80.1);
    expect(await findMatches(M)).toHaveLength(0);
    await setSetting("match_threshold", 80);
    expect(await findMatches(M)).toHaveLength(1);
  });

  it("excludes blocked, inactive and incomplete candidates and existing pairs", async () => {
    await makeUser(M, "male");
    await makeUser("+8801711000010", "female", {}, { blocked: true });
    await makeUser("+8801711000011", "female", {}, { status: "awaiting_consent" });
    await makeUser("+8801711000012", "female", {}, { profileComplete: false });
    await makeUser("+8801711000013", "female");
    await makeMatch("+8801711000013", M, "declined");
    expect(await hardFilteredCandidates(M, "male")).toHaveLength(0);
  });

  it("enforces the daily introduction limit for both users", async () => {
    await setSetting("daily_intro_limit", 2);
    await makeUser(M, "male");
    for (let i = 0; i < 4; i++) await makeUser(`+880171100002${i}`, "female");
    expect(await findMatches(M)).toHaveLength(2);
    expect(await findMatches(M)).toHaveLength(0);
    // A second man can only get the women the first has not used up.
    await makeUser("+8801711000030", "male");
    expect((await findMatches("+8801711000030")).length).toBe(2);
  });

  it("applies the legal minimum marriage age by gender", async () => {
    await makeUser(M, "male", { age: 20 }); await makeUser(F, "female", { age: 18 });
    expect(await findMatches(M)).toHaveLength(0);
    expect(await findMatches(F)).toHaveLength(0);
    await db().update(schema.profileAnswers).set({ value: 21 }).where(and(eq(schema.profileAnswers.phone, M), eq(schema.profileAnswers.questionKey, "age")));
    expect(await findMatches(M)).toHaveLength(1);
  });

  it("does nothing for blocked or incomplete seekers", async () => {
    await makeUser(M, "male", {}, { blocked: true }); await makeUser(F, "female");
    expect(await findMatches(M)).toHaveLength(0);
  });
});
