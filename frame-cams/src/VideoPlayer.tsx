import React, { useState, useRef, useEffect, useCallback } from "react";
import type { StreamId } from "./grid-solver";
import { useSearchParams } from "./search-params";

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
  const [showStalledUI, setShowStalledUI] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stalledTimerRef = useRef<number | null>(null);

  // Clear stalled timer when component unmounts or src changes
  const clearStalledTimer = useCallback(() => {
    if (stalledTimerRef.current !== null) {
      window.clearTimeout(stalledTimerRef.current);
      stalledTimerRef.current = null;
    }
  }, []);

  // Reset state when src changes
  useEffect(() => {
    setVideoState("loading");
    setErrorMessage(null);
    setShowStalledUI(false);
    clearStalledTimer();
  }, [src, clearStalledTimer]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => clearStalledTimer();
  }, [clearStalledTimer]);

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

    // Clear any existing timer
    clearStalledTimer();

    // Set a 30-second timer before showing the stalled UI
    stalledTimerRef.current = window.setTimeout(() => {
      setShowStalledUI(true);
    }, 30000); // 30 seconds
  };

  const handleWaiting = () => {
    console.info("buffering", id);
    setVideoState("buffering");
  };

  const handlePlaying = () => {
    console.info("playing", id);
    setVideoState("playing");
    setShowStalledUI(false);

    // Clear the stalled timer when video starts playing
    clearStalledTimer();
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
        muted={forceAudio === "true"}
        playsInline
        controls={showControls === "true"}
        loop
      />

      {/* Overlay for different states */}
      {videoState !== "playing" && (
        <div
          className={`video-overlay video-state-${videoState}`}
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            padding: "8px",
            background: "rgba(0,0,0,0.6)",
            color: "white",
            zIndex: 2,
            borderRadius: "4px",
            maxWidth: "200px",
          }}
        >
          {videoState === "error" && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  marginBottom: "0.5rem",
                }}
              >
                <span
                  className="error-icon"
                  style={{ fontSize: "1.2rem", marginRight: "0.5rem" }}
                >
                  ⚠️
                </span>
                <span style={{ fontSize: "0.9rem" }}>Video Error</span>
              </div>
              <div
                className="error-message"
                style={{
                  marginBottom: "0.5rem",
                  fontSize: "0.8rem",
                  textAlign: "right",
                }}
              >
                {errorMessage || "Video error"}
              </div>
              <button
                onClick={handleReload}
                style={{
                  padding: "0.25rem 0.5rem",
                  background: "#3498db",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
              >
                Reload Video
              </button>
            </>
          )}

          {videoState === "buffering" && (
            <div
              className="buffering-indicator"
              style={{ display: "flex", alignItems: "center" }}
            >
              <div
                className="loading-spinner"
                style={{
                  width: "16px",
                  height: "16px",
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.3)",
                  borderTopColor: "white",
                  animation: "spin 1s linear infinite",
                  marginRight: "8px",
                }}
              ></div>
              <div style={{ fontSize: "0.8rem" }}>Buffering...</div>
            </div>
          )}

          {videoState === "stalled" && showStalledUI && (
            <div className="stalled-indicator">
              <div
                style={{
                  marginBottom: "0.5rem",
                  fontSize: "0.8rem",
                  textAlign: "right",
                }}
              >
                Stream stalled
              </div>
              <button
                onClick={handleReload}
                style={{
                  padding: "0.25rem 0.5rem",
                  background: "#3498db",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
              >
                Reload
              </button>
            </div>
          )}

          {videoState === "loading" && (
            <div
              className="loading-indicator"
              style={{ display: "flex", alignItems: "center" }}
            >
              <div
                className="loading-spinner"
                style={{
                  width: "16px",
                  height: "16px",
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.3)",
                  borderTopColor: "white",
                  animation: "spin 1s linear infinite",
                  marginRight: "8px",
                }}
              ></div>
              <div style={{ fontSize: "0.8rem" }}>Loading...</div>
            </div>
          )}
        </div>
      )}

      {/* Stream label */}
      {showLabels === "true" && (
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
