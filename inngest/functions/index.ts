import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { runAgentTurn } from "@/lib/conversation/agent";
import { askForNotifications } from "@/lib/conversation/notify";
import { flushOutboundQueue, sendQueued, sendToUser } from "@/lib/conversation/outbound";
import { drainGatewayEraseQueue } from "@/lib/safety";
import {
  askToRetype, documentNotRead, embedMessage, handleImage, isPermanentMediaError, markProcessed, messageText, preflight, storeMedia, transcribeMessage,
} from "@/lib/conversation/pipeline";
import { db, schema } from "@/lib/db";
import { closeMatch, advanceMatch, type MatchState } from "@/lib/matches";
import { activeUserPhones, findMatches } from "@/lib/matching/find";
import { hasOpenPayments, settleVerifiedPayment } from "@/lib/payments";
import { getSetting, msg } from "@/lib/settings";
import { eq } from "drizzle-orm";

/** Every inbound message, per-user in order. Step outputs carry ids and flags, never message text. */
export const waMessageReceived = inngest.createFunction(
  {
    id: "wa-message-received",
    retries: 2,
    concurrency: { key: "event.data.phone", limit: 1 },
    triggers: [{ event: "wa/message.received" }],
  },
  async ({ event, step }) => {
    const { messageId, phone } = event.data as { messageId: string; phone: string };

    const action = await step.run("preflight", () => preflight(messageId));
    if (action === "done") return { action };

    // Files are not read: profiles are built only by asking questions.
    if (action === "document") {
      await step.run("document-not-read", () => documentNotRead(messageId));
      return { action };
    }

    // Every image is a candidate profile photo.
    if (action === "image") {
      let stored = false;
      try {
        // Only network hiccups are worth a retry; a refused link or missing storage settings fail at once.
        stored = await step.run("store-image", () => storeMedia(messageId, "photos").catch((err) => {
          throw isPermanentMediaError(err) ? new NonRetriableError(err.message, { cause: err }) : err;
        }));
      } catch {
        await step.run("image-fallback", async () => sendToUser(phone, await msg("fallback"), { dedupeKey: `fallback-${messageId}` }));
        return { action, stored };
      }
      if (!stored) return { action };
      await step.run("handle-image", () => handleImage(messageId));
      return { action };
    }

    if (action === "voice") {
      let usable = false;
      try {
        const stored = await step.run("store-voice", () => storeMedia(messageId, "voice"));
        if (!stored) return { action, stored };
        usable = await step.run("transcribe", () => transcribeMessage(messageId));
      } catch {
        usable = false; // retries exhausted
      }
      if (!usable) {
        await step.run("ask-retype", () => askToRetype(messageId));
        return { action, usable };
      }
    }

    let turn: Awaited<ReturnType<typeof runAgentTurn>> | null = null;
    try {
      turn = await step.run("agent-turn", async () => {
        const [m] = await db().select().from(schema.messages).where(eq(schema.messages.id, messageId));
        if (!m) return null; // the user was removed while this was queued
        return runAgentTurn(phone, messageId, messageText(m));
      });
    } catch {
      await step.run("fallback-reply", async () => sendToUser(phone, await msg("fallback"), { dedupeKey: `fallback-${messageId}` }));
    }
    if (turn) {
      const { replyKey } = turn;
      await step.run("send-reply", () => sendQueued(replyKey, { requestPhone: turn!.requestPhone }));
      // A natural pause to ask whether we may message them later (Messenger one-time notifications).
      await step.run("ask-notify", () => askForNotifications(phone));
      if (turn.profileCompleted || turn.profileChanged) {
        await step.sendEvent("profile-event", {
          name: turn.profileCompleted ? "profile/completed" : "profile/updated",
          data: { phone },
        });
      }
    }
    await step.run("mark-processed", () => markProcessed(messageId));
    if (turn) await step.sendEvent("embed", { name: "message/embed", data: { messageId } });
    return { action };
  },
);

/** Embeddings run in the background, one at a time, to protect the 2 vCPU VPS. */
export const embedMessageFn = inngest.createFunction(
  { id: "embed-message", retries: 2, concurrency: { limit: 1 }, triggers: [{ event: "message/embed" }] },
  async ({ event, step }) => {
    const { messageId } = event.data as { messageId: string };
    return step.run("embed", () => embedMessage(messageId));
  },
);

