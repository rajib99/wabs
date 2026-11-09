import Link from "next/link";
import { auth } from "@/auth";
import { logoutAction } from "./actions";

const OWNER_NAV: [string, string][] = [
  ["/admin", "পরিসংখ্যান"], ["/admin/payments", "পেমেন্ট"], ["/admin/inbox", "ইনবক্স"], ["/admin/photos", "ছবি"], ["/admin/users", "ব্যবহারকারী"], ["/admin/matches", "ম্যাচ"],
  ["/admin/whatsapp", "WhatsApp"], ["/admin/questions", "প্রশ্ন"], ["/admin/settings", "ম্যাচিং সেটিংস"], ["/admin/templates", "বার্তা ও মূল্য"], ["/admin/simulator", "সিমুলেটর"],
];
const VERIFIER_NAV: [string, string][] = [["/admin/payments", "পেমেন্ট"], ["/admin/inbox", "ইনবক্স"], ["/admin/photos", "ছবি"]];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!role) return <>{children}</>; // the login page; middleware guards everything else
  const nav = role === "owner" ? OWNER_NAV : VERIFIER_NAV;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <nav aria-label="অ্যাডমিন" className="flex flex-1 gap-1 overflow-x-auto text-sm">
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className="whitespace-nowrap rounded-md px-2 py-2 hover:bg-muted">{label}</Link>
            ))}
          </nav>
          <form action={logoutAction}><button className="whitespace-nowrap text-sm text-muted-foreground underline">বের হোন</button></form>
        </div>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">{children}</main>
    </div>
  );
}
