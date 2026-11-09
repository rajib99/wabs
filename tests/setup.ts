import { afterAll, beforeAll, beforeEach, vi } from "vitest";

const sent: { name: string; id?: string; data: Record<string, unknown> }[] = [];
(globalThis as unknown as { __sentEvents: typeof sent }).__sentEvents = sent;

vi.mock("@/inngest/client", () => ({
  inngest: {
    send: async (e: (typeof sent)[number]) => { (globalThis as unknown as { __sentEvents: typeof sent }).__sentEvents.push(e); return { ids: [] }; },
    createFunction: () => ({}),
  },
}));

beforeAll(async () => {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { db } = await import("@/lib/db");
  await migrate(db(), { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  sent.length = 0;
  const { resetDb } = await import("./helpers");
  await resetDb();
});

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  await closeDb();
});
