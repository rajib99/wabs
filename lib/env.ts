import { z } from "zod";

/** A feature's settings are missing or invalid. Retrying cannot fix it, so background steps should not retry it. */
export class ConfigError extends Error {
  override name = "ConfigError";
}
/** By name, so it still matches when the error comes from another copy of this module (dev reloads, bundling). */
export const isConfigError = (err: unknown) => err instanceof Error && err.name === "ConfigError";

/** Secrets are validated lazily, the first time the feature that needs them is used. */
function parse<T extends z.ZodTypeAny>(feature: string, schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Field names, plus the reason when it is more than "missing" (never the value itself: it may be a secret).
    const missing = result.error.issues.map((i) => (i.code === "invalid_format" ? `${i.path.join(".")} (${i.message})` : i.path.join("."))).join(", ");
    throw new ConfigError(`${feature} is not configured: check ${missing}`);
  }
  return result.data;
}

const secret = z.string().min(1);

export const env = {
  databaseUrl: () => parse("Database", z.object({ DATABASE_URL: secret })).DATABASE_URL,
  channel: () => parse("Channel", z.object({ CHANNEL: z.enum(["mock", "messenger", "openwa", "whatsapp"]).default("mock") })).CHANNEL,
  llmProvider: () => parse("LLM", z.object({ LLM_PROVIDER: z.enum(["mock", "deepseek"]).default("deepseek") })).LLM_PROVIDER,
  transcriber: () => parse("Transcriber", z.object({ TRANSCRIBER: z.enum(["mock", "groq"]).default("groq") })).TRANSCRIBER,
  docReader: () => parse("Document reader", z.object({ DOC_READER: z.enum(["mock", "vision"]).default("vision") })).DOC_READER,
  /** Any OpenAI-compatible vision model. Defaults to Groq with the transcriber's key; Gemini reads Bengali print better. */
  vision: () => {
    const cfg = parse(
      "Vision",
      z.object({
        VISION_API_KEY: z.string().optional(),
        GROQ_API_KEY: z.string().optional(),
        VISION_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
        VISION_MODEL: z.string().default("meta-llama/llama-4-scout-17b-16e-instruct"),
      }),
    );
    const apiKey = cfg.VISION_API_KEY || cfg.GROQ_API_KEY;
    if (!apiKey) throw new ConfigError("Vision is not configured: check VISION_API_KEY (or GROQ_API_KEY)");
    return { apiKey, baseURL: cfg.VISION_BASE_URL, model: cfg.VISION_MODEL };
  },
  embedder: () => parse("Embedder", z.object({ EMBEDDER: z.enum(["mock", "e5"]).default("e5") })).EMBEDDER,
  storage: () => parse("Storage", z.object({ STORAGE: z.enum(["local", "r2"]).default("local") })).STORAGE,
  localStorageDir: () => process.env.LOCAL_STORAGE_DIR || ".data/media",
  deepseek: () =>
    parse(
      "DeepSeek",
      z.object({
        DEEPSEEK_API_KEY: secret,
        DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
        DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
      }),
    ),
  groq: () =>
    parse(
      "Groq",
      z.object({
        GROQ_API_KEY: secret,
        GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
      }),
    ),
  whatsapp: () =>
    parse(
      "WhatsApp",
      z.object({
        WHATSAPP_ACCESS_TOKEN: secret,
        WHATSAPP_PHONE_NUMBER_ID: secret,
        WHATSAPP_APP_SECRET: secret,
        WHATSAPP_VERIFY_TOKEN: secret,
        WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
        WHATSAPP_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
      }),
    ),
  messenger: () =>
    parse(
      "Messenger",
      z.object({
        MESSENGER_PAGE_ID: secret,
        MESSENGER_PAGE_ACCESS_TOKEN: secret,
        MESSENGER_APP_ID: secret,
        MESSENGER_APP_SECRET: secret,
        MESSENGER_VERIFY_TOKEN: z.string().min(16),
        MESSENGER_GRAPH_VERSION: z.string().default("v27.0"),
        MESSENGER_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
      }),
    ),
  publicUrl: () => (process.env.PUBLIC_URL || "https://biyeshadi.live").replace(/\/$/, ""),
  openwa: () =>
    parse(
      "OpenWA",
      z.object({
        OPENWA_BASE_URL: z.string().url().default("http://127.0.0.1:2785"),
        OPENWA_API_KEY: secret,
        OPENWA_SESSION: z.string().regex(/^[A-Za-z0-9-]{3,50}$/).default("biyeshadi"),
        OPENWA_WEBHOOK_SECRET: z.string().min(16),
        OPENWA_WEBHOOK_URL: z.string().url().default("http://127.0.0.1:3000/api/openwa/webhook"),
      }),
    ),
  r2: () =>
    parse(
      "R2",
      z.object({
        // The 32-character hex Account ID from the Cloudflare dashboard, nothing else. A full endpoint URL or a token
        // ID here makes an R2 host that does not exist, which Cloudflare answers with a TLS handshake failure.
        R2_ACCOUNT_ID: z.string().trim().regex(/^[0-9a-f]{32}$/, "R2_ACCOUNT_ID must be the 32-character hex Account ID, not a URL or token ID"),
        R2_ACCESS_KEY_ID: secret,
        R2_SECRET_ACCESS_KEY: secret,
        R2_BUCKET: secret,
      }),
    ),
};
