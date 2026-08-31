/**
 * OpenAPI Specification for ZKVote Backend
 * Documents all routes including audit and remediation for accountability.
 * Scope: middleware/audit.ts, routes/*, openapi.ts
 */
export declare const openApiSpec: {
    readonly openapi: "3.0.3";
    readonly info: {
        readonly title: "ZKVote Relayer API";
        readonly version: "1.0.0";
        readonly description: "Anonymous voting relayer with full audit trail and incident response";
    };
    readonly servers: readonly [{
        readonly url: "http://localhost:3001";
        readonly description: "Local";
    }];
    readonly security: readonly [{
        readonly bearerAuth: readonly [];
    }];
    readonly components: {
        readonly securitySchemes: {
            readonly bearerAuth: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "JWT";
            };
            readonly relayerAuth: {
                readonly type: "apiKey";
                readonly in: "header";
                readonly name: "X-Relayer-Auth";
            };
        };
        readonly schemas: {
            readonly VoteRequest: {
                readonly type: "object";
                readonly required: readonly ["daoId", "proposalId", "choice", "nullifier", "root", "proof"];
                readonly properties: {
                    readonly daoId: {
                        readonly type: "integer";
                    };
                    readonly proposalId: {
                        readonly type: "integer";
                    };
                    readonly choice: {
                        readonly type: "boolean";
                    };
                    readonly nullifier: {
                        readonly type: "string";
                        readonly description: "BN254 field element hex < modulus (redacted in audit)";
                    };
                    readonly root: {
                        readonly type: "string";
                        readonly description: "Merkle root hex (redacted in audit)";
                    };
                    readonly proof: {
                        readonly type: "object";
                        readonly description: "Groth16 proof (redacted in audit)";
                        readonly properties: {
                            readonly a: {
                                readonly type: "string";
                            };
                            readonly b: {
                                readonly type: "string";
                            };
                            readonly c: {
                                readonly type: "string";
                            };
                        };
                    };
                };
            };
            readonly AuditEntry: {
                readonly type: "object";
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly timestamp: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly requestId: {
                        readonly type: "string";
                    };
                    readonly method: {
                        readonly type: "string";
                    };
                    readonly path: {
                        readonly type: "string";
                    };
                    readonly action: {
                        readonly type: "string";
                    };
                    readonly actor: {
                        readonly type: "string";
                        readonly description: "Hashed actor identifier (PII redacted)";
                    };
                    readonly statusCode: {
                        readonly type: "integer";
                    };
                    readonly immutable: {
                        readonly type: "boolean";
                        readonly enum: readonly [true];
                    };
                };
            };
            readonly RemediationAction: {
                readonly type: "object";
                readonly required: readonly ["action", "target", "reason", "idempotencyKey"];
                readonly properties: {
                    readonly action: {
                        readonly type: "string";
                        readonly enum: readonly ["freeze_dao", "unfreeze_dao", "pause_voting", "resume_voting", "revoke_member", "restore_member", "emergency_pause", "emergency_resume", "rotate_vk", "quarantine_proposal"];
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly description: "DAO or proposal identifier";
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 5;
                    };
                    readonly idempotencyKey: {
                        readonly type: "string";
                        readonly minLength: 8;
                        readonly description: "Replay protection - duplicate keys return 409";
                    };
                    readonly metadata: {
                        readonly type: "object";
                        readonly additionalProperties: true;
                    };
                };
            };
        };
    };
    readonly paths: {
        readonly "/vote": {
            readonly post: {
                readonly summary: "Submit anonymous vote (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly requestBody: {
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/VoteRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly "200": {
                        readonly description: "Vote submitted";
                    };
                    readonly "401": {
                        readonly description: "Unauthorized";
                    };
                };
                readonly "x-audited": true;
                readonly "x-redacted-fields": readonly ["nullifier", "root", "proof"];
            };
        };
        readonly "/comment/anonymous": {
            readonly post: {
                readonly summary: "Anonymous comment (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
                readonly "x-redacted-fields": readonly ["nullifier", "root", "proof"];
            };
        };
        readonly "/comment/edit": {
            readonly post: {
                readonly summary: "Edit comment (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/comment/delete": {
            readonly post: {
                readonly summary: "Delete comment (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/bridge/vote": {
            readonly post: {
                readonly summary: "Bridge vote (audited)";
                readonly "x-audited": true;
                readonly "x-redacted-fields": readonly ["nullifier", "voteRoot", "sbtRoot", "proof"];
            };
        };
        readonly "/bridge/relay": {
            readonly post: {
                readonly summary: "Manual relay (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/ipfs/image": {
            readonly post: {
                readonly summary: "Upload image (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/ipfs/metadata": {
            readonly post: {
                readonly summary: "Upload metadata (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/daos/sync": {
            readonly post: {
                readonly summary: "Sync DAOs (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/events": {
            readonly post: {
                readonly summary: "Manual event (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/events/notify": {
            readonly post: {
                readonly summary: "Notify event (audited)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly "x-audited": true;
            };
        };
        readonly "/remediation/action": {
            readonly post: {
                readonly summary: "Structured remediation action (append-only, authz, replay-safe)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly requestBody: {
                    readonly content: {
                        readonly "application/json": {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/RemediationAction";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly "201": {
                        readonly description: "Recorded";
                    };
                    readonly "409": {
                        readonly description: "Duplicate idempotencyKey";
                    };
                    readonly "401": {
                        readonly description: "Unauthorized";
                    };
                };
                readonly "x-audited": true;
                readonly "x-append-only": true;
                readonly "x-replay-safe": true;
            };
        };
        readonly "/remediation/log": {
            readonly get: {
                readonly summary: "Query remediation log";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "action";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "target";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "limit";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                    };
                }, {
                    readonly name: "offset";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                    };
                }];
                readonly responses: {
                    readonly "200": {
                        readonly description: "Log entries";
                    };
                };
            };
        };
        readonly "/audit/logs": {
            readonly get: {
                readonly summary: "Query audit logs (redacted, authz)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "action";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "actor";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "method";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "from";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                }, {
                    readonly name: "to";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                }, {
                    readonly name: "limit";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                    };
                }, {
                    readonly name: "offset";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                    };
                }];
                readonly responses: {
                    readonly "200": {
                        readonly description: "Audit entries";
                    };
                };
                readonly "x-redacted": true;
            };
        };
        readonly "/audit/export": {
            readonly get: {
                readonly summary: "Export audit logs (json/csv)";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "format";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                        readonly enum: readonly ["json", "csv"];
                    };
                }];
                readonly responses: {
                    readonly "200": {
                        readonly description: "Exported logs";
                    };
                };
            };
        };
        readonly "/audit/stats": {
            readonly get: {
                readonly summary: "Audit statistics";
                readonly security: readonly [{
                    readonly relayerAuth: readonly [];
                }];
                readonly responses: {
                    readonly "200": {
                        readonly description: "Stats";
                    };
                };
            };
        };
    };
    readonly "x-audit": {
        readonly description: "All mutating routes are audited with PII redaction. 100% coverage via global auditMiddleware.";
        readonly mutatingRoutes: readonly ["POST /vote", "POST /comment/anonymous", "POST /comment/edit", "POST /comment/delete", "POST /bridge/vote", "POST /bridge/relay", "POST /ipfs/image", "POST /ipfs/metadata", "POST /daos/sync", "POST /events", "POST /events/notify", "POST /remediation/action"];
        readonly redaction: "proof, nullifier, root, commitment, secret, token, password, jwt always redacted";
        readonly immutable: "audit logs and remediation logs are append-only, no update/delete APIs";
        readonly replaySafe: "remediation uses idempotencyKey; duplicates return 409";
    };
};
export default openApiSpec;
//# sourceMappingURL=openapi.d.ts.map