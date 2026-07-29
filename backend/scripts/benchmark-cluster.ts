/**
 * Clustering Throughput Benchmark Script
 *
 * Measures request throughput (req/sec), latency, and concurrency
 * handling across single-worker vs multi-worker clustered configurations.
 *
 * Usage:
 *   npx tsx scripts/benchmark-cluster.ts [durationSec] [concurrency]
 */

import http from "node:http";
import { config } from "../src/config.js";

const DURATION_SEC = Number(process.argv[2] || 5);
const CONCURRENCY = Number(process.argv[3] || 10);
const PORT = config.port || 3001;
const TARGET_URL = `http://localhost:${PORT}/health`;

export interface BenchmarkMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  durationMs: number;
  requestsPerSec: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export function runBenchmark(
  url: string = TARGET_URL,
  durationSec: number = DURATION_SEC,
  concurrency: number = CONCURRENCY,
): Promise<BenchmarkMetrics> {
  return new Promise((resolve) => {
    console.log(`Starting cluster benchmark against ${url}...`);
    console.log(`Duration: ${durationSec}s | Concurrency: ${concurrency}`);

    const latencies: number[] = [];
    let completedRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;

    let activeWorkerCount = 0;

    function sendRequest() {
      if (Date.now() >= endTime) {
        activeWorkerCount--;
        if (activeWorkerCount === 0) {
          finishBenchmark();
        }
        return;
      }

      const reqStart = Date.now();
      const req = http.get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const reqLatency = Date.now() - reqStart;
          latencies.push(reqLatency);
          completedRequests++;

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            successfulRequests++;
          } else {
            failedRequests++;
          }

          setImmediate(sendRequest);
        });
      });

      req.on("error", () => {
        failedRequests++;
        completedRequests++;
        setImmediate(sendRequest);
      });

      req.end();
    }

    function finishBenchmark() {
      const totalDurationMs = Date.now() - startTime;
      const rps = totalDurationMs > 0 ? (completedRequests / totalDurationMs) * 1000 : 0;
      latencies.sort((a, b) => a - b);

      const avgLatency =
        latencies.length > 0
          ? latencies.reduce((acc, l) => acc + l, 0) / latencies.length
          : 0;

      const p95Index = Math.floor(latencies.length * 0.95);
      const p95Latency = latencies.length > 0 ? latencies[p95Index] || latencies[latencies.length - 1] : 0;

      const metrics: BenchmarkMetrics = {
        totalRequests: completedRequests,
        successfulRequests,
        failedRequests,
        durationMs: totalDurationMs,
        requestsPerSec: Math.round(rps * 100) / 100,
        avgLatencyMs: Math.round(avgLatency * 100) / 100,
        p95LatencyMs: p95Latency,
      };

      console.log("\n================ Benchmark Results ================");
      console.log(`Total Requests:      ${metrics.totalRequests}`);
      console.log(`Successful Requests: ${metrics.successfulRequests}`);
      console.log(`Failed Requests:     ${metrics.failedRequests}`);
      console.log(`Duration:            ${(metrics.durationMs / 1000).toFixed(2)}s`);
      console.log(`Throughput (RPS):    ${metrics.requestsPerSec} req/sec`);
      console.log(`Avg Latency:         ${metrics.avgLatencyMs} ms`);
      console.log(`P95 Latency:         ${metrics.p95LatencyMs} ms`);
      console.log("===================================================\n");

      resolve(metrics);
    }

    for (let i = 0; i < concurrency; i++) {
      activeWorkerCount++;
      sendRequest();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmark();
}
