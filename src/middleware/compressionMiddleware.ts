/**
 * compressionMiddleware.ts
 * -----------------------------------------------------------------------
 * Express middleware for issue #186: API Response Compression and
 * Optimization.
 *
 * Covers:
 *   - gzip AND brotli support, negotiated via Accept-Encoding
 *   - 1KB minimum threshold (skipped when Content-Length is known and small)
 *   - Exclusion of binary endpoints (/ipfs/image/:cid, etc.) and binary
 *     content types
 *   - Correct Vary: Accept-Encoding + Content-Encoding headers
 *   - Works with streaming responses (unknown Content-Length): compression
 *     is applied chunk-by-chunk through a zlib Transform stream rather
 *     than buffering the whole body first
 *   - Per-request compression ratio metrics recorded to compressionMetrics
 *
 * USAGE in your Express app (register EARLY, before route handlers, but
 * after anything that must see the original uncompressed res.write, e.g.
 * response-time loggers that measure raw bytes should go after this):
 *
 *   import { responseCompression } from "./middleware/compressionMiddleware";
 *   app.use(responseCompression());
 * -----------------------------------------------------------------------
 */

import type { Request, Response, NextFunction } from "express";
import * as zlib from "zlib";
import {
  COMPRESSION_THRESHOLD_BYTES,
  isExcludedPath,
  isExcludedContentType,
  negotiateEncoding,
  SupportedEncoding,
} from "./compressionConfig";
import { compressionMetrics } from "./compressionMetrics";

type WriteArgs = [any?, (BufferEncoding | (() => void))?, (() => void)?];

export function responseCompression() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isExcludedPath(req.path)) {
      return next();
    }

    const encoding = negotiateEncoding(req.headers["accept-encoding"] as string | undefined);
    if (encoding === "identity") {
      return next();
    }

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    let decided = false; // have we decided compress-vs-passthrough yet?
    let compressing = false;
    let transform: zlib.Gzip | zlib.BrotliCompress | zlib.Deflate | null = null;

    let uncompressedBytes = 0;
    let compressedBytes = 0;

    const chunkToBuffer = (chunk: any, enc?: string): Buffer | null => {
      if (chunk == null) return null;
      if (Buffer.isBuffer(chunk)) return chunk;
      return Buffer.from(chunk, (enc as BufferEncoding) ?? "utf8");
    };

    /** Decide compress vs. passthrough. Call at most once, before first byte is sent. */
    const decide = () => {
      if (decided) return;
      decided = true;

      const contentType = res.getHeader("content-type") as string | undefined;
      if (isExcludedContentType(contentType)) {
        compressing = false;
        return;
      }

      const contentLengthHeader = res.getHeader("content-length");
      const knownLength =
        contentLengthHeader != null ? Number(contentLengthHeader) : undefined;

      // If we know the length and it's under threshold, don't bother --
      // compression overhead isn't worth it for tiny payloads.
      if (knownLength != null && !Number.isNaN(knownLength) && knownLength < COMPRESSION_THRESHOLD_BYTES) {
        compressing = false;
        return;
      }

      // Unknown length (streaming) or length >= threshold: compress.
      compressing = true;
      transform = createTransform(encoding);

      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.removeHeader("Content-Length"); // length changes once compressed

      transform.on("data", (chunk: Buffer) => {
        compressedBytes += chunk.length;
        originalWrite(chunk);
      });
      transform.on("end", () => {
        recordMetrics();
        originalEnd();
      });
      transform.on("error", (err) => {
        // Fail safe: stop compressing, let the connection close naturally
        // rather than crashing the process on a malformed stream.
        // eslint-disable-next-line no-console
        console.error("[compression] transform stream error:", err);
        originalEnd();
      });
    };

    const recordMetrics = () => {
      if (uncompressedBytes === 0) return;
      compressionMetrics.record({
        path: req.path,
        encoding,
        uncompressedBytes,
        compressedBytes,
        ratio: Number((compressedBytes / uncompressedBytes).toFixed(4)),
        savedBytes: uncompressedBytes - compressedBytes,
      });
    };

    res.write = ((chunk?: any, encArg?: any, cb?: any): boolean => {
      decide();
      const buf = chunkToBuffer(chunk, typeof encArg === "string" ? encArg : undefined);
      if (buf) uncompressedBytes += buf.length;

      if (!compressing) {
        return originalWrite(chunk, encArg, cb);
      }
      if (buf) transform!.write(buf);
      if (typeof encArg === "function") encArg();
      else if (typeof cb === "function") cb();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: any, encArg?: any, cb?: any): Response => {
      decide();
      const buf = chunkToBuffer(chunk, typeof encArg === "string" ? encArg : undefined);
      if (buf) uncompressedBytes += buf.length;

      if (!compressing) {
        recordMetricsIfPassthroughWasActuallySkippedButStillTracked();
        return originalEnd(chunk, encArg, cb);
      }

      if (buf) transform!.end(buf);
      else transform!.end();
      // originalEnd() is invoked by the transform's 'end' listener above,
      // once all compressed bytes have flushed.
      return res;
    }) as typeof res.end;

    // When compression was skipped (tiny/excluded payload), we still want
    // a metrics entry showing 1:1 ratio for visibility in aggregate stats.
    function recordMetricsIfPassthroughWasActuallySkippedButStillTracked() {
      if (decided && !compressing && uncompressedBytes > 0) {
        compressionMetrics.record({
          path: req.path,
          encoding: "identity",
          uncompressedBytes,
          compressedBytes: uncompressedBytes,
          ratio: 1,
          savedBytes: 0,
        });
      }
    }

    next();
  };
}

function createTransform(encoding: SupportedEncoding): zlib.Gzip | zlib.BrotliCompress | zlib.Deflate {
  switch (encoding) {
    case "br":
      return zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5, // balance speed vs ratio for API responses
        },
      });
    case "gzip":
      return zlib.createGzip();
    case "deflate":
      return zlib.createDeflate();
    default:
      // Should be unreachable -- negotiateEncoding never returns anything
      // else when this function is called.
      return zlib.createGzip();
  }
}
