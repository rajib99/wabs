FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Also the image used by the `migrate` compose service (has tsx and drizzle).
FROM deps AS builder
COPY . .
RUN pnpm build
# Bake the embedding model in, so a fresh container never downloads it during a user's turn.
RUN HF_CACHE_DIR=/models node --input-type=module -e "import { pipeline, env } from '@huggingface/transformers'; env.cacheDir = process.env.HF_CACHE_DIR; await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });"

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HF_CACHE_DIR=/models PORT=3000 HOSTNAME=0.0.0.0 LOCAL_STORAGE_DIR=/app/.data/media
WORKDIR /app
RUN useradd --system --uid 1001 --home /app app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /models /models
RUN mkdir -p /app/.data && chown -R app /app/.data /models
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
