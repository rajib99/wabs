export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 className="text-3xl font-semibold">BiyeShadi.live</h1>
      <p className="text-lg">পরিবারকেন্দ্রিক, শুধু বিয়ের জন্য পাত্র-পাত্রী খোঁজার সেবা। আমাদের সহকারী BS আপনার সঙ্গে WhatsApp-এ বাংলায় কথা বলে।</p>
      <p className="text-muted-foreground">শুধু ১৮ বছর বা তার বেশি বয়সীদের জন্য। আপনার ছবি ও ফোন নম্বর আপনার সম্মতি ও নির্ধারিত প্রক্রিয়া ছাড়া কাউকে দেওয়া হয় না। যেকোনো সময় STOP লিখে সব তথ্য মুছে ফেলতে পারবেন।</p>
      <p className="flex gap-4 text-sm"><a className="underline" href="/privacy">গোপনীয়তা নীতি</a><a className="underline" href="/data-deletion">তথ্য মুছুন</a></p>
    </main>
  );
}
