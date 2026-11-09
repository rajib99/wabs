import { describe, expect, it } from "vitest";
import { fieldFit, meetsThreshold, scorePair, type FieldRule } from "@/lib/matching/score";

describe("field rules", () => {
  const range: FieldRule = { field: "age", preference: "pref_age", rule: "range", weight: 1, tolerance: 3 };
  it("range: inside is 1, within tolerance declines, beyond is 0", () => {
    expect(fieldFit(range, { pref_age: { min: 25, max: 30 } }, { age: 30 })).toBe(1);
    expect(fieldFit(range, { pref_age: { min: 25, max: 30 } }, { age: 31 })).toBeCloseTo(2 / 3);
    expect(fieldFit(range, { pref_age: { min: 25, max: 30 } }, { age: 33 })).toBe(0);
  });
  const list: FieldRule = { field: "job_type", preference: "pref", rule: "list_overlap", weight: 1 };
  it("list overlap honours any and missing preference", () => {
    expect(fieldFit(list, { pref: ["govt"] }, { job_type: "govt" })).toBe(1);
    expect(fieldFit(list, { pref: ["govt"] }, { job_type: "private" })).toBe(0);
    expect(fieldFit(list, { pref: ["any"] }, { job_type: "private" })).toBe(1);
    expect(fieldFit(list, {}, { job_type: "private" })).toBe(1);
  });
  const dist: FieldRule = { field: "district", preference: "pref", rule: "district_distance", weight: 1 };
  it("district distance: same district, division, same-division neighbour, far", () => {
    expect(fieldFit(dist, { pref: ["dhaka"] }, { district: "dhaka" })).toBe(1);
    expect(fieldFit(dist, { pref: ["div:dhaka"] }, { district: "gazipur" })).toBe(1);
    expect(fieldFit(dist, { pref: ["dhaka"] }, { district: "gazipur" })).toBe(0.6);
    expect(fieldFit(dist, { pref: ["dhaka"] }, { district: "sylhet" })).toBe(0);
  });
  it("exact requires both present", () => {
    const r: FieldRule = { field: "religion", rule: "exact", weight: 1 };
    expect(fieldFit(r, { religion: "muslim" }, { religion: "muslim" })).toBe(1);
    expect(fieldFit(r, { religion: "muslim" }, {})).toBe(0);
  });
});

describe("scorePair", () => {
  const rules: FieldRule[] = [
    { field: "religion", rule: "exact", weight: 70 },
    { field: "marital_status", rule: "exact", weight: 30 },
  ];
  it("averages both directions and returns a breakdown", () => {
    const { score, breakdown } = scorePair([{ field: "j", preference: "p", rule: "list_overlap", weight: 100 }], { p: ["x"], j: "x" }, { p: ["x"], j: "y" });
    expect(score).toBe(50);
    expect(breakdown[0]).toMatchObject({ a_to_b: 0, b_to_a: 1, points: 50 });
  });
  it("threshold edges: 70 passes at 70, 69.9 does not", () => {
    const { score } = scorePair(rules, { religion: "m", marital_status: "a" }, { religion: "m", marital_status: "b" });
    expect(score).toBe(70);
    expect(meetsThreshold(score, 70)).toBe(true);
    expect(meetsThreshold(69.9, 70)).toBe(false);
    expect(meetsThreshold(70.1, 70)).toBe(true);
  });
  it("zero weights score 0", () => expect(scorePair([], {}, {}).score).toBe(0));
});
