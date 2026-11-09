import { randomUUID } from "node:crypto";
import { getStorage } from "@/lib/storage";
import { type ChannelAdapter, type MediaFile, MediaTooLargeError, type ReceivedPayload } from "./types";

export const mockMediaKey = (mediaId: string) => `mock-inbound/${mediaId}`;

/** Outbound messages are recorded by the outbound service; the simulator reads them from the database. */
export class MockChannelAdapter implements ChannelAdapter {
  // Behaves like the Cloud API so the simulator exercises the 24-hour rule.
  readonly enforcesServiceWindow = true;

  receiveMessage(payload: unknown): ReceivedPayload {
    return payload as ReceivedPayload;
  }
  private result() {
    return Promise.resolve({ waMessageId: `mock-out-${randomUUID()}` });
  }
  sendText() { return this.result(); }
  sendImage() { return this.result(); }
  sendTemplate() { return this.result(); }
  async downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile> {
    const file = await getStorage().get(mockMediaKey(mediaId));
    if (file.bytes.byteLength > maxBytes) throw new MediaTooLargeError();
    return file;
  }
}
