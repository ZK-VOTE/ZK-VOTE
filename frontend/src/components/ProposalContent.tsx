import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "lucide-react";
import { relayerFetch, RELAYER_URL } from "../lib/api";
import { LoadingSpinner, MediaSlider } from "./ui";

export interface ProposalMetadata {
  version: number;
  body: string;
  videoUrl?: string;
  image?: {
    cid: string;
    filename: string;
    mimeType: string;
  };
}

interface ProposalContentProps {
  contentCid: string;
}

/** Check if contentCid looks like a valid IPFS CID */
function isValidCid(cid: string): boolean {
  return (
    cid.startsWith("Qm") || cid.startsWith("bafy") || cid.startsWith("bafk")
  );
}

export default function ProposalContent({ contentCid }: ProposalContentProps) {
  const [metadata, setMetadata] = useState<ProposalMetadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [metadataFailed, setMetadataFailed] = useState(false);

  const hasRichContent = isValidCid(contentCid);

  useEffect(() => {
    if (hasRichContent && !metadata && !loadingMetadata && !metadataFailed) {
      loadMetadata();
    }
  }, [contentCid, hasRichContent, metadata, loadingMetadata, metadataFailed]);

  const loadMetadata = async () => {
    setLoadingMetadata(true);
    try {
      const res = await relayerFetch(`/ipfs/${contentCid}`);
      if (!res.ok) throw new Error("Failed to fetch metadata");
      const data = await res.json();
      setMetadata(data);
    } catch (err) {
      console.error("Failed to load metadata:", err);
      setMetadataFailed(true);
    } finally {
      setLoadingMetadata(false);
    }
  };

  return (
    <>
      {/* Loading state */}
      {loadingMetadata && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <LoadingSpinner size="sm" />
          <span>Loading content...</span>
        </div>
      )}

      {/* Metadata failed state */}
      {metadataFailed && hasRichContent && (
        <p className="text-sm text-muted-foreground italic">
          Content unavailable from IPFS
        </p>
      )}

      {/* Body content with media slider floated right */}
      <div className="clearfix">
        {(metadata?.image || metadata?.videoUrl) && (
          <div className="w-full md:float-right md:w-[320px] lg:w-[400px] md:ml-6 mb-4">
            <MediaSlider
              image={metadata?.image}
              videoUrl={metadata?.videoUrl}
            />
          </div>
        )}

        {metadata?.body && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {metadata.body}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Legacy content (non-CID) */}
      {!hasRichContent && contentCid && (
        <p className="text-muted-foreground">{contentCid}</p>
      )}

      {/* IPFS link */}
      {hasRichContent && (
        <div className="text-xs text-muted-foreground">
          <a
            href={`${RELAYER_URL}/ipfs/${contentCid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            View on IPFS
          </a>
        </div>
      )}
    </>
  );
}
