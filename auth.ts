import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db, schema } from "@/lib/db";
import { type AdminRole, authConfig } from "./auth.config";

const FAILURES = new Map<string, { n: number; until: number }>();
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase();
        const record = FAILURES.get(email);
        if (record && record.n >= MAX_FAILURES && record.until > Date.now()) return null;
        const [admin] = await db().select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email));
        const ok = admin && (await bcrypt.compare(parsed.data.password, admin.passwordHash));
        if (!ok) {
          FAILURES.set(email, { n: (record?.until ?? 0) > Date.now() ? record!.n + 1 : 1, until: Date.now() + LOCK_MS });
          await audit(email, "admin.login_failed");
          return null;
        }
        FAILURES.delete(email);
        await audit(email, "admin.login");
        return { id: admin.id, email: admin.email, role: admin.role } as { id: string; email: string; role: AdminRole };
      },
    }),
  ],
});
