import { getLLM } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";

export type GateKind = "age" | "consent" | "whatsapp";
export type GateVerdict = "yes" | "no" | "unclear";

const BUDGET_MS = 8000;

/**
 * People rarely answer a gate question with the exact word we asked for ("amar chele 28 e porse", "I agree,
 * go ahead", "18 er beshi"). When the deterministic parser cannot tell, the LLM reads the reply and maps it
 * to yes / no / unclear. For "age", yes means 18 or older. The model only classifies; code acts on the verdict,
 * and anything it cannot classify (or any failure) stays "unclear" so the question is simply asked again.
 */
export async function interpretGateReply(kind: GateKind, question: string, reply: string): Promise<GateVerdict> {
  if (!reply.trim()) return "unclear";
  try {
    const [prompt, minAge] = await Promise.all([getSetting<string>("gate_interpret_prompt"), getSetting<number>("min_age_gate")]);
    const res = await Promise.race([
      getLLM().chat({
        messages: [
          { role: "system", content: prompt.replaceAll("{min_age}", String(minAge)) },
          { role: "user", content: JSON.stringify({ kind, question, reply: reply.slice(0, 500) }) },
        ],
        tools: [],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gate interpretation over time budget")), BUDGET_MS)),
    ]);
    const word = (res.content ?? "").trim().toLowerCase().match(/\b(yes|no|unclear)\b/)?.[1];
    return (word as GateVerdict | undefined) ?? "unclear";
  } catch (err) {
    logger.warn({ err, kind }, "gate interpretation unavailable");
    return "unclear";
  }
}
