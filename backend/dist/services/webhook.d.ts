import { SSEEvent, EventType } from "./sse.js";
declare class WebhookService {
    private webhooks;
    registerWebhook(url: string, eventTypes?: EventType[], daoIds?: string[]): string;
    removeWebhook(id: string): void;
    notifyWebhooks(event: SSEEvent): Promise<void>;
    private sendWithRetry;
}
export declare const webhookService: WebhookService;
export {};
//# sourceMappingURL=webhook.d.ts.map