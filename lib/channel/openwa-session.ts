import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { OpenWAAdapter, type SessionEvent } from "./openwa";

const WEBHOOK_EVENTS = ["message.received", "message.ack", "message.failed", "session.status", "session.disconnected", "session.reconnect_loop", "session.restriction"];

export type SessionState = {
  reachable: boolean;
  exists: boolean;
  status: string | null;
  phone: string | null;
  lastError: string | null;
  restriction: { kind?: string; expiresAt?: string | null } | null;
};

type Session = { id: string; name: string; status: string; phone?: string | null; lastError?: string | null; restriction?: SessionState["restriction"] };

const api = () => new OpenWAAdapter();

async function findSession(): Promise<Session | undefined> {
  const res = await api().request("GET", "/api/sessions");
  if (!res.ok) throw new Error(`OpenWA session list failed: ${res.status}`);
  const name = env.openwa().OPENWA_SESSION;
  return ((await res.json()) as Session[]).find((s) => s.name === name);
}

export async function sessionState(): Promise<SessionState> {
  try {
    const s = await findSession();
    return {
      reachable: true, exists: !!s, status: s?.status?.toLowerCase() ?? null, phone: s?.phone ?? null,
      lastError: s?.lastError ?? null, restriction: s?.restriction ?? null,
    };
  } catch (err) {
    logger.warn({ err }, "OpenWA unreachable");
    return { reachable: false, exists: false, status: null, phone: null, lastError: null, restriction: null };
  }
}

/** Idempotent: creates the session if needed, makes sure our webhook is registered, and starts it. */
export async function connectSession(): Promise<void> {
  const cfg = env.openwa();
  const client = api();
  let session = await findSession();
  if (!session) {
    const res = await client.request("POST", "/api/sessions", { name: cfg.OPENWA_SESSION });
    if (!res.ok) throw new Error(`OpenWA session create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    session = (await res.json()) as Session;
  }
  const base = `/api/sessions/${encodeURIComponent(session.id)}`;

  const hooksRes = await client.request("GET", `${base}/webhooks`);
  if (!hooksRes.ok) throw new Error(`OpenWA webhook list failed: ${hooksRes.status}`);
  const hooks = (await hooksRes.json()) as { id: string; url: string }[];
  const existing = hooks.find((h) => h.url === cfg.OPENWA_WEBHOOK_URL);
  const hookBody = { url: cfg.OPENWA_WEBHOOK_URL, events: WEBHOOK_EVENTS, secret: cfg.OPENWA_WEBHOOK_SECRET };
  const hookRes = existing
    ? await client.request("PUT", `${base}/webhooks/${encodeURIComponent(existing.id)}`, hookBody)
    : await client.request("POST", `${base}/webhooks`, hookBody);
  if (!hookRes.ok) throw new Error(`OpenWA webhook registration failed: ${hookRes.status} ${(await hookRes.text()).slice(0, 200)}`);

  if (session.status?.toLowerCase() !== "ready") {
    const start = await client.request("POST", `${base}/start`);
    // Already starting or running is fine.
    if (!start.ok && start.status !== 400 && start.status !== 409) {
      throw new Error(`OpenWA session start failed: ${start.status} ${(await start.text()).slice(0, 200)}`);
    }
  }
}

export async function currentQr(): Promise<string | null> {
  const session = await findSession();
  if (!session) return null;
  const res = await api().request("GET", `/api/sessions/${encodeURIComponent(session.id)}/qr`);
  if (!res.ok) return null;
  return ((await res.json()) as { qrCode?: string }).qrCode ?? null;
}

export async function disconnectSession(): Promise<void> {
  const session = await findSession();
  if (!session) return;
  const res = await api().request("POST", `/api/sessions/${encodeURIComponent(session.id)}/logout`);
  if (!res.ok) throw new Error(`OpenWA logout failed: ${res.status}`);
}

/** Session trouble must be visible: a restriction can precede a ban, so it is logged loudly and audited. */
export async function recordSessionEvent(e: SessionEvent) {
  const serious = e.event === "session.disconnected" || e.event === "session.reconnect_loop" || (e.event === "session.restriction" && e.active);
  if (serious) logger.error({ sessionEvent: e }, "WhatsApp session problem");
  else logger.info({ sessionEvent: e }, "WhatsApp session event");
  await audit("openwa", e.event, "session", env.openwa().OPENWA_SESSION, e);
}
