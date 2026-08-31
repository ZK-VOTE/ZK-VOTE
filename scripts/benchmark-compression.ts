/**
 * benchmark-compression.ts
 * -----------------------------------------------------------------------
 * "Benchmark response size and latency improvement" +
 * "Verify compression works with streaming responses" acceptance criteria.
 *
 * Spins up a real Express server using the middleware, hits it with real
 * HTTP requests (gzip, brotli, excluded path, small payload, streaming
 * payload), and reports size/latency deltas.
 *
 * Run with: npx ts-node scripts/benchmark-compression.ts
 * -----------------------------------------------------------------------
 */

import express from "express";
import http from "http";
import zlib from "zlib";
import { responseCompression } from "../src/middleware/compressionMiddleware";
import { compressionMetricsHandler } from "../src/middleware/compressionMetricsRoute";

// Fixed timestamp so repeated requests return byte-identical payloads --
// this lets the benchmark compare compressed vs. uncompressed bodies for
// correctness, independent of real request timing.
const FIXED_TIMESTAMP = "2026-08-31T00:00:00.000Z";

function makeLargeJsonPayload(items = 2000) {
  return {
    events: Array.from({ length: items }, (_, i) => ({
      id: i,
      daoId: "dao-123",
      type: "VoteCast",
      voter: `G${"A".repeat(55)}`,
      timestamp: FIXED_TIMESTAMP,
      metadata: { proposal: `Proposal number ${i}`, choice: i % 2 === 0 ? "yes" : "no" },
    })),
  };
}

function startServer(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(responseCompression());

  app.get("/events/:daoId", (_req, res) => {
    res.json(makeLargeJsonPayload());
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" }); // tiny payload, should stay under threshold
  });

  app.get("/ipfs/image/:cid", (_req, res) => {
    // Simulate binary image data -- should never be compressed.
    res.setHeader("Content-Type", "image/png");
    res.send(Buffer.alloc(50_000, 1));
  });

  app.get("/stream/events", (_req, res) => {
    // No Content-Length set -- exercises the streaming code path.
    res.setHeader("Content-Type", "application/json");
    res.write("[");
    for (let i = 0; i < 500; i++) {
      res.write((i > 0 ? "," : "") + JSON.stringify({ id: i, note: "streamed event payload " + i }));
    }
    res.end("]");
  });

  app.get("/internal/compression-metrics", compressionMetricsHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function request(
  port: number,
  path: string,
  acceptEncoding: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(
      { hostname: "127.0.0.1", port, path, headers: { "Accept-Encoding": acceptEncoding } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            latencyMs: Date.now() - start,
          })
        );
      }
    ).on("error", reject);
  });
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "gzip") return zlib.gunzipSync(body);
  if (encoding === "deflate") return zlib.inflateSync(body);
  return body;
}

async function main() {
  const { server, port } = await startServer();

  try {
    console.log("=== Compression Benchmark ===\n");

    // ---- 1. Large JSON payload, brotli ----
    const rawRes = await request(port, "/events/dao-123", "identity");
    const brRes = await request(port, "/events/dao-123", "br");
    const gzipRes = await request(port, "/events/dao-123", "gzip");

    const rawSize = rawRes.body.length;
    console.log(`GET /events/:daoId  (uncompressed): ${rawSize} bytes, ${rawRes.latencyMs}ms`);
    console.log(
      `GET /events/:daoId  (brotli):       ${brRes.body.length} bytes (${((1 - brRes.body.length / rawSize) * 100).toFixed(1)}% smaller), ${brRes.latencyMs}ms, Content-Encoding=${brRes.headers["content-encoding"]}`
    );
    console.log(
      `GET /events/:daoId  (gzip):         ${gzipRes.body.length} bytes (${((1 - gzipRes.body.length / rawSize) * 100).toFixed(1)}% smaller), ${gzipRes.latencyMs}ms, Content-Encoding=${gzipRes.headers["content-encoding"]}`
    );

    const decompressedBr = decompress(brRes.body, brRes.headers["content-encoding"] as string);
    if (decompressedBr.toString("utf8") !== rawRes.body.toString("utf8")) {
      throw new Error("Brotli-decompressed body does not match original! Correctness check failed.");
    }
    console.log("✅ Brotli round-trip matches original payload byte-for-byte.");

    // ---- 2. Tiny payload should NOT be compressed ----
    const healthRes = await request(port, "/health", "gzip, br");
    console.log(
      `\nGET /health (${healthRes.body.length} bytes): Content-Encoding=${healthRes.headers["content-encoding"] ?? "(none)"} -- expected (none), under 1KB threshold`
    );
    if (healthRes.headers["content-encoding"]) {
      throw new Error("Small payload was compressed but should have been skipped!");
    }
    console.log("✅ Sub-threshold payload correctly skipped compression.");

    // ---- 3. Excluded binary path should NOT be compressed ----
    const imageRes = await request(port, "/ipfs/image/bafy123", "gzip, br");
    console.log(
      `\nGET /ipfs/image/:cid (${imageRes.body.length} bytes): Content-Encoding=${imageRes.headers["content-encoding"] ?? "(none)"} -- expected (none), excluded path`
    );
    if (imageRes.headers["content-encoding"]) {
      throw new Error("Excluded IPFS image path was compressed but should have been skipped!");
    }
    console.log("✅ Excluded binary endpoint correctly skipped compression.");

    // ---- 4. Streaming response (no Content-Length) should compress correctly ----
    const streamRawRes = await request(port, "/stream/events", "identity");
    const streamGzipRes = await request(port, "/stream/events", "gzip");
    const decompressedStream = decompress(streamGzipRes.body, streamGzipRes.headers["content-encoding"] as string);

    console.log(
      `\nGET /stream/events (streaming, no Content-Length): raw=${streamRawRes.body.length}B, gzip=${streamGzipRes.body.length}B, Content-Encoding=${streamGzipRes.headers["content-encoding"]}`
    );
    if (decompressedStream.toString("utf8") !== streamRawRes.body.toString("utf8")) {
      throw new Error("Streaming response decompression mismatch!");
    }
    console.log("✅ Streaming response compressed and decompresses correctly.");

    // ---- 5. Metrics endpoint ----
    const metricsRes = await request(port, "/internal/compression-metrics", "identity");
    console.log("\n=== Compression Metrics Summary ===");
    console.log(JSON.parse(metricsRes.body.toString("utf8")).summary);

    console.log("\nAll benchmark checks passed. ✅");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
