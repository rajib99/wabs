import { env } from "@/lib/env";
import { MockChannelAdapter } from "./mock";
import { OpenWAAdapter } from "./openwa";
import type { ChannelAdapter } from "./types";
import { WhatsAppCloudAdapter } from "./whatsapp";

export * from "./types";

let adapter: ChannelAdapter | undefined;

export function getChannel(): ChannelAdapter {
  if (!adapter) {
    const channel = env.channel();
    adapter = channel === "whatsapp" ? new WhatsAppCloudAdapter() : channel === "openwa" ? new OpenWAAdapter() : new MockChannelAdapter();
  }
  return adapter;
}
