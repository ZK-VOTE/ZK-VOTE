import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertMalwareFree } from "../src/services/malwareScanner.js";
import {
  detectMimeType,
  getImageDimensions,
  hasSafeImageDimensions,
} from "../src/utils/magic-bytes.js";

function oversizedWebp(): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  // VP8X stores width-1 and height-1 as 24-bit little-endian values.
  buffer[24] = 0xff;
  buffer[25] = 0xff;
  buffer[26] = 0x00;
  buffer[27] = 0xff;
  buffer[28] = 0xff;
  buffer[29] = 0x00;
  return buffer;
}

describe("upload security known-answer tests", () => {
  it("parses RIFF length as little-endian and exposes bomb dimensions", () => {
    const buffer = oversizedWebp();
    assert.equal(detectMimeType(buffer), "image/webp");
    assert.deepEqual(getImageDimensions(buffer), {
      width: 65_536,
      height: 65_536,
    });
    assert.equal(hasSafeImageDimensions(buffer, 4_096), false);

    buffer.writeUInt32BE(buffer.length - 8, 4);
    assert.equal(detectMimeType(buffer), null);
  });

  it("rejects the EICAR ClamAV known-answer vector", async () => {
    const eicar = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
      "ascii",
    );
    await assert.rejects(
      () => assertMalwareFree(eicar),
      /EICAR-Test-Signature/,
    );
  });
});
