import { Request, Response } from "express";
export type EventType = "VOTE_CAST" | "PROPOSAL_UPDATED" | "DAO_UPDATED" | "ELECTION_STATUS" | "COMMENT_POSTED" | "HEARTBEAT";
export interface SSEEvent {
    type: EventType;
    daoId?: string;
    data: any;
}
declare class SSEService {
    private clients;
    private ipConnectionCounts;
    private heartbeatInterval;
    constructor();
    handleConnection(req: Request, res: Response): void;
    broadcast(event: SSEEvent): void;
    private startHeartbeat;
    stop(): void;
}
export declare const sseService: SSEService;
export {};
//# sourceMappingURL=sse.d.ts.map