"use client";

import { useEffect, useState } from "react";

const LABEL: Record<string, string> = {
  created: "তৈরি হয়েছে", initializing: "চালু হচ্ছে...", qr_ready: "QR স্ক্যানের অপেক্ষায়", authenticating: "যুক্ত হচ্ছে...",
  ready: "সংযুক্ত", disconnected: "সংযোগ বিচ্ছিন্ন", action_required: "ফোনে পদক্ষেপ দরকার", failed: "ব্যর্থ",
};

export function LiveStatus() {
  const [state, setState] = useState<{ status: string | null; reachable?: boolean; qr: string | null } | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const res = await fetch("/api/admin/whatsapp/qr", { cache: "no-store" });
      if (!stop && res.ok) setState(await res.json());
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (!state) return <p className="text-muted-foreground">অবস্থা দেখা হচ্ছে...</p>;
  if (state.reachable === false) return <p role="alert">OpenWA চালু নেই। টার্মিনালে <code>pnpm openwa</code> চালান।</p>;
  return (
    <div className="flex flex-col gap-3">
      <p>অবস্থা: <strong>{state.status ? (LABEL[state.status] ?? state.status) : "সেশন নেই"}</strong></p>
      {state.qr && (
        <div className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.qr} alt="WhatsApp যুক্ত করার QR কোড" className="aspect-square w-64 max-w-full rounded-md bg-white p-2" />
          <p className="text-sm text-muted-foreground">ব্যবসার ফোনে: WhatsApp → Linked devices → Link a device, তারপর এই QR স্ক্যান করুন।</p>
        </div>
      )}
    </div>
  );
}
