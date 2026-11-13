import { z } from "zod";
import type { ToolDefinition } from "@/lib/ai";
import { respondToMatch } from "@/lib/matches";
import { submitPayment } from "@/lib/payments";
import { confirmProfilePhoto, requestPhoto, respondToPhotoRequest } from "@/lib/photos";
import { pendingQuestions, loadAnswers, loadQuestions, saveAnswer, savePreference } from "@/lib/profile";
import { endUnderage, escalate, reportMatch } from "@/lib/safety";
import { getSetting } from "@/lib/settings";
import { toAsciiDigits } from "@/lib/text";

const jsonValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.object({ min: z.number(), max: z.number() })]);

/** Note: no tool can verify a payment, read another user, or change identity. The phone comes from the server, never from the model. */
export const TOOL_SCHEMAS = {
  save_answer: {
    description: "Save one profile answer the user gave, asked or volunteered. Call once per fact.",
    schema: z.object({
      question_key: z.string().min(1),
      value: jsonValue,
      source: z.enum(["asked", "volunteered", "inferred"]),
      confidence: z.number().min(0).max(1),
    }),
  },
  save_preference: {
    description: "Save what the user requires in a partner. field is the partner's field. Use is_dealbreaker=true for absolute requirements such as 'only government job'.",
    schema: z.object({
      field: z.enum(["age", "education", "job_type", "religion", "marital_status", "district", "height_cm", "income_range"]),
      operator: z.enum(["eq", "neq", "in", "not_in", "gte", "lte", "between"]),
      value: jsonValue,
      is_dealbreaker: z.boolean(),
    }),
  },
  get_next_question: {
    description: "Get the next profile questions to ask, in priority order. Ask at most 2 per reply.",
    schema: z.object({}),
  },
  respond_to_match: {
    description: "Record the user's decision on a match from active_matches.",
    schema: z.object({ match_id: z.string().uuid(), action: z.enum(["interested", "decline"]) }),
  },
  request_photo: {
    description: "The user wants to see the photo of the other party in a match. Asks that party's permission.",
    schema: z.object({ match_id: z.string().uuid() }),
  },
  respond_to_photo_request: {
    description: "The user answered a request in pending_photo_requests to share their own photo. allow=true only on an explicit yes.",
    schema: z.object({ request_id: z.string().uuid(), allow: z.boolean() }),
  },
  confirm_profile_photo: {
    description: "The user answered whether the image they just sent is the profile photo.",
    schema: z.object({ is_profile_photo: z.boolean() }),
  },
  submit_payment: {
    description: "Record a bKash Transaction ID the user gave for a match with payment_open=true. wallet_last4 only if the user offered the last 4 digits of the sending number; never ask for a full account number.",
    schema: z.object({ match_id: z.string().uuid(), trx_id: z.string().min(1), wallet_last4: z.string().optional() }),
  },
  report_match: {
    description: "The user reports or blocks the other party of a match. Closes the match.",
    schema: z.object({ match_id: z.string().uuid(), reason: z.string().min(1) }),
  },
  escalate_to_human: {
    description: "Hand the conversation to a human admin.",
    schema: z.object({ reason: z.string().min(1) }),
  },
};

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_DEFINITIONS: ToolDefinition[] = Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: z.toJSONSchema(t.schema) as Record<string, unknown> },
}));

export type TurnState = {
  phone: string;
  messageId: string;
  userText: string;
  profileChanged: boolean;
  profileCompleted: boolean;
  ended: "underage" | null;
};

export async function executeTool(name: ToolName, args: unknown, turn: TurnState): Promise<unknown> {
  const { phone } = turn;
  switch (name) {
    case "save_answer": {
      const a = TOOL_SCHEMAS.save_answer.schema.parse(args);
      if (a.question_key === "age") {
        const age = Number(toAsciiDigits(String(a.value)).replace(/[^\d.]/g, ""));
        if (age > 0 && age < (await getSetting<number>("min_age_gate")) && a.confidence >= 0.8) {
          await endUnderage(phone);
          turn.ended = "underage";
          return { ok: true, note: "Conversation ended." };
        }
      }
      const res = await saveAnswer({ phone, questionKey: a.question_key, value: a.value, source: a.source, confidence: a.confidence, messageId: turn.messageId });
      if (res.ok) {
        turn.profileChanged ||= res.profileChanged;
        turn.profileCompleted ||= res.profileCompleted;
        return { ok: true, stored: res.stored, profile_complete: res.profileComplete };
      }
      return res;
    }
    case "save_preference": {
      const a = TOOL_SCHEMAS.save_preference.schema.parse(args);
      const res = await savePreference({ phone, field: a.field, operator: a.operator, value: a.value, isDealbreaker: a.is_dealbreaker });
      if (res.ok) turn.profileChanged = true;
      return res;
    }
    case "get_next_question": {
      const [questions, answers] = await Promise.all([loadQuestions(), loadAnswers(phone)]);
      const next = pendingQuestions(questions, answers).slice(0, 2);
      return { questions: next.map((q) => ({ key: q.key, text: q.bengaliText, type: q.fieldType, options: q.options })), profile_complete: next.length === 0 };
    }
    case "respond_to_match": {
      const a = TOOL_SCHEMAS.respond_to_match.schema.parse(args);
      return respondToMatch(phone, a.match_id, a.action);
    }
    case "request_photo":
      return requestPhoto(phone, TOOL_SCHEMAS.request_photo.schema.parse(args).match_id);
    case "respond_to_photo_request": {
      const a = TOOL_SCHEMAS.respond_to_photo_request.schema.parse(args);
      return respondToPhotoRequest(phone, a.request_id, a.allow, turn.userText);
    }
    case "confirm_profile_photo":
      return confirmProfilePhoto(phone, TOOL_SCHEMAS.confirm_profile_photo.schema.parse(args).is_profile_photo);
    case "submit_payment": {
      const a = TOOL_SCHEMAS.submit_payment.schema.parse(args);
      return submitPayment(phone, a.match_id, a.wallet_last4, a.trx_id);
    }
    case "report_match": {
      const a = TOOL_SCHEMAS.report_match.schema.parse(args);
      return reportMatch(phone, a.match_id, a.reason);
    }
    case "escalate_to_human":
      return escalate(phone, TOOL_SCHEMAS.escalate_to_human.schema.parse(args).reason);
  }
}
