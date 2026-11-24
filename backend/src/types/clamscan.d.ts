declare module "clamscan" {
  import type { Readable } from "node:stream";

  interface ScanResult {
    isInfected: boolean | null;
    viruses?: string[];
  }

  interface ClamScanner {
    scanStream(stream: Readable): Promise<ScanResult>;
  }

  interface ClamScanOptions {
    removeInfected: boolean;
    quarantineInfected: boolean;
    clamscan: { active: boolean };
    clamdscan: {
      socket: string | false;
      host: string | false;
      port: number;
      timeout: number;
      localFallback: boolean;
      active: boolean;
    };
    preference: "clamdscan";
  }

  export default class NodeClam {
    init(options: ClamScanOptions): Promise<ClamScanner>;
  }
}
