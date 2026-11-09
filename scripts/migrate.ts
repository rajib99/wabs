import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "@/lib/db";

await migrate(db(), { migrationsFolder: "./drizzle" });
console.log("migrations applied");
await closeDb();
