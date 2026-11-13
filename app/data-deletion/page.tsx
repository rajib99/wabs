import type { Metadata } from "next";

export const metadata: Metadata = { title: "তথ্য মুছুন · BiyeShadi.live", description: "BiyeShadi.live থেকে আপনার সব তথ্য মুছে ফেলার নির্দেশনা।" };

/** Meta's "Data Deletion Instructions URL" for the app. */
export default function DataDeletionPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10 leading-relaxed">
      <h1 className="text-2xl font-semibold">আপনার তথ্য মুছে ফেলুন</h1>
      <ol className="list-decimal pl-6">
        <li>Facebook Messenger-এ BiyeShadi.live Page-এর কথোপকথন খুলুন।</li>
        <li>শুধু <strong>STOP</strong> লিখে পাঠান (অথবা মেনু থেকে &quot;আমার তথ্য মুছুন&quot;)।</li>
        <li>সঙ্গে সঙ্গে আপনার প্রোফাইল, ছবি, ভয়েস মেসেজ ও কথোপকথন আমাদের সিস্টেম থেকে মুছে যাবে, এবং নিশ্চিতকরণ বার্তা পাবেন।</li>
      </ol>
      <p>Messenger ব্যবহার করতে না পারলে <a className="underline" href="mailto:privacy@biyeshadi.live">privacy@biyeshadi.live</a>-এ ইমেইল করুন; ৭ দিনের মধ্যে মুছে জানানো হবে।</p>
      <h2 className="text-xl font-medium">English</h2>
      <p>To delete all your data, open the BiyeShadi.live conversation in Messenger and send <strong>STOP</strong>. Your profile, photos, voice notes and messages are erased immediately. If you cannot use Messenger, email privacy@biyeshadi.live and we will delete it within 7 days.</p>
      <p><a className="underline" href="/privacy">গোপনীয়তা নীতি</a></p>
    </main>
  );
}
