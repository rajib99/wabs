import { Card } from "@/components/ui/card";
import { LoginForm } from "./form";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">BiyeShadi অ্যাডমিন</h1>
      <Card><LoginForm /></Card>
    </main>
  );
}
