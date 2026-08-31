export function detectMimeType(buffer) {
    if (buffer.length < 4)
        return null;
    const hex4 = buffer.toString("hex", 0, 4);
    // JPEG
    if (hex4.startsWith("ffd8ff"))
        return "image/jpeg";
    // PNG
    if (hex4 === "89504e47")
        return "image/png";
    // GIF
    if (hex4 === "47494638")
        return "image/gif";
    // WebP
    if (hex4 === "52494646" && buffer.length >= 12) {
        const webpStr = buffer.toString("utf8", 8, 12);
        if (webpStr === "WEBP")
            return "image/webp";
    }
    // BMP
    if (buffer.toString("utf8", 0, 2) === "BM")
        return "image/bmp";
    // TIFF
    if (hex4 === "49492a00" || hex4 === "4d4d002a")
        return "image/tiff";
    // HEIC, HEIF, AVIF (ISO Base Media File Format)
    if (buffer.length >= 12) {
        const ftyp = buffer.toString("utf8", 4, 8);
        const subtype = buffer.toString("utf8", 8, 12);
        if (ftyp === "ftyp") {
            if (["heic", "heix", "mif1", "heiv"].includes(subtype))
                return "image/heic"; // simplified
            if (["avif", "avis"].includes(subtype))
                return "image/avif";
        }
    }
    // Not an image or unknown magic bytes
    return null;
}
//# sourceMappingURL=magic-bytes.js.map