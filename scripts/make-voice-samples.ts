import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Tone files stand in for speech: MockTranscriber maps each file's hash to the transcript below. */
const SAMPLES: [string, string, number][] = [
  ["01", "আমার নাম করিম, বয়স ২৮ বছর, আমি ঢাকায় থাকি", 4.2],
  ["02", "আমি বেসরকারি চাকরি করি, স্নাতক পাস করেছি", 3.6],
  ["03", "পাত্রীর পরিবার ভালো হতে হবে", 2.4],
  ["unclear", "", 0.8],
];
const manifest: Record<string, { text: string; seconds: number }> = {};
SAMPLES.forEach(([name, text, seconds], i) => {
  const file = `samples/voice/${name}.ogg`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 100}:duration=${seconds}`, "-c:a", "libopus", "-map_metadata", "-1", "-fflags", "+bitexact", file]);
  manifest[createHash("sha256").update(readFileSync(file)).digest("hex")] = { text, seconds };
});
writeFileSync("samples/voice/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
