import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const state = globalThis as unknown as { __bsPool?: Pool; __bsDb?: Db };

export function db(): Db {
  if (!state.__bsDb) {
    state.__bsPool = new Pool({ connectionString: env.databaseUrl(), max: 10 });
    state.__bsDb = drizzle(state.__bsPool, { schema });
  }
  return state.__bsDb;
}

export async function closeDb() {
  await state.__bsPool?.end();
  state.__bsPool = undefined;
  state.__bsDb = undefined;
}

export { schema };
