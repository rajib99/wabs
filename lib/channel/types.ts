export type InboundMessage = {
  waMessageId: string;
  /** Set only by the channel's own phone-sharing control (Messenger's quick reply), never from typed text. */
  sharedPhone?: string;
  phone: string; // E.164 with leading +
  type: "text" | "voice" | "image" | "other";
  text?: string;
  mediaId?: string;
  mediaMime?: string;
  timestamp: Date;
};

export type StatusUpdate = {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
};

export type ReceivedPayload = { messages: InboundMessage[]; statuses: StatusUpdate[] };
export type SendResult = { waMessageId: string };
export type MediaFile = { bytes: Uint8Array; mime: string };

export class MediaTooLargeError extends Error {}

/** The channel refused this send for a reason retrying cannot fix (policy, window, unreachable person). */
export class PermanentSendError extends Error {}

export interface ChannelAdapter {
  /** True when free-form text is only allowed within 24 hours of the user's last message (Meta's rule). */
  readonly enforcesServiceWindow: boolean;
  /** Settings key mapping logical template names to this channel's approved templates. Defaults to "templates". */
  readonly templateSettingKey?: string;
  /** Asks for a contact number using the channel's own sharing control. Absent when the identity already is one. */
  requestPhone?(to: string, text: string): Promise<SendResult>;
  /** Normalizes a channel payload. Does no I/O. */
  receiveMessage(payload: unknown): ReceivedPayload;
  sendText(to: string, text: string): Promise<SendResult>;
  sendImage(to: string, image: MediaFile, caption?: string): Promise<SendResult>;
  sendTemplate(to: string, template: string, language: string, params: string[]): Promise<SendResult>;
  downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile>;
  /** Removes any copy of the conversation the channel keeps on our side. Absent when it keeps none. */
  eraseConversation?(phone: string): Promise<void>;
}
