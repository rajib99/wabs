import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setAiForTests } from "@/lib/ai";
import { MockEmbedder } from "@/lib/ai/embedder";
import { runAgentTurn } from "@/lib/conversation/agent";
import { sendQueued } from "@/lib/conversation/outbound";
import { documentNotRead, parseTypedPhone, preflight } from "@/lib/conversation/pipeline";
import { db, schema } from "@/lib/db";
import { inbound, makeUser, outbound } from "./helpers";

const P = "+8801711000601";

describe("profiles are built only by questions", () => {
  it("consent is followed by the first profile question, not a biodata offer", async () => {
    await db().insert(schema.users).values({ phone: P, status: "awaiting_consent", lastInboundAt: new Date() });
    expect(await preflight((await inbound(P, "হ্যাঁ")).id)).toBe("done");
    const [first] = (await db().select().from(schema.questions).orderBy(schema.questions.order)).filter((q) => q.active);
    const text = (await outbound(P)).at(-1)!;
    expect(text).toContain("প্রশ্ন");
    expect(text).toContain(first!.bengaliText);
    expect(text).not.toContain("বায়োডাটা");
  });
  it("a file is not downloaded or read: the user is asked to answer the questions", async () => {
    await makeUser(P, "male", {}, { profileComplete: false });
    const m = await inbound(P, "", "document", { mediaId: "https://cdn.fbsbx.com/v/biodata.pdf", mediaMime: "application/pdf" });
    expect(await preflight(m.id)).toBe("document");
    await documentNotRead(m.id);
    expect((await outbound(P)).at(-1)).toContain("ফাইল থেকে তথ্য নিই না");
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(row!.mediaKey).toBeNull(); // nothing was stored
  });
});

describe("contact number comes last", () => {
  it("finds a typed number inside a sentence", () => {
    expect(parseTypedPhone("আমার নম্বর ০১৭১২-৩৪৫৬৭৮, ফোন দিবেন")).toBe("+8801712345678");
    expect(parseTypedPhone("+8801712345678")).toBe("+8801712345678");
    expect(parseTypedPhone("নম্বর +880 1712 345678")).toBe("+8801712345678");
    expect(parseTypedPhone("বয়স ২৮")).toBeNull();
  });

  it("answering the last question appends the number request, with the share button", async () => {
    const fb = "fb:7001";
    await makeUser(fb, "male", {}, { contactPhone: null, contactPhoneVerified: false, contactPhoneSource: null, contactHasWhatsapp: null, profileComplete: false });
    await db().delete(schema.profileAnswers).where(eq(schema.profileAnswers.questionKey, "family_details"));
    setAiForTests({ embedder: new MockEmbedder() });
    // The mock LLM saves the answer to the question it last asked.
    await db().insert(schema.messages).values({ phone: fb, direction: "outbound", type: "text", rawText: "পরিবার সম্পর্কে একটু বলুন (বাবা-মা, ভাই-বোন, পারিবারিক অবস্থা)।", status: "sent" });
    const m = await inbound(fb, "বাবা-মা ও দুই ভাই");
    const res = await runAgentTurn(fb, m.id, "বাবা-মা ও দুই ভাই");
    expect(res).toMatchObject({ profileCompleted: true, requestPhone: true });
    await sendQueued(res.replyKey, { requestPhone: res.requestPhone });
    expect((await outbound(fb)).at(-1)).toContain("মোবাইল নম্বর");
  });

  it("on a phone-number identity only the WhatsApp question is asked, then the photo step", async () => {
    await makeUser(P, "male", {}, { contactHasWhatsapp: null, photoStepDone: false });
    const m = await inbound(P, "হ্যাঁ");
    expect(await preflight(m.id)).toBe("done");
    expect((await db().select().from(schema.users).where(eq(schema.users.phone, P)))[0]!.contactHasWhatsapp).toBe(true);
    expect((await outbound(P)).at(-1)).toContain("এক বা একাধিক ছবি");
    expect(await preflight((await inbound(P, "হ্যাঁ")).id)).toBe("done");
    expect((await outbound(P)).at(-2)).toContain("প্রোফাইল সম্পূর্ণ"); // then the new-proposal alert request
  });
});
