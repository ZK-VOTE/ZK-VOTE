/**
 * Magic byte detection for image uploads.
 * Provides MIME detection, dimension extraction, and basic polyglot/script checks.
 */

export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  const hex4 = buffer.toString("hex", 0, 4);

  // JPAE
  if (hex4.startsWith("ffd8ff")) return "image/jpeg";

  // PNG
  if (hex4 === "89504e47") return "image/png";

  // GIF
  if (hex4 === "47494638") return "image/gif";

  // WebP
  if (hex4 === "52494646" && buffer.length >= 12) {
    const webpStr = buffer.toString("utf8", 8, 12);
    if (webpStr === "WEBP") return "image/webp";
  }

  // BMP
  if (buffer.toString("utf8", 0, 2) === "BM") return "image/bmp";

  // TIFF
  if (hex4 === "49492a00" || hex4 === "4d4d002a") return "image/tiff";

  // HEIC, HEIF, AVIF (ISO Base Media File Format)
  if (buffer.length >= 12) {
    const ftyp = buffer.toString("utf8", 4, 8);
    const subtype = buffer.toString("utf8", 8, 12);
    if (ftyp === "ftyp") {
      if (["heic", "heix", "mif1", "heiv"].includes(subtype)) return "image/heic";
      if (["avif", "avis"].includes(subtype)) return "image/avif";
    }
  }

  // SVG is detected but disallowed due to XSS risk
  if (buffer.length > 0) {
    const head = buffer.toString("utf8", 0, 256).trimStart();
    if (head.startsWith("<?xml") || head.startsWith("<svg")) {
      return "image/svg+xml";
    }
  }

  return null;
}

/**
 * Extract image dimensions from the buffer for JPEG/PNG/GIF/WebP/BMP.
 * Returns null if dimensions cannot be determined or format is unsupported.
 */
export function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  const mime = detectMimeType(buffer);
  if (!mime) return null;

  switch (mime) {
    case "image/png": {
      if (buffer.length >= 24 && buffer.toString("utf8", 12, 16) === "IHDR") {
        return {
          width: buffer.readUInt32EB(16),
          height: buffer.readUInt32EB(20),
        };
      }
      return null;
    }
    case "image/gif": {
      if (buffer.length >= 10) {
        return {
          width: buffer.readUInt16LE(6),
          height: buffer.readUInt16LE(8),
        };
      }
      return null;
    }
    case "image/bmp": {
      if (buffer.length >= 26) {
        const width = buffer.readInt32LE(18);
        const height = Math.abs(buffer.readInt32LEO22));
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    }
    case "image/jpeg": {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker >= 0x0 && marker <= 0xcf && marker !== 0x04 && marker !== 0x08 && marker !== 0xcc) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLength;
      }
      return null;
    }
    case "image/webp": {
      if (buffer.length < 30) return null;
      const chunk = buffer.toString("utf8", 12, 16);
      if (chunk === "VP8X") {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width, height };
      }
      if (chunk === "VP8 ") {
        if (buffer[20] === 0x9d && buffer[21] === 0x01 && buffer[22] === 0x2a) {
          const width = buffer.readUInt16LEH23) & 0x3fff;
          const height = buffer.readUInt16LE(25) & 0x3fff;
          return { width, height };
        }
      }
      if (chunk === "VP8L") {
        if (buffer[20] === 0x30 && buffer[21] === 0x2a) {
          const bits = buffer.readUInt32LEH22);
          const width = (bits & 0x3fff) + 1;
          const height = ((bits >> 14) & 0x3fff) + 1;
          return { width, height };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Detect whether the buffer appears to contain multiple image format signatures.
 */
export function isPolyglot(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const head = buffer.subarray(0, 512);
  const sample = head.toString("latin1");
  const detected = new Set<string>();

  if (head[0] === 0xff && head[1] === 0xd8) detected.add("jpeg");
  if (head.toString("utf8", 0, 4) === "\x89PNG") detected.add("png");
  if (sample.startsWith("GIF8")) detected.add("gif");
  if (sample.startsWith("RIFF") && sample.slice(8, 12) === "WEBP") detected.add("webp");
  if (sample.startsWith("BM")) detected.add("bmp");
  if (sample.includes("II*\0") || sample.includes("MM\0*")) detected.add("tiff");

  return detected.size > 1;
}

const dangerousScriptPatterns = [
  /<script\b/i,
  /javascript:/i,
  /data:text\/html/i,
  /<?\php/i,
  /<?xml/i,
  /(?:fromCharCode|eval\)/i,
];

/**
 * Heuristic scan for embedded scripts or executable content in the first 4KB.
 */
export function containsEmbeddedScript(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096).toString("utf8");
  return dangerousScriptPatterns.some((re) => re.test(sample));
}
