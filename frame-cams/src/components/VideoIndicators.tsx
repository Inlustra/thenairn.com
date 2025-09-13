import React from "react";
import type { ReactNode } from "react";
import "./video-indicators.css";

type IndicatorPosition = "center" | "top-right";
type VideoState = "loading" | "playing" | "stalled" | "buffering" | "error";

interface BaseIndicatorProps {
  position?: IndicatorPosition;
  children: ReactNode;
}

export const BaseIndicator: React.FC<BaseIndicatorProps> = ({
  position = "top-right",
  children,
}) => {
  const positionClass =
    position === "center" ? "position-center" : "position-top-right";

  return <div className={`video-indicator ${positionClass}`}>{children}</div>;
};

interface LoadingIndicatorProps {
  type: "loading" | "buffering";
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({ type }) => {
  const message = type === "loading" ? "Loading..." : "Buffering...";

  return (
    <div className={`${type}-indicator indicator-container`}>
      <div className="loading-spinner"></div>
      <div className="indicator-text">{message}</div>
    </div>
  );
};

interface ErrorIndicatorProps {
  errorMessage: string;
  onReload: () => void;
}

export const ErrorIndicator: React.FC<ErrorIndicatorProps> = ({
  errorMessage,
  onReload,
}) => {
  return (
    <>
      <div className="error-header">
        <span className="error-icon">⚠️</span>
        <span className="error-title">Video Error</span>
      </div>
      <div className="error-message">{errorMessage}</div>
      <button className="reload-button" onClick={onReload}>
        Reload Video
      </button>
    </>
  );
};

interface StalledIndicatorProps {
  onReload: () => void;
}

export const StalledIndicator: React.FC<StalledIndicatorProps> = ({
  onReload,
}) => {
  return (
    <div className="stalled-indicator">
      <div className="stalled-message">Stream stalled</div>
      <button className="reload-button" onClick={onReload}>
        Reload
      </button>
    </div>
  );
};

interface VideoOverlayProps {
  videoState: VideoState;
  errorMessage: string | null;
  onReload: () => void;
}

export const VideoOverlay: React.FC<VideoOverlayProps> = ({
  videoState,
  errorMessage,
  onReload,
}) => {
  const [position, setPosition] =
    React.useState<IndicatorPosition>("top-right");

  const [elapsed, setElapsed] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setElapsed(true); // triggers a re-render after 5s
    }, 5000);

    return () => clearTimeout(timer);
  }, []);

  // Update position based on video state
  React.useEffect(() => {
    if (videoState === "loading" || videoState === "buffering") {
      setPosition("center");
    } else {
      setPosition("top-right");
    }
  }, [videoState]);

  const showStalledUI =
    videoState === "stalled" && elapsed;

  if (videoState === "playing") return null;

  // Determine if we have any content to show
  const showError = videoState === "error";
  const showBuffering = videoState === "buffering" && elapsed;
  const showStalled = videoState === "stalled" && showStalledUI;
  const showLoading = videoState === "loading" && elapsed;

  // Only render the BaseIndicator if we have content to display
  if (!showError && !showBuffering && !showStalled && !showLoading) {
    return null;
  }

  return (
    <BaseIndicator position={position}>
      {showError && (
        <ErrorIndicator
          errorMessage={errorMessage || "Unknown error"}
          onReload={onReload}
        />
      )}

      {showBuffering && <LoadingIndicator type="buffering" />}

      {showStalled && <StalledIndicator onReload={onReload} />}

      {showLoading && <LoadingIndicator type="loading" />}
    </BaseIndicator>
  );
};
