import { db, schema } from "@/lib/db";

export async function audit(actor: string, action: string, entity?: string, entityId?: string, details?: unknown) {
  await db().insert(schema.auditLog).values({ actor, action, entity, entityId, details });
}
