import "dotenv/config";
import bcrypt from "bcryptjs";
import { closeDb, db, schema } from "@/lib/db";
import { QUESTION_SEED } from "@/lib/questions-seed";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

// Idempotent: existing rows are kept so admin edits survive a re-seed.
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  await db().insert(schema.settings).values({ key, value }).onConflictDoNothing();
}
await db().insert(schema.questions).values(QUESTION_SEED).onConflictDoNothing();

const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  await db().insert(schema.adminUsers)
    .values({ email: ADMIN_EMAIL.toLowerCase(), passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12), role: "owner" })
    .onConflictDoNothing();
  console.log(`owner account ready: ${ADMIN_EMAIL}`);
} else {
  console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set: no owner account created");
}
console.log("seed complete");
await closeDb();