export const findMatchesFn = inngest.createFunction(
  {
    id: "find-matches",
    retries: 2,
    concurrency: { key: "event.data.phone", limit: 1 },
    debounce: { key: "event.data.phone", period: "3s" },
    triggers: [{ event: "profile/completed" }, { event: "profile/updated" }, { event: "matching/run" }],
  },
  async ({ event, step }) => {
    const { phone } = event.data as { phone: string };
    const created = await step.run("find-matches", () => findMatches(phone));
    if (created.length) {
      await step.sendEvent("proposed", created.map((m) => ({
        id: `match-${m.id}-proposed`, name: "match/state.changed", data: { matchId: m.id, state: "proposed" },
      })));
    }
    return { created: created.length };
  },
);

export const nightlyMatching = inngest.createFunction(
  { id: "nightly-matching", triggers: [{ cron: "TZ=Asia/Dhaka 0 2 * * *" }] },
  async ({ step }) => {
    const phones = await step.run("active-users", () => activeUserPhones());
    if (phones.length) await step.sendEvent("fan-out", phones.map((phone) => ({ name: "matching/run", data: { phone } })));
    return { users: phones.length };
  },
);

export const matchAdvance = inngest.createFunction(
  {
    id: "match-advance",
    retries: 3,
    concurrency: { key: "event.data.matchId", limit: 1 },
    triggers: [{ event: "match/state.changed" }],
  },
  async ({ event, step }) => {
    const { matchId, state } = event.data as { matchId: string; state: string };
    await step.run("advance", () => advanceMatch(matchId, state));
  },
);

/** States in which a match waits on someone. Each gets one run that expires the match unless the state moves on first. */
const WAITING_STATES = ["offered_to_a", "shown_to_a", "offered_to_b", "shown_to_b", "both_interested"];

export const matchExpiry = inngest.createFunction(
  {
    id: "match-expiry",
    retries: 3,
    triggers: [{ event: "match/state.changed", if: WAITING_STATES.map((st) => `event.data.state == '${st}'`).join(" || ") }],
  },
  async ({ event, step }) => {
    const { matchId, state } = event.data as { matchId: string; state: MatchState };
    // Both interested waits on a payment, which gets longer than an answer.
    const seconds = await step.run("timeout", () =>
      getSetting<number>(state === "both_interested" ? "payment_timeout_seconds" : "match_response_timeout_seconds"));
    const changed = await step.waitForEvent("wait-for-change", {
      event: "match/state.changed",
      timeout: `${seconds}s`,
      if: "async.data.matchId == event.data.matchId",
    });
    if (changed) return { expired: false };
    const expired = await step.run("expire", async () => {
      // A payment waiting for the admin, or already verified, keeps the match open.
      if (state === "both_interested" && (await hasOpenPayments(matchId))) return false;
      // onlyFrom makes this safe if the state changed just before the wait began.
      return closeMatch(matchId, "expired", "system", state === "both_interested" ? "no_payment" : "no_response", undefined, state);
    });
    return { expired };
  },
);

/** Some hours after a number is released: how did the call go, and do they want more proposals? */
export const callFollowup = inngest.createFunction(
  { id: "call-followup", retries: 3, triggers: [{ event: "contact/released" }] },
  async ({ event, step }) => {
    const { matchId, phone } = event.data as { matchId: string; phone: string };
    const seconds = await step.run("delay", () => getSetting<number>("call_followup_seconds"));
    await step.sleep("wait-for-call", `${seconds}s`);
    await step.run("ask", async () => {
      const [user] = await db().select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.phone, phone));
      if (user?.status !== "active") return "gone"; // erased or stopped in the meantime
      return sendToUser(phone, await msg("call_followup"), { dedupeKey: `followup-${matchId}-${phone}`, template: "match_update", deferOnFailure: true });
    });
  },
);

/** Independent of the waits above, so two verifies seconds apart can never be missed. */
export const paymentSettle = inngest.createFunction(
  {
    id: "payment-settle",
    retries: 3,
    concurrency: { key: "event.data.matchId", limit: 1 },
    triggers: [{ event: "payment/verified" }],
  },
  async ({ event, step }) => {
    const { matchId, phone } = event.data as { matchId: string; phone: string };
    await step.run("settle", () => settleVerifiedPayment(matchId, phone));
  },
);

/** Catches what was left behind while the channel was down: unsent messages and unfinished erasures. */
export const outboundQueue = inngest.createFunction(
  { id: "outbound-queue", concurrency: { limit: 1 }, triggers: [{ cron: "*/2 * * * *" }] },
  async ({ step }) => {
    const erased = await step.run("gateway-erasures", () => drainGatewayEraseQueue());
    const flushed = await step.run("flush", () => flushOutboundQueue());
    return { erased, ...flushed };
  },
);

export const functions = [
  outboundQueue,
  waMessageReceived, embedMessageFn, findMatchesFn, nightlyMatching, matchAdvance, matchExpiry, paymentSettle, callFollowup,
];
