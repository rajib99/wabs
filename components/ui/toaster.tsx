"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; kind: "success" | "error"; text: string };

const listeners = new Set<(t: Toast) => void>();
let nextId = 0;

export function toast(kind: Toast["kind"], text: string) {
  const t = { id: ++nextId, kind, text };
  for (const l of listeners) l(t);
}

/** Mount once (admin layout). Successes fade after 3s; errors stay 10s or until clicked. */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (t: Toast) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.kind === "error" ? 10_000 : 3_000);
    };
    listeners.add(add);
    return () => void listeners.delete(add);
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm flex-col gap-2">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role={t.kind === "error" ? "alert" : "status"}
          onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
          className={cn(
            "pointer-events-auto rounded-md border px-4 py-3 text-left text-sm font-medium shadow-lg",
            t.kind === "success" ? "bg-card text-foreground" : "border-destructive bg-card text-destructive",
          )}
        >
          {t.kind === "success" ? "✓ " : "✕ "}{t.text}
        </button>
      ))}
    </div>
  );
}
