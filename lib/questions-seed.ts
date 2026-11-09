const opt = (value: string, label: string) => ({ value, label });

const JOB = [opt("govt", "সরকারি"), opt("semi_govt", "আধা-সরকারি"), opt("private", "বেসরকারি"), opt("business", "ব্যবসা"), opt("other", "অন্যান্য")];
const EDU = [opt("ssc", "এসএসসি"), opt("hsc", "এইচএসসি"), opt("diploma", "ডিপ্লোমা"), opt("bachelor", "স্নাতক"), opt("masters", "স্নাতকোত্তর"), opt("phd", "পিএইচডি"), opt("other", "অন্যান্য")];
const ANY = opt("any", "যেকোনো");

export const QUESTION_SEED = [
  { key: "name", bengaliText: "পাত্র/পাত্রীর নাম কী?", fieldType: "text" },
  { key: "age", bengaliText: "পাত্র/পাত্রীর বয়স কত?", fieldType: "number", options: { min: 18, max: 80 } },
  { key: "gender", bengaliText: "প্রোফাইলটি কার: পাত্রের (পুরুষ), নাকি পাত্রীর (মহিলা)?", fieldType: "select", options: [opt("male", "পুরুষ"), opt("female", "মহিলা")] },
  { key: "created_by_relation", bengaliText: "প্রোফাইলটি কার জন্য: নিজের, সন্তানের, ভাই-বোনের, নাকি অন্য কারও?", fieldType: "select", options: [opt("self", "নিজের"), opt("parent", "সন্তানের (আমি অভিভাবক)"), opt("sibling", "ভাই-বোনের"), opt("other", "অন্য")] },
  { key: "religion", bengaliText: "ধর্ম কী?", fieldType: "select", options: [opt("muslim", "ইসলাম"), opt("hindu", "হিন্দু"), opt("christian", "খ্রিস্টান"), opt("buddhist", "বৌদ্ধ"), opt("other", "অন্যান্য")] },
  { key: "marital_status", bengaliText: "বৈবাহিক অবস্থা কী: অবিবাহিত, তালাকপ্রাপ্ত, নাকি বিধবা/বিপত্নীক?", fieldType: "select", options: [opt("never_married", "অবিবাহিত"), opt("divorced", "তালাকপ্রাপ্ত"), opt("widowed", "বিধবা/বিপত্নীক")] },
  { key: "district", bengaliText: "নিজের জেলা কোনটি?", fieldType: "district" },
  { key: "current_location", bengaliText: "এখন কোথায় থাকেন?", fieldType: "text" },
  { key: "education", bengaliText: "সর্বোচ্চ শিক্ষাগত যোগ্যতা কী?", fieldType: "select", options: EDU },
  { key: "profession", bengaliText: "পেশা কী?", fieldType: "text" },
  { key: "job_type", bengaliText: "চাকরির ধরন কী: সরকারি, আধা-সরকারি, বেসরকারি, ব্যবসা, নাকি অন্য?", fieldType: "select", options: JOB },
  { key: "income_range", bengaliText: "মাসিক আয় আনুমানিক কত? (২০ হাজারের কম, ২০-৪০ হাজার, ৪০-৮০ হাজার, ৮০ হাজারের বেশি, আয় নেই)", fieldType: "select", required: false, options: [opt("none", "আয় নেই"), opt("below_20k", "২০ হাজারের কম"), opt("20k_40k", "২০-৪০ হাজার"), opt("40k_80k", "৪০-৮০ হাজার"), opt("above_80k", "৮০ হাজারের বেশি")] },
  { key: "height_cm", bengaliText: "উচ্চতা কত? (যেমন ৫ ফুট ৬ ইঞ্চি)", fieldType: "number", required: false, options: { min: 120, max: 220, unit: "cm" } },
  { key: "family_details", bengaliText: "পরিবার সম্পর্কে একটু বলুন (বাবা-মা, ভাই-বোন, পারিবারিক অবস্থা)।", fieldType: "text" },
  { key: "preferred_age_range", bengaliText: "কেমন বয়সের পাত্র/পাত্রী চান? (যেমন ২৫ থেকে ৩০)", fieldType: "range" },
  { key: "preferred_education", bengaliText: "পাত্র/পাত্রীর শিক্ষাগত যোগ্যতা কেমন হলে ভালো হয়?", fieldType: "multiselect", options: [...EDU, ANY] },
  { key: "preferred_job_type", bengaliText: "পাত্র/পাত্রীর চাকরির ধরন কেমন পছন্দ?", fieldType: "multiselect", options: [...JOB, ANY] },
  { key: "preferred_location", bengaliText: "কোন জেলা বা বিভাগের পাত্র/পাত্রী পছন্দ? যেকোনো হলেও বলুন।", fieldType: "location_list" },
].map((q, i) => ({ required: true, options: null as unknown, ...q, order: (i + 1) * 10, active: true, askCondition: null as unknown }));
