import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type DocumentReader, setAiForTests } from "@/lib/ai";
import { MockDocumentReader, parseVisionReply, redactPhones } from "@/lib/ai/document-reader";
import { MockEmbedder } from "@/lib/ai/embedder";
import { MockLLMProvider } from "@/lib/ai/mock-llm";
import { runAgentTurn } from "@/lib/conversation/agent";
import { sendQueued } from "@/lib/conversation/outbound";
import { BIODATA_PREFIX, documentUnreadable, parseTypedPhone, preflight, readDocument } from "@/lib/conversation/pipeline";
import { db, schema } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { inbound, makeUser, outbound } from "./helpers";

const P = "+8801711000601";

/** A one-page PDF with a text layer, offsets computed so the xref table is valid. */
function pdfWithText(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 40 700 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

async function upload(type: "image" | "document", bytes: Uint8Array, mime: string, caption?: string) {
  await db().insert(schema.users).values({ phone: P, status: "active", consentAt: new Date(), lastInboundAt: new Date() }).onConflictDoNothing();
  const key = `documents/test/${crypto.randomUUID()}`;
  await getStorage().put(key, bytes, mime);
  return inbound(P, caption ?? "", type, { rawText: caption ?? null, mediaKey: key, mediaMime: mime });
}

afterEach(() => setAiForTests({ docReader: new MockDocumentReader(), llm: new MockLLMProvider() }));

describe("reading a biodata", () => {
  it("parses the vision model's verdict and redacts numbers", () => {
    expect(parseVisionReply('```json\n{"kind":"biodata","text":"নাম: রহিম\\nবয়স: ২৮\\nমোবাইল: ০১৭১২-৩৪৫৬৭৮"}\n```')).toEqual({
      kind: "biodata", text: "নাম: রহিম\nবয়স: 28\nমোবাইল: [নম্বর]",
    });
    expect(parseVisionReply('{"kind":"photo","text":""}').kind).toBe("photo");
    expect(parseVisionReply('{"kind":"biodata","text":"x"}').kind).toBe("other");
    expect(parseVisionReply("I cannot tell").kind).toBe("other");
    expect(redactPhones("ফোন +880 1712 345678, বয়স 25")).toBe("ফোন [নম্বর], বয়স 25");
  });

  it("a PDF biodata becomes the message text for the agent", async () => {
    const m = await upload("document", pdfWithText("Name: Rahim, Age: 28 years, District: Dhaka, Phone 01712345678"), "application/pdf");
    expect(await preflight(m.id)).toBe("document");
    expect(await readDocument(m.id)).toBe("biodata");
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(row!.transcript!.startsWith(BIODATA_PREFIX)).toBe(true);
    expect(row!.transcript).toContain("Rahim");
    expect(row!.transcript).not.toContain("01712345678");
    expect(await readDocument(m.id)).toBe("biodata"); // a retried step does not read again
  });

  it("a scanned PDF with no text, or an unknown file, gets a polite request for a clearer copy", async () => {
    const m = await upload("document", pdfWithText(""), "application/pdf");
    expect(await readDocument(m.id)).toBe("unreadable");
    await documentUnreadable(m.id);
    expect((await outbound(P)).at(-1)).toContain("PDF");
    const doc = await upload("document", new Uint8Array([1, 2, 3]), "application/msword");
    expect(await readDocument(doc.id)).toBe("unreadable");
  });

  it("an image the reader calls biodata goes to the agent; a photo keeps the photo flow", async () => {
    const reader: DocumentReader = { read: async () => ({ kind: "biodata", text: "নাম: রহিম\nবয়স: ২৮" }) };
    setAiForTests({ docReader: reader });
    const img = await upload("image", new Uint8Array([0xff, 0xd8]), "image/jpeg", "আমার ছেলের বায়োডাটা");
    expect(await readDocument(img.id)).toBe("biodata");
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, img.id));
    expect(row!.transcript).toBe(`${BIODATA_PREFIX}\nআমার ছেলের বায়োডাটা\nনাম: রহিম\nবয়স: ২৮`);

    setAiForTests({ docReader: { read: async () => ({ kind: "other", text: "" }) } });
    const photo = await upload("image", new Uint8Array([0xff, 0xd8]), "image/jpeg");
    expect(await readDocument(photo.id)).toBe("photo");
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

  it("on a phone-number identity only the WhatsApp question is asked", async () => {
    await makeUser(P, "male", {}, { contactHasWhatsapp: null });
    const m = await inbound(P, "হ্যাঁ");
    expect(await preflight(m.id)).toBe("done");
    expect((await db().select().from(schema.users).where(eq(schema.users.phone, P)))[0]!.contactHasWhatsapp).toBe(true);
    expect((await outbound(P)).at(-1)).toContain("প্রোফাইল সম্পূর্ণ");
  });
});
