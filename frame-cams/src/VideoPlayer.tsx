import React, { useState, useRef, useEffect, useCallback } from "react";
import type { StreamId } from "./grid-solver";
import { useSearchParams } from "./search-params";
import { VideoOverlay } from "./components/VideoIndicators";

type VideoState = "loading" | "playing" | "stalled" | "buffering" | "error";

interface VideoPlayerProps {
  id: StreamId;
  src: string;
  width: number;
  height: number;
  onLoadedMetadata: (id: StreamId, video: HTMLVideoElement) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  id,
  src,
  width,
  height,
  onLoadedMetadata,
}) => {
  // Get parameters from URL instead of props
  const [{ forceAudio, showControls, showLabels }] = useSearchParams();
  const [videoState, setVideoState] = useState<VideoState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Reset state when src changes
  useEffect(() => {
    setVideoState("loading");
    setErrorMessage(null);
  }, [src]);

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    console.warn("video error", id, e.currentTarget.error);
    setVideoState("error");

    const errorCode = e.currentTarget.error?.code;
    let message = "Unknown error occurred";

    switch (errorCode) {
      case 1:
        message = "Fetching process aborted";
        break;
      case 2:
        message = "Network error";
        break;
      case 3:
        message = "Decoding error";
        break;
      case 4:
        message = "Video not supported";
        break;
    }

    setErrorMessage(message);
  };

  const handleStalled = () => {
    console.info("stalled", id);
    setVideoState("stalled");
  };

  const handleWaiting = () => {
    console.info("buffering", id);
    setVideoState("buffering");
  };

  const handlePlaying = () => {
    console.info("playing", id);
    setVideoState("playing");
  };

  const handleReload = () => {
    if (videoRef.current) {
      // Reset state
      setVideoState("loading");
      setErrorMessage(null);

      // Reload the video
      videoRef.current.load();
      videoRef.current.play().catch((err) => {
        console.warn("Failed to play after reload:", err);
      });
    }
  };

  return (
    <div
      className="video-container"
      style={{
        position: "relative",
        width: `${width}px`,
        height: `${height}px`,
      }}
    >
      <video
        id={`video-${id}`}
        ref={videoRef}
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "black",
          display: videoState === "error" ? "none" : "block",
        }}
        onLoadedMetadata={(e) => onLoadedMetadata(id, e.currentTarget)}
        onError={handleError}
        onStalled={handleStalled}
        onWaiting={handleWaiting}
        onPlaying={handlePlaying}
        title={`Stream: ${id}`}
        autoPlay
        muted={forceAudio}
        playsInline
        controls={showControls}
        loop
      />

      {/* Video state overlay */}
      <VideoOverlay
        videoState={videoState}
        errorMessage={errorMessage}
        onReload={handleReload}
      />

      {/* Stream label */}
      {showLabels && (
        <div
          className="stream-id-label"
          style={{
            position: "absolute",
            bottom: "8px",
            left: "8px",
            background: "rgba(0,0,0,0.6)",
            color: "white",
            padding: "2px 6px",
            borderRadius: "4px",
            fontSize: "0.8rem",
            zIndex: 3,
          }}
        >
          {id}
        </div>
      )}
    </div>
  );
};
