const opt = (value: string, label: string) => ({ value, label });

const JOB = [opt("govt", "সরকারি"), opt("semi_govt", "আধা-সরকারি"), opt("private", "বেসরকারি"), opt("business", "ব্যবসা"), opt("unemployed", "বেকার"), opt("other", "অন্যান্য")];
const EDU = [opt("ssc", "এসএসসি"), opt("hsc", "এইচএসসি"), opt("diploma", "ডিপ্লোমা"), opt("bachelor", "স্নাতক"), opt("masters", "স্নাতকোত্তর"), opt("phd", "পিএইচডি"), opt("other", "অন্যান্য")];
const ANY = opt("any", "যেকোনো");

export const QUESTION_SEED = [
  { key: "name", bengaliText: "পাত্র/পাত্রীর নাম কী?", fieldType: "text" },
  { key: "age", bengaliText: "পাত্র/পাত্রীর বয়স কত?", fieldType: "number", options: { min: 18, max: 80 } },
  { key: "gender", bengaliText: "প্রোফাইলটি কার: পাত্রের (পুরুষ), নাকি পাত্রীর (মহিলা)?", fieldType: "select", options: [opt("male", "পুরুষ"), opt("female", "মহিলা")] },
  { key: "religion", bengaliText: "ধর্ম কী?", fieldType: "select", options: [opt("muslim", "ইসলাম"), opt("hindu", "হিন্দু"), opt("christian", "খ্রিস্টান"), opt("buddhist", "বৌদ্ধ"), opt("other", "অন্যান্য")] },
  { key: "marital_status", bengaliText: "বৈবাহিক অবস্থা কী: অবিবাহিত, তালাকপ্রাপ্ত, নাকি বিধবা/বিপত্নীক?", fieldType: "select", options: [opt("never_married", "অবিবাহিত"), opt("divorced", "তালাকপ্রাপ্ত"), opt("widowed", "বিধবা/বিপত্নীক")] },
  { key: "district", bengaliText: "নিজের জেলা কোনটি?", fieldType: "district" },
  { key: "current_location", bengaliText: "এখন কোথায় থাকেন?", fieldType: "text" },
  { key: "education", bengaliText: "সর্বোচ্চ শিক্ষাগত যোগ্যতা কী?", fieldType: "select", options: EDU },
  { key: "profession", bengaliText: "পেশা কী?", fieldType: "text" },
  { key: "job_type", bengaliText: "চাকরির ধরন কী: সরকারি, আধা-সরকারি, বেসরকারি, ব্যবসা, বেকার, নাকি অন্য?", fieldType: "select", options: JOB },
  // Male candidates only: the profession in detail, by job type.
  { key: "business_details", bengaliText: "ব্যবসার বিস্তারিত বলুন: কী ধরনের ব্যবসা, কোথায়, আর ব্যবসায় পাত্রের পদ বা ভূমিকা কী?", fieldType: "text", askCondition: {all: [{field: "gender", op: "eq", value: "male"}, {field: "job_type", op: "in", value: ["business"]}]} },
  { key: "job_details", bengaliText: "চাকরির বিস্তারিত বলুন: কোন প্রতিষ্ঠানে, কী পদে, অফিস কোথায়, আর আসলে কী কাজ করেন?", fieldType: "text", askCondition: {all: [{field: "gender", op: "eq", value: "male"}, {field: "job_type", op: "in", value: ["govt", "semi_govt", "private"]}]} },
  { key: "income_range", bengaliText: "মাসিক আয় আনুমানিক কত? (২০ হাজারের কম, ২০-৪০ হাজার, ৪০-৮০ হাজার, ৮০ হাজারের বেশি, আয় নেই)", fieldType: "select", required: false, options: [opt("none", "আয় নেই"), opt("below_20k", "২০ হাজারের কম"), opt("20k_40k", "২০-৪০ হাজার"), opt("40k_80k", "৪০-৮০ হাজার"), opt("above_80k", "৮০ হাজারের বেশি")] },
  { key: "height_cm", bengaliText: "উচ্চতা কত? (যেমন ৫ ফুট ৬ ইঞ্চি)", fieldType: "number", required: false, options: { min: 120, max: 220, unit: "cm" } },
  // Asked of both bride and groom. Stored for the agent and admins; not used in scoring.
  { key: "skin_color", bengaliText: "পাত্র/পাত্রীর গায়ের রং কেমন: উজ্জ্বল ফর্সা, ফর্সা, উজ্জ্বল শ্যামলা, শ্যামলা, নাকি কালো?", fieldType: "select", options: [opt("very_fair", "উজ্জ্বল ফর্সা"), opt("fair", "ফর্সা"), opt("bright_wheatish", "উজ্জ্বল শ্যামলা"), opt("wheatish", "শ্যামলা"), opt("dark", "কালো")] },
  { key: "beauty_rating", bengaliText: "দেখতে কেমন, ১ থেকে ১০-এর মধ্যে নিজে একটি নম্বর দিন (১০ = খুব সুন্দর)।", fieldType: "number", options: { min: 1, max: 10 } },
  { key: "family_details", bengaliText: "পরিবার সম্পর্কে একটু বলুন (বাবা-মা, ভাই-বোন, পারিবারিক অবস্থা)।", fieldType: "text" },
  { key: "preferred_age_range", bengaliText: "কেমন বয়সের পাত্র/পাত্রী চান? (যেমন ২৫ থেকে ৩০)", fieldType: "range" },
  { key: "preferred_education", bengaliText: "পাত্র/পাত্রীর শিক্ষাগত যোগ্যতা কেমন হলে ভালো হয়?", fieldType: "multiselect", options: [...EDU, ANY] },
  { key: "preferred_job_type", bengaliText: "পাত্র/পাত্রীর চাকরির ধরন কেমন পছন্দ?", fieldType: "multiselect", options: [...JOB, ANY] },
  { key: "preferred_location", bengaliText: "কোন জেলা বা বিভাগের পাত্র/পাত্রী পছন্দ? যেকোনো হলেও বলুন।", fieldType: "location_list" },
  // Stored for the agent and admins; not used in scoring (there is no matching self-description to compare with).
  { key: "preferred_looks", bengaliText: "পাত্র/পাত্রী দেখতে কেমন হলে বিবেচনা করবেন: খুব সুন্দর, সুন্দর, মোটামুটি, নাকি এটা ব্যাপার না?", fieldType: "select", options: [opt("very_beautiful", "খুব সুন্দর"), opt("beautiful", "সুন্দর"), opt("average", "মোটামুটি"), opt("any", "ব্যাপার না")] },
  // The last question: their own words, for the agent and admins.
  { key: "partner_expectation", bengaliText: "শেষ প্রশ্ন: আসলে কেমন জীবনসঙ্গী হলে আপনি বিবেচনা করবেন? নিজের ভাষায় একটু বলুন।", fieldType: "text" },
].map((q, i) => ({ required: true, options: null as unknown, askCondition: null as unknown, ...q, order: (i + 1) * 10, active: true }));
