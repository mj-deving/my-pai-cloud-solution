// status-message.ts — Rate-limited editable Telegram status message manager
// Lifecycle: init(text) → update(text) (repeated) → finish(text) or remove()
// Rate-limits edits to avoid Telegram API throttling.

import type { MessengerAdapter, StatusMessageHandle } from "./messenger-adapter";

export class StatusMessage {
  private handle: StatusMessageHandle | null = null;
  private disposed = false;
  private lastEditTime = 0;
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private messenger: MessengerAdapter,
    private editIntervalMs: number = 2500,
  ) {}

  /** Send the initial status message. */
  async init(text: string): Promise<void> {
    if (this.disposed) return;
    try {
      this.handle = await this.messenger.sendStatusMessage(text);
      this.lastEditTime = Date.now();
    } catch (err) {
      console.warn(`[status-message] init error: ${err}`);
    }
  }

  /** Update the status message (rate-limited). */
  update(text: string): void {
    if (this.disposed || !this.handle) return;

    const elapsed = Date.now() - this.lastEditTime;
    if (elapsed >= this.editIntervalMs) {
      // Enough time passed — edit immediately
      this.doEdit(text);
    } else {
      // Queue the latest text — only the most recent update matters
      this.pendingText = text;
      if (!this.pendingTimer) {
        const delay = this.editIntervalMs - elapsed;
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          if (this.pendingText && !this.disposed && this.handle) {
            this.doEdit(this.pendingText);
            this.pendingText = null;
          }
        }, delay);
      }
    }
  }

  /** Edit the status message to a final state (bypasses rate limit). */
  async finish(text: string): Promise<void> {
    this.clearPending();
    if (this.disposed || !this.handle) return;
    this.disposed = true;
    try {
      await this.messenger.editMessage(this.handle.messageId, text);
    } catch (err) {
      console.warn(`[status-message] finish error: ${err}`);
    }
  }

  /** Delete the status message entirely. */
  async remove(): Promise<void> {
    this.clearPending();
    if (this.disposed || !this.handle) return;
    this.disposed = true;
    try {
      await this.messenger.deleteMessage(this.handle.messageId);
    } catch (err) {
      console.warn(`[status-message] remove error: ${err}`);
    }
  }

  private doEdit(text: string): void {
    if (!this.handle || this.disposed) return;
    this.lastEditTime = Date.now();
    this.messenger.editMessage(this.handle.messageId, text).catch((err) => {
      console.warn(`[status-message] edit error: ${err}`);
    });
  }

  private clearPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;
  }
}
