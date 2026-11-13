import type { Metadata } from "next";

export const metadata: Metadata = { title: "গোপনীয়তা নীতি · BiyeShadi.live", description: "BiyeShadi.live কী তথ্য রাখে, কেন, এবং কীভাবে মুছবেন।" };

// Published as the app's Privacy Policy URL for Meta. Keep it true to what the code does, and have it reviewed by a lawyer.
const UPDATED = "১৩ নভেম্বর ২০২৬";

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10 leading-relaxed">
      <h1 className="text-2xl font-semibold">গোপনীয়তা নীতি</h1>
      <p className="text-sm text-muted-foreground">সর্বশেষ হালনাগাদ: {UPDATED}</p>
      <p>BiyeShadi.live একটি পরিবারকেন্দ্রিক, শুধু বিয়ের জন্য পাত্র-পাত্রী খোঁজার সেবা। Facebook Messenger-এ আমাদের স্বয়ংক্রিয় (AI) সহকারী BS আপনার সঙ্গে কথা বলে। সেবাটি শুধু ১৮ বছর বা তার বেশি বয়সীদের জন্য।</p>

      <h2 className="text-xl font-medium">কী তথ্য রাখি</h2>
      <ul className="list-disc pl-6">
        <li>আপনার Messenger আইডি (এই Page-এর জন্য নির্দিষ্ট) এবং আমাদের সঙ্গে কথোপকথন, ভয়েস মেসেজ ও তার লেখা রূপ।</li>
        <li>প্রোফাইলের উত্তর: নাম, বয়স, লিঙ্গ, ধর্ম, বৈবাহিক অবস্থা, জেলা, শিক্ষা, পেশা, আয়, উচ্চতা, পরিবার ও পছন্দ।</li>
        <li>আপনার দেওয়া যোগাযোগ নম্বর, এবং আপনি পাঠালে প্রোফাইল ছবি।</li>
        <li>পেমেন্টের bKash Transaction ID এবং আপনি দিলে পাঠানো নম্বরের শুধু শেষ ৪ সংখ্যা। পুরো অ্যাকাউন্ট নম্বর, পিন বা OTP আমরা কখনো চাই না।</li>
      </ul>

      <h2 className="text-xl font-medium">কীভাবে ব্যবহার করি</h2>
      <ul className="list-disc pl-6">
        <li>উপযুক্ত প্রস্তাব খুঁজতে। প্রস্তাব কম্পিউটার নিয়মে ঠিক হয়, AI ঠিক করে না।</li>
        <li>অন্য পক্ষকে শুধু প্রোফাইল কার্ড দেখানো হয়: বয়স, শিক্ষা, পেশা, চাকরির ধরন, জেলা, পরিবারের সংক্ষেপ। নাম, নম্বর বা ছবি নয়।</li>
        <li>আপনার ছবি শুধু আপনার স্পষ্ট অনুমতিতে, এবং আমাদের টিম যাচাই করার পর পাঠানো হয়।</li>
        <li>যোগাযোগ নম্বর শুধু দুই পক্ষ আগ্রহী হওয়ার পর পেমেন্ট প্রক্রিয়ার মাধ্যমে দেওয়া হয়। এক পক্ষ পেমেন্ট করার পর অন্য পক্ষ নির্ধারিত সময়ে পেমেন্ট না করলে, যিনি পেমেন্ট করেছেন শুধু তাঁকে অন্য পক্ষের নম্বর দেওয়া হয়।</li>
        <li>আপনার তথ্য বিজ্ঞাপন বা অন্য কোনো কাজে বিক্রি বা ব্যবহার করা হয় না।</li>
      </ul>

      <h2 className="text-xl font-medium">যাদের মাধ্যমে তথ্য প্রক্রিয়া হয়</h2>
      <ul className="list-disc pl-6">
        <li>Meta (Facebook Messenger): মেসেজ আদান-প্রদান।</li>
        <li>DeepSeek: BS-এর উত্তর তৈরি। আপনার মেসেজ ও প্রোফাইলের উত্তর বিদেশে প্রক্রিয়া হতে পারে; অন্য কারও নম্বর পাঠানো হয় না।</li>
        <li>Groq: ভয়েস মেসেজকে লেখায় রূপান্তর।</li>
        <li>Cloudflare: ছবি ও ভয়েস মেসেজ ব্যক্তিগতভাবে সংরক্ষণ। আমাদের নিজস্ব সার্ভারে বাকি তথ্য থাকে।</li>
      </ul>

      <h2 className="text-xl font-medium">কতদিন রাখি ও কীভাবে মুছবেন</h2>
      <p>আপনি মুছতে না বলা পর্যন্ত তথ্য থাকে। মুছতে Messenger-এ শুধু <strong>STOP</strong> লিখুন, অথবা মেনু থেকে &quot;আমার তথ্য মুছুন&quot; চাপুন। আপনার প্রোফাইল, ছবি, ভয়েস ও কথোপকথন সঙ্গে সঙ্গে মুছে যায়। হিসাবের প্রয়োজনে যাচাই করা পেমেন্টের Transaction ID ও টাকার পরিমাণ রাখা হয়, আপনার পরিচয় ছাড়া। ব্যাকআপ থেকে তথ্য ১৪ দিনের মধ্যে মুছে যায়। Messenger-এর নিজস্ব কথোপকথনের ইতিহাস Meta রাখে; তা আপনি Messenger থেকে মুছতে পারেন।</p>

      <h2 className="text-xl font-medium">যোগাযোগ</h2>
      <p>প্রশ্ন বা অভিযোগ: Messenger-এ &quot;মানুষের সাথে কথা বলতে চাই&quot; লিখুন, অথবা ইমেইল করুন <a className="underline" href="mailto:privacy@biyeshadi.live">privacy@biyeshadi.live</a>।</p>
      <p><a className="underline" href="/data-deletion">তথ্য মুছে ফেলার নির্দেশনা</a></p>
    </main>
  );
}
