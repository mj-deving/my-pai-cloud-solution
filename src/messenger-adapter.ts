// messenger-adapter.ts — Platform-agnostic messenger interface (Phase 1: Pipeline Hardening)
// Any messenger (Telegram, Discord, email, etc.) implements this interface.
// Bridge.ts depends on MessengerAdapter, not on Grammy/Telegram directly.

export interface MessageOptions {
  parseMode?: "Markdown" | "HTML";
}

export interface StatusMessageHandle {
  messageId: number;
}

export type CommandHandler = (args: string) => Promise<void>;
export type MessageHandler = (text: string) => Promise<void>;

/**
 * Platform-agnostic messenger adapter.
 * Implementations: TelegramAdapter (Phase 1), future: DiscordAdapter, EmailAdapter.
 */
export interface MessengerAdapter {
  /** Send a message to the authenticated user. */
  sendDirectMessage(text: string, options?: MessageOptions): Promise<void>;

  /** Send a status message (returns handle for editing/deleting). */
  sendStatusMessage(text: string, options?: MessageOptions): Promise<StatusMessageHandle>;

  /** Edit an existing message by ID. */
  editMessage(messageId: number, text: string, options?: MessageOptions): Promise<void>;

  /** Delete a message by ID. */
  deleteMessage(messageId: number): Promise<void>;

  /** Show typing/processing indicator. */
  sendTypingIndicator(): Promise<void>;

  /** Register a command handler (e.g., /start, /status). */
  registerCommand(command: string, handler: CommandHandler): void;

  /** Register a handler for plain text messages. */
  registerMessageHandler(handler: MessageHandler): void;

  /** Start the messenger (begin listening for messages). */
  start(): Promise<void>;

  /** Stop the messenger gracefully. */
  stop(): void;

  /** Get the authenticated user's ID. */
  getUserId(): string | number;

  /** Get the maximum message size for this platform. */
  getMaxMessageSize(): number;
}
