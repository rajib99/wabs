import { PageTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { SimulatorChat } from "./chat";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  await requireRole("owner");
  return (
    <>
      <PageTitle>সিমুলেটর</PageTitle>
      {env.channel() === "mock"
        ? <SimulatorChat />
        : <p className="text-muted-foreground">সিমুলেটর শুধু CHANNEL=mock অবস্থায় চলে। এখন আসল WhatsApp চ্যানেল চালু আছে।</p>}
    </>
  );
}
