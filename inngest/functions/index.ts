import { inngest } from "@/inngest/client";
import { runAgentTurn } from "@/lib/conversation/agent";
import { flushOutboundQueue, sendQueued, sendToUser } from "@/lib/conversation/outbound";
import { drainGatewayEraseQueue } from "@/lib/safety";
import { askToRetype, embedMessage, handleImage, markProcessed, messageText, preflight, storeMedia, transcribeMessage } from "@/lib/conversation/pipeline";
import { db, schema } from "@/lib/db";
import { closeMatch, advanceMatch, getMatch, type MatchState, transition } from "@/lib/matches";
import { activeUserPhones, findMatches } from "@/lib/matching/find";
import {
  handleFirstPaymentTimeout, handleSecondPaymentTimeout, notifyAfterFirstPayment, sendPaymentInstructions, settleVerifiedPayment, verifiedPayers,
} from "@/lib/payments";
import { audit } from "@/lib/audit";
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

    if (action === "image") {
      let stored = false;
      try {
        stored = await step.run("store-image", () => storeMedia(messageId, "photos"));
      } catch {
        await step.run("image-fallback", async () => sendToUser(phone, await msg("fallback"), { dedupeKey: `fallback-${messageId}` }));
        return { action, stored };
      }
      if (stored) await step.run("handle-image", () => handleImage(messageId));
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
      await step.run("send-reply", () => sendQueued(replyKey));
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

/** One run per match per waiting state: expires it unless the state moves on first. */
export const matchExpiry = inngest.createFunction(
  {
    id: "match-expiry",
    retries: 3,
    triggers: [{ event: "match/state.changed", if: "event.data.state == 'shown_to_a' || event.data.state == 'shown_to_b'" }],
  },
  async ({ event, step }) => {
    const { matchId, state } = event.data as { matchId: string; state: MatchState };
    const seconds = await step.run("timeout", () => getSetting<number>("match_response_timeout_seconds"));
    const changed = await step.waitForEvent("wait-for-change", {
      event: "match/state.changed",
      timeout: `${seconds}s`,
      if: "async.data.matchId == event.data.matchId",
    });
    if (changed) return { expired: false };
    // onlyFrom makes this safe if the state changed just before the wait began.
    const expired = await step.run("expire", () => closeMatch(matchId, "expired", "system", "no_response", undefined, state));
    return { expired };
  },
);

export const paymentFlow = inngest.createFunction(
  { id: "payment-flow", retries: 3, triggers: [{ event: "match/both_interested" }] },
  async ({ event, step }) => {
    const { matchId } = event.data as { matchId: string };

    const timers = await step.run("start", async () => {
      const match = await getMatch(matchId);
      if (!match) return null;
      await transition(matchId, "payment_pending", "system");
      await sendPaymentInstructions(match);
      await audit("system", "payment.instructions_sent", "match", matchId);
      return {
        first: await getSetting<number>("first_payment_timeout_seconds"),
        second: await getSetting<number>("second_payment_timeout_seconds"),
      };
    });
    if (!timers) return { outcome: "missing" };

    const firstEvent = await step.waitForEvent("wait-first-payment", {
      event: "payment/verified",
      timeout: `${timers.first}s`,
      if: "async.data.matchId == event.data.matchId",
    });

    const payer = await step.run("resolve-first-payer", async () => {
      if (firstEvent) return (firstEvent.data as { phone: string }).phone;
      if (await handleFirstPaymentTimeout(matchId)) return null;
      return (await verifiedPayers(matchId))[0] ?? null; // verified just before the wait began
    });
    if (!payer) return { outcome: "expired_no_payment" };

    await step.run("notify-first-payment", async () => {
      const match = await getMatch(matchId);
      if (match?.state !== "payment_pending") return;
      await audit("system", "payment.first_verified", "match", matchId);
      await notifyAfterFirstPayment(match, payer);
    });

    const second = await step.waitForEvent("wait-second-payment", {
      event: "payment/verified",
      timeout: `${timers.second}s`,
      if: `async.data.matchId == event.data.matchId && async.data.phone != '${payer.replace(/[^+\d]/g, "")}'`,
    });
    if (second) return { outcome: "both_paid" }; // payment-settle has released both numbers

    const outcome = await step.run("second-timeout", () => handleSecondPaymentTimeout(matchId, payer));
    return { outcome };
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
  waMessageReceived, embedMessageFn, findMatchesFn, nightlyMatching, matchAdvance, matchExpiry, paymentFlow, paymentSettle,
];
