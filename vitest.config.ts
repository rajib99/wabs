import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost/biyeshadi_test",
      LLM_PROVIDER: "mock",
      TRANSCRIBER: "mock",
      EMBEDDER: "mock",
      CHANNEL: "mock",
      STORAGE: "local",
      LOCAL_STORAGE_DIR: ".data/test-media",
      INNGEST_DEV: "1",
      LOG_LEVEL: "silent",
    },
  },
});
