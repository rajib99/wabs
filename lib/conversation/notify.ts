import { eq } from "drizzle-orm";
import { getChannel } from "@/lib/channel";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isClosed, visibleMatches } from "@/lib/matches";
import { pendingContactStep } from "./contact";
import { notificationTopics, tokenHistory } from "./notification-tokens";
import { sendToUser, type SendOutcome } from "./outbound";

/** Messenger caps the opt-in card's title at 65 characters. */
const TITLE_MAX = 65;

/** True while the person has answered a proposal and is waiting on the other side, a payment or a release. */
async function waitingOnProposal(phone: string): Promise<boolean> {
  return (await visibleMatches(phone)).some((m) => {
    if (isClosed(m.state)) return false;
    const yourTurn = (m.userA === phone && m.state === "shown_to_a") || (m.userB === phone && m.state === "shown_to_b");
    return !yourTurn;
  });
}

/**
 * At a natural pause (onboarding done, or a proposal answered), asks once whether we may message the person later.
 * One card per turn, for the first topic with no live token, and never twice for the same token: an ignored
 * request is not repeated until the person has given and spent a token.
 */
export async function askForNotifications(phone: string): Promise<SendOutcome | "none"> {
  const channel = getChannel();
  if (!channel.requestNotification || !channel.enforcesServiceWindow) return "none";
  const d = db();
  const [user] = await d.select().from(schema.users).where(eq(schema.users.phone, phone));
  if (!user || user.status !== "active" || user.blocked || !user.profileComplete || pendingContactStep(user)) return "none";

  const topics = await notificationTopics();
  const wanted = ["new_proposal", ...((await waitingOnProposal(phone)) ? ["proposal_update"] : [])];
  const now = Date.now();
  for (const topic of wanted) {
    const cfg = topics[topic];
    if (!cfg?.enabled || !cfg.title.trim()) continue;
    const history = await tokenHistory(phone, topic);
    if (history.some((t) => !t.usedAt && t.expiresAt.getTime() > now)) continue;
    const dedupeKey = `otnreq-${topic}-${phone}-${history.length}`;
    const [asked] = await d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.dedupeKey, dedupeKey));
    if (asked) continue;
    try {
      return await sendToUser(phone, cfg.title.trim().slice(0, TITLE_MAX), { dedupeKey, notificationRequest: topic });
    } catch (err) {
      // Optional, so never worth a retry; and it must not sit in the outbound queue, which would send it as text.
      logger.warn({ err }, "notification opt-in request failed");
      await d.update(schema.messages).set({ status: "failed", statusAt: new Date() }).where(eq(schema.messages.dedupeKey, dedupeKey));
      return "failed";
    }
  }
  return "none";
}
