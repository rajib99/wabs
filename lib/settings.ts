import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { DEFAULT_MESSAGES, DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import { render } from "@/lib/text";

/** Reads a setting from the database. Defaults only cover keys added after the last seed. */
export async function getSetting<T>(key: string): Promise<T> {
  const [row] = await db().select().from(schema.settings).where(eq(schema.settings.key, key));
  return (row ? row.value : DEFAULT_SETTINGS[key]) as T;
}

export async function setSetting(key: string, value: unknown) {
  await db().insert(schema.settings).values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export type MessageKey = keyof typeof DEFAULT_MESSAGES;

export async function msg(key: MessageKey, vars?: Record<string, string | number>): Promise<string> {
  const stored = await getSetting<Partial<Record<MessageKey, string>>>("messages");
  return render(stored[key] ?? DEFAULT_MESSAGES[key], vars);
}
