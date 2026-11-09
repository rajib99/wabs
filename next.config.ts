import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp", "pg", "pino"],
  // These load native binaries dynamically, so Next's file tracing cannot see them.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/@huggingface/**",
      "./node_modules/onnxruntime-node/**",
      "./node_modules/onnxruntime-common/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
      "./node_modules/detect-libc/**",
      "./node_modules/semver/**",
    ],
  },
  outputFileTracingExcludes: { "/**": ["./samples/**", "./tests/**", "**/.cache/**", "./node_modules/onnxruntime-node/bin/napi-*/win32/**"] },
};

export default config;
