import { districtDivision } from "./districts";

export type FieldRule = {
  field: string;
  preference?: string;
  rule: "exact" | "range" | "list_overlap" | "district_distance";
  weight: number;
  tolerance?: number;
};

export type Answers = Record<string, unknown>;
export type BreakdownEntry = { field: string; weight: number; a_to_b: number; b_to_a: number; points: number };

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** How well `candidate` fits what `seeker` wants on one field, from 0 to 1. No stated preference counts as a full fit. */
export function fieldFit(rule: FieldRule, seeker: Answers, candidate: Answers): number {
  const have = candidate[rule.field];
  const want = rule.preference ? seeker[rule.preference] : seeker[rule.field];
  if (rule.rule === "exact") {
    return want != null && have != null && String(want) === String(have) ? 1 : 0;
  }
  if (want == null) return rule.rule === "district_distance" ? districtFit([String(seeker[rule.field] ?? "")], have) : 1;
  if (have == null) return 0;
  switch (rule.rule) {
    case "range": {
      const { min, max } = want as { min: number; max: number };
      const n = Number(have);
      if (n >= min && n <= max) return 1;
      const tolerance = rule.tolerance ?? 0;
      const gap = n < min ? min - n : n - max;
      return tolerance > 0 && gap < tolerance ? 1 - gap / tolerance : 0;
    }
    case "list_overlap": {
      const list = asList(want);
      return list.includes("any") || list.length === 0 || asList(have).some((h) => list.includes(h)) ? 1 : 0;
    }
    case "district_distance":
      return districtFit(asList(want), have);
  }
}

function districtFit(wanted: string[], have: unknown): number {
  const district = String(have ?? "");
  const division = districtDivision(district);
  if (wanted.includes("any") || wanted.length === 0) return 1;
  if (wanted.includes(district) || (division && wanted.includes(`div:${division}`))) return 1;
  // Same division as a wanted district is close, not identical.
  return division && wanted.some((w) => districtDivision(w) === division) ? 0.6 : 0;
}

/** Weighted two-way score from 0 to 100, with the per-field breakdown stored on the match. */
export function scorePair(rules: FieldRule[], a: Answers, b: Answers): { score: number; breakdown: BreakdownEntry[] } {
  const totalWeight = rules.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight <= 0) return { score: 0, breakdown: [] };
  let earned = 0;
  const breakdown = rules.map((r) => {
    const a_to_b = fieldFit(r, a, b);
    const b_to_a = fieldFit(r, b, a);
    const points = (r.weight * (a_to_b + b_to_a)) / 2;
    earned += points;
    return { field: r.field, weight: r.weight, a_to_b, b_to_a, points };
  });
  return { score: Math.round((1000 * earned) / totalWeight) / 10, breakdown };
}

export const meetsThreshold = (score: number, threshold: number) => score >= threshold;
