import type { NextAuthConfig } from "next-auth";

export type AdminRole = "owner" | "verifier";

/** Pages a verifier may open. Everything else under /admin is owner-only. */
const VERIFIER_PATHS = ["/admin/payments", "/admin/photos", "/admin/inbox"];

export function canAccess(role: string | undefined, path: string): boolean {
  if (role === "owner") return true;
  if (role === "verifier") return VERIFIER_PATHS.some((p) => path === p || path.startsWith(`${p}/`)) || (path.startsWith("/api/admin/") && !path.startsWith("/api/admin/whatsapp"));
  return false;
}

/** Edge-safe part of the Auth.js config, shared with middleware. No database access here. */
export const authConfig = {
  pages: { signIn: "/admin/login" },
  session: { strategy: "jwt", maxAge: 12 * 3600 },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path === "/admin/login") return true;
      const role = (auth?.user as { role?: string } | undefined)?.role;
      if (!role) return false;
      if (canAccess(role, path)) return true;
      const home = role === "verifier" ? "/admin/payments" : "/admin";
      // Behind Caddy the internal host is not the public one, so build the redirect from the forwarded headers.
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
      const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
      return Response.redirect(`${proto}://${host}${home}`);
    },
    jwt({ token, user }) {
      if (user) token.role = (user as { role?: string }).role;
      return token;
    },
    session({ session, token }) {
      (session.user as { role?: unknown }).role = token.role;
      return session;
    },
  },
} satisfies NextAuthConfig;
