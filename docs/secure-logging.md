# Secure Logging with PII Redaction

## Overview
This document describes the PII redaction and secure logging system.

## Redaction Policy

### Field-Based Redaction
The following fields are automatically redacted:
- proof
- nullifier
- commitment
- secret
- token
- password
- jwt
- refresh_token
- access_token
- api_key
- private_key
- seed
- mnemonic

### Pattern-Based Redaction
- Stellar Address (G...): Show first 4 + last 4 chars
- Stellar Secret (S...): Full redaction
- IP Addresses: Replaced with [REDACTED_IP]
- Transaction Hashes: Show first 6 + last 6 chars
- IPFS CIDs: Show first 6 + last 6 chars

### Log-Level Redaction
- trace: Minimal redaction
- debug: Partial redaction
- info: Full redaction (default)
- warn: Full redaction
- error: Full redaction

## Configuration

Environment Variables:
- LOG_LEVEL: Minimum log level (default: info)
- NODE_ENV: Environment (default: development)
- SERVICE_NAME: Service name (default: relayer)
- LOG_SAMPLE_RATE: Trace sampling rate in [0, 1] (default: 1). Requests are
  sampled deterministically by trace ID, so an entire request (start, end,
  and every nested log line) is either fully kept or fully dropped. Set to
  e.g. 0.1 to keep 10% of high-volume traffic.

## Correlation IDs

Every HTTP request gets a correlation ID (`ctx`) and a W3C trace ID
(`traceId`, propagated via the `traceparent` header). The request logging
middleware runs the downstream chain inside an AsyncLocalStorage context, so
**every** log call made by routes, services, or async work spawned from the
request automatically carries the same `ctx` and `traceId` fields - no manual
threading required.

- Correlation context: `runWithContext({ ctx, traceId, path, method }, fn)`
- Read active context: `getRequestContext()`
- Sampling: `setLogSampleRate(rate)` / `getLogSampleRate()`

## Usage

Basic Logging:
import { logger } from "../services/logger.js";
logger.info("user_vote_cast", { voter: stellarAddress, dao: daoId });

Background jobs outside a request context log without correlation fields;
pass `ctx`/`traceId` explicitly in meta when correlating to a prior request.

Error Logging:
try {
  // ...
} catch (error) {
  logger.error("operation_failed", { error: error.message });
}

Custom Policy:
import { setRedactionPolicy } from "../services/logger.js";
setRedactionPolicy({ redactedFields: ["custom_field"], showClientIp: "hash" });

## Testing
npm test -- logger.test.ts

## GDPR Compliance
- PII is automatically redacted
- Stellar addresses are partially redacted
- IP addresses are hashed or redacted
- No sensitive data in production logs
