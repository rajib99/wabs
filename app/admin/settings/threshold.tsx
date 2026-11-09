"use client";

import { useState } from "react";

export function ThresholdSlider({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <label className="flex flex-col gap-1 text-sm">
      ম্যাচের ন্যূনতম স্কোর: <output className="text-lg font-semibold tabular-nums">{value}</output>
      <input type="range" name="match_threshold" min={0} max={100} step={1} value={value} onChange={(e) => setValue(Number(e.target.value))} className="min-h-10 w-full accent-primary" />
    </label>
  );
}
