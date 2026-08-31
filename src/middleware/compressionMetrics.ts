/**
 * compressionMetrics.ts
 * -----------------------------------------------------------------------
 * "Add compression ratio metrics" acceptance criterion.
 * -----------------------------------------------------------------------
 */

export interface CompressionSample {
  path: string;
  encoding: string;
  uncompressedBytes: number;
  compressedBytes: number;
  ratio: number; // compressedBytes / uncompressedBytes (lower is better)
  savedBytes: number;
  timestamp: string;
}

class CompressionMetricsStore {
  private samples: CompressionSample[] = [];
  private readonly maxSamples = 5000; // ring buffer to bound memory

  record(sample: Omit<CompressionSample, "timestamp">) {
    this.samples.push({ ...sample, timestamp: new Date().toISOString() });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getSummary() {
    if (this.samples.length === 0) {
      return { sampleCount: 0, message: "No compressed responses recorded yet." };
    }

    const totalUncompressed = this.samples.reduce((s, x) => s + x.uncompressedBytes, 0);
    const totalCompressed = this.samples.reduce((s, x) => s + x.compressedBytes, 0);
    const avgRatio = this.samples.reduce((s, x) => s + x.ratio, 0) / this.samples.length;

    const byEncoding: Record<string, { count: number; avgRatio: number }> = {};
    for (const enc of new Set(this.samples.map((s) => s.encoding))) {
      const subset = this.samples.filter((s) => s.encoding === enc);
      byEncoding[enc] = {
        count: subset.length,
        avgRatio: Number((subset.reduce((s, x) => s + x.ratio, 0) / subset.length).toFixed(3)),
      };
    }

    return {
      sampleCount: this.samples.length,
      totalUncompressedBytes: totalUncompressed,
      totalCompressedBytes: totalCompressed,
      totalBytesSaved: totalUncompressed - totalCompressed,
      overallSavingsPct: Number(
        (((totalUncompressed - totalCompressed) / totalUncompressed) * 100).toFixed(1)
      ),
      avgRatio: Number(avgRatio.toFixed(3)),
      byEncoding,
    };
  }

  getRecentSamples(limit = 50): CompressionSample[] {
    return this.samples.slice(-limit);
  }

  reset() {
    this.samples = [];
  }
}

export const compressionMetrics = new CompressionMetricsStore();
