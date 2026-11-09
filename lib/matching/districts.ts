const DIVISIONS: Record<string, { bn: string; districts: [string, string][] }> = {
  dhaka: { bn: "ঢাকা", districts: [["dhaka","ঢাকা"],["gazipur","গাজীপুর"],["narayanganj","নারায়ণগঞ্জ"],["narsingdi","নরসিংদী"],["manikganj","মানিকগঞ্জ"],["munshiganj","মুন্সিগঞ্জ"],["tangail","টাঙ্গাইল"],["kishoreganj","কিশোরগঞ্জ"],["faridpur","ফরিদপুর"],["gopalganj","গোপালগঞ্জ"],["madaripur","মাদারীপুর"],["rajbari","রাজবাড়ী"],["shariatpur","শরীয়তপুর"]] },
  chattogram: { bn: "চট্টগ্রাম", districts: [["chattogram","চট্টগ্রাম"],["coxs_bazar","কক্সবাজার"],["cumilla","কুমিল্লা"],["brahmanbaria","ব্রাহ্মণবাড়িয়া"],["chandpur","চাঁদপুর"],["feni","ফেনী"],["lakshmipur","লক্ষ্মীপুর"],["noakhali","নোয়াখালী"],["khagrachhari","খাগড়াছড়ি"],["rangamati","রাঙ্গামাটি"],["bandarban","বান্দরবান"]] },
  rajshahi: { bn: "রাজশাহী", districts: [["rajshahi","রাজশাহী"],["natore","নাটোর"],["naogaon","নওগাঁ"],["chapainawabganj","চাঁপাইনবাবগঞ্জ"],["pabna","পাবনা"],["sirajganj","সিরাজগঞ্জ"],["bogura","বগুড়া"],["joypurhat","জয়পুরহাট"]] },
  khulna: { bn: "খুলনা", districts: [["khulna","খুলনা"],["bagerhat","বাগেরহাট"],["satkhira","সাতক্ষীরা"],["jashore","যশোর"],["jhenaidah","ঝিনাইদহ"],["magura","মাগুরা"],["narail","নড়াইল"],["kushtia","কুষ্টিয়া"],["chuadanga","চুয়াডাঙ্গা"],["meherpur","মেহেরপুর"]] },
  barishal: { bn: "বরিশাল", districts: [["barishal","বরিশাল"],["bhola","ভোলা"],["patuakhali","পটুয়াখালী"],["pirojpur","পিরোজপুর"],["jhalokathi","ঝালকাঠি"],["barguna","বরগুনা"]] },
  sylhet: { bn: "সিলেট", districts: [["sylhet","সিলেট"],["moulvibazar","মৌলভীবাজার"],["habiganj","হবিগঞ্জ"],["sunamganj","সুনামগঞ্জ"]] },
  rangpur: { bn: "রংপুর", districts: [["rangpur","রংপুর"],["dinajpur","দিনাজপুর"],["thakurgaon","ঠাকুরগাঁও"],["panchagarh","পঞ্চগড়"],["nilphamari","নীলফামারী"],["lalmonirhat","লালমনিরহাট"],["kurigram","কুড়িগ্রাম"],["gaibandha","গাইবান্ধা"]] },
  mymensingh: { bn: "ময়মনসিংহ", districts: [["mymensingh","ময়মনসিংহ"],["jamalpur","জামালপুর"],["netrokona","নেত্রকোণা"],["sherpur","শেরপুর"]] },
};

const byAlias = new Map<string, string>();
const divisionOf = new Map<string, string>();
const bnName = new Map<string, string>();
for (const [division, { districts }] of Object.entries(DIVISIONS)) {
  for (const [slug, bn] of districts) {
    byAlias.set(slug, slug);
    byAlias.set(bn, slug);
    divisionOf.set(slug, division);
    bnName.set(slug, bn);
  }
}
for (const [alias, slug] of Object.entries({ chittagong: "chattogram", comilla: "cumilla", barisal: "barishal", bogra: "bogura", jessore: "jashore" })) {
  byAlias.set(alias, slug);
}

export const allDistricts = () => [...bnName.entries()].map(([slug, bn]) => ({ slug, bn }));

export function normalizeDistrict(input: string): string | null {
  return byAlias.get(input.trim().toLowerCase().replace(/\s+জেলা$/, "").replace(/[\s'-]+/g, "_")) ?? null;
}

/** Accepts a district, a division ("ঢাকা বিভাগ", "div:dhaka") or "any"/"যেকোনো". */
export function normalizeLocation(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v === "any" || v === "যেকোনো" || v === "যে কোনো") return "any";
  if (v.startsWith("div:") && DIVISIONS[v.slice(4)]) return v;
  const div = v.replace(/\s*(বিভাগ|division)$/, "");
  if (div !== v) {
    for (const [slug, d] of Object.entries(DIVISIONS)) if (slug === div || d.bn === div) return `div:${slug}`;
  }
  return normalizeDistrict(v);
}

export const districtDivision = (slug: string) => divisionOf.get(slug) ?? null;
export const districtLabel = (slug: string) => bnName.get(slug) ?? slug;
