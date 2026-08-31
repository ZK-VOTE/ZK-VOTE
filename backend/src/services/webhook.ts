import { log } from "./logger.js";
import { SSEEvent, EventType } from "./sse.js";

interface WebhookRegistration {
  id: string;
  url: string;
  eventTypes: Set<EventType>;
  daoIds: Set<string>;
}

class WebhookService {
  private webhooks: Map<string, WebhookRegistration> = new Map();

  public registerWebhook(url: string, eventTypes?: EventType[], daoIds?: string[]): string {
    const id = Math.random().toString(36).substring(2, 15);
    this.webhooks.set(id, {
      id,
      url,
      eventTypes: new Set(eventTypes || []),
      daoIds: new Set(daoIds || []),
    });
    log("info", "webhook_registered", { id, url });
    return id;
  }

  public removeWebhook(id: string) {
    this.webhooks.delete(id);
  }

  public async notifyWebhooks(event: SSEEvent) {
    const deliveries = Array.from(this.webhooks.values()).map(async (webhook) => {
      if (webhook.daoIds.size > 0 && event.daoId && !webhook.daoIds.has(event.daoId)) return;
      if (webhook.eventTypes.size > 0 && !webhook.eventTypes.has(event.type)) return;

      await this.sendWithRetry(webhook.url, event);
    });

    await Promise.allSettled(deliveries);
  }

  private async sendWithRetry(url: string, payload: any, maxRetries = 3) {
    let delay = 1000;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          log("info", "webhook_delivered", { url });
          return;
        }
        throw new Error(`Status ${res.status}`);
      } catch (err) {
        log("warn", "webhook_delivery_failed", { url, attempt: i + 1, error: err instanceof Error ? err.message : String(err) });
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
        }
      }
    }
  }
}

export const webhookService = new WebhookService();
