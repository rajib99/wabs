import { redirect } from "next/navigation";
import { auth } from "@/auth";
import type { AdminRole } from "@/auth.config";

/** Called at the top of every server action and page: middleware alone does not protect actions. */
export async function requireRole(...roles: AdminRole[]) {
  const session = await auth();
  const role = (session?.user as { role?: AdminRole } | undefined)?.role;
  const email = session?.user?.email;
  if (!role || !email) redirect("/admin/login");
  if (!roles.includes(role)) redirect(role === "verifier" ? "/admin/payments" : "/admin");
  return { email, role };
}
