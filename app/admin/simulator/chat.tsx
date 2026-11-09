"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Msg = { id: string; direction: string; type: string; text: string | null; status: string };

export function SimulatorChat() {
  const [phone, setPhone] = useState("+8801700000001");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLLIElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/simulator?phone=${encodeURIComponent(phone)}`);
    if (res.ok) setMessages(((await res.json()) as { messages: Msg[] }).messages);
  }, [phone]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [load]);

  const count = messages.length;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [count]);

  async function post(body: object) {
    setError(null);
    const res = await fetch("/api/simulator", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, ...body }) });
    if (!res.ok) setError(`পাঠানো যায়নি (${res.status})`);
    void load();
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text;
    setText("");
    await post({ type: "text", text: t });
  }

  async function sendFile(type: "image" | "voice", file?: File) {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    await post({ type, media_base64: btoa(binary), media_mime: file.type || (type === "voice" ? "audio/ogg" : "image/jpeg") });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">ব্যবহারকারীর নম্বর<Input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" /></label>
      <ol aria-live="polite" className="flex h-[55dvh] flex-col gap-2 overflow-y-auto rounded-lg border bg-muted p-3">
        {messages.map((m) => (
          <li key={m.id} className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg border p-2 text-sm ${m.direction === "inbound" ? "self-end bg-card" : "self-start bg-card"}`}>
            {m.type !== "text" && <span className="mr-1 text-xs text-muted-foreground">[{m.type}]</span>}
            {m.text}
            {m.status === "skipped_window" && <span className="block text-xs text-muted-foreground">২৪ ঘণ্টার বাইরে: পাঠানো হয়নি</span>}
          </li>
        ))}
        <li ref={end} aria-hidden />
      </ol>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <form onSubmit={send} className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="বার্তা লিখুন" aria-label="বার্তা" />
        <Button>পাঠান</Button>
      </form>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">ছবি<input type="file" accept="image/*" onChange={(e) => void sendFile("image", e.target.files?.[0])} /></label>
        <label className="flex items-center gap-2">ভয়েস<input type="file" accept="audio/*" onChange={(e) => void sendFile("voice", e.target.files?.[0])} /></label>
      </div>
    </div>
  );
}
