import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Image as ImageIcon,
} from "lucide-react";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";

// Helper to extract YouTube video ID
function getYouTubeId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

// Helper to extract Vimeo video ID
function getVimeoId(url: string): string | null {
  const regExp = /vimeo\.com\/(?:video\/)?(\d+)/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

// Video embed component
function VideoEmbed({ url }: { url: string }) {
  const youtubeId = getYouTubeId(url);
  const vimeoId = getVimeoId(url);

  if (youtubeId) {
    return (
      <iframe
        src={`https://www.youtube.com/embed/${youtubeId}`}
        width="100%"
        height="100%"
        frameBorder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title="YouTube video"
        className="absolute inset-0"
      />
    );
  }

  if (vimeoId) {
    return (
      <iframe
        src={`https://player.vimeo.com/video/${vimeoId}`}
        width="100%"
        height="100%"
        frameBorder="0"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        title="Vimeo video"
        className="absolute inset-0"
      />
    );
  }

  // Fallback to native video element
  return (
    <video
      src={url}
      controls
      className="absolute inset-0 w-full h-full bg-black"
    >
      Your browser does not support the video tag.
    </video>
  );
}

interface MediaItem {
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  alt?: string;
}

interface MediaSliderProps {
  image?: {
    cid: string;
    filename: string;
    mimeType: string;
  };
  videoUrl?: string;
}

export function MediaSlider({ image, videoUrl }: MediaSliderProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [thumbnailsLoaded, setThumbnailsLoaded] = useState<
    Record<number, boolean>
  >({});

  // Build media items array - video first if present
  const mediaItems: MediaItem[] = [];

  if (videoUrl) {
    const youtubeId = getYouTubeId(videoUrl);
    const vimeoId = getVimeoId(videoUrl);

    mediaItems.push({
      type: "video",
      src: videoUrl,
      thumbnail: youtubeId
        ? `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`
        : vimeoId
          ? `https://vumbnail.com/${vimeoId}.jpg`
          : undefined,
      alt: "Video",
    });
  }

  if (image) {
    mediaItems.push({
      type: "image",
      src: `${RELAYER_URL}/ipfs/image/${image.cid}`,
      thumbnail: `${RELAYER_URL}/ipfs/image/${image.cid}`,
      alt: image.filename || "Proposal image",
    });
  }

  if (mediaItems.length === 0) return null;

  const currentItem = mediaItems[activeIndex];

  const goToPrevious = () => {
    setActiveIndex((prev) => (prev === 0 ? mediaItems.length - 1 : prev - 1));
    setImageLoaded(false);
  };

  const goToNext = () => {
    setActiveIndex((prev) => (prev === mediaItems.length - 1 ? 0 : prev + 1));
    setImageLoaded(false);
  };

  return (
    <div className="w-full">
      {/* Main display area - 16:9 aspect ratio */}
      <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-border bg-muted">
        {/* Loading shimmer */}
        {currentItem.type === "image" && !imageLoaded && (
          <div className="absolute inset-0 animate-shimmer" />
        )}

        {/* Image display */}
        {currentItem.type === "image" && (
          <img
            src={currentItem.src}
            alt={currentItem.alt}
            className={`w-full h-full object-cover transition-opacity duration-300 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
            onLoad={() => setImageLoaded(true)}
          />
        )}

        {/* Video display */}
        {currentItem.type === "video" && <VideoEmbed url={currentItem.src} />}

        {/* Navigation arrows - only show if more than one item */}
        {mediaItems.length > 1 && (
          <>
            <button
              onClick={goToPrevious}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={goToNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnails - only show if more than one item */}
      {mediaItems.length > 1 && (
        <div className="flex gap-2 mt-2 justify-center">
          {mediaItems.map((item, index) => (
            <button
              key={index}
              onClick={() => {
                setActiveIndex(index);
                setImageLoaded(false);
              }}
              className={`relative w-16 h-9 rounded overflow-hidden border-2 transition-all ${
                index === activeIndex
                  ? "border-primary ring-1 ring-primary"
                  : "border-border hover:border-muted-foreground"
              }`}
              aria-label={`View ${item.type}`}
            >
              {/* Thumbnail loading shimmer */}
              {!thumbnailsLoaded[index] && (
                <div className="absolute inset-0 animate-shimmer" />
              )}

              {item.thumbnail ? (
                <img
                  src={item.thumbnail}
                  alt={item.alt}
                  className={`w-full h-full object-cover transition-opacity duration-200 ${
                    thumbnailsLoaded[index] ? "opacity-100" : "opacity-0"
                  }`}
                  onLoad={() =>
                    setThumbnailsLoaded((prev) => ({ ...prev, [index]: true }))
                  }
                />
              ) : (
                <div className="w-full h-full bg-muted flex items-center justify-center">
                  {item.type === "video" ? (
                    <Play className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ImageIcon className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
              )}

              {/* Video indicator overlay */}
              {item.type === "video" && item.thumbnail && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <Play className="w-4 h-4 text-white" />
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
