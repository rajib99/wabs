import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { app: "biyeshadi" },
  // Phone numbers and message bodies are personal data: never log them in the clear.
  redact: { paths: ["phone", "*.phone", "text", "*.text", "raw_text"], censor: "[redacted]" },
});
