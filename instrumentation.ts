import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.EMBEDDER === "e5") {
    // Load the model at boot so the first user's turn does not pay for it. Failure only disables memory.
    const { getEmbedder } = await import("@/lib/ai");
    void getEmbedder().embed("warmup", "passage").catch((err) => console.error("embedder warmup failed", err));
  }
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
  }
}

export const onRequestError = Sentry.captureRequestError;
