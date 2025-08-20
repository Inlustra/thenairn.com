"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { computeBestGridLayout } from "./grid-solver";
import type { StreamInfo, StreamId } from "./grid-solver";
import { VideoPlayer } from "./VideoPlayer";

type Props = {
  streamInfo: StreamInfo[];
  // Optional initial guess for unknown streams
  defaultAspectRatio?: number; // default 16/9
  gapPx?: number; // default 8
};

type ARMap = Record<StreamId, number>;

export const DynamicVideoGrid: React.FC<Props> = ({
  streamInfo,
  defaultAspectRatio = 16 / 9,
  gapPx = 0,
}) => {
  const [containerW, setContainerW] = useState<number>(0);
  const [containerH, setContainerH] = useState<number>(0);
  const [aspectRatios, setAspectRatios] = useState<ARMap>({});

  // ResizeObserver instance
  const resizeObserver = useRef<ResizeObserver | null>(null);

  // Callback ref for container element
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    // Clean up previous observer if it exists
    if (resizeObserver.current) {
      resizeObserver.current.disconnect();
    }

    // If node is null (component unmounting), just return
    if (!node) return;

    // Set initial size
    setContainerW(node.clientWidth);
    setContainerH(node.clientHeight);

    // Create new observer
    resizeObserver.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setContainerW(cr.width);
        setContainerH(cr.height);
      }
    });

    // Start observing
    resizeObserver.current.observe(node);
  }, []);

  // Build StreamInfo list (use defaults where unknown)
  const streams: StreamInfo[] = useMemo(
    () =>
      streamInfo.map((s) => {
        // Get the aspect ratio from our state or use the default
        const ar = aspectRatios[s.id];
        // Ensure we always have a valid number
        const validAspectRatio =
          ar !== undefined && ar > 0 ? ar : defaultAspectRatio;

        return {
          id: s.id,
          src: s.src,
          aspectRatio: validAspectRatio,
        };
      }),
    [streamInfo, aspectRatios, defaultAspectRatio]
  );

  // Default dimensions for SSR when container size is not available
  const DEFAULT_WIDTH = 1280;
  const DEFAULT_HEIGHT = 720;

  const layout = useMemo(() => {
    // Use default dimensions if container size is not available (during SSR)
    const width = containerW || DEFAULT_WIDTH;
    const height = containerH || DEFAULT_HEIGHT;
    return computeBestGridLayout(width, height, streams, gapPx);
  }, [containerW, containerH, streams, gapPx]);

  // Handler for when a <video> learns its true AR
  const handleLoadedMetadata = (id: StreamId, video: HTMLVideoElement) => {
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (w > 0 && h > 0) {
      setAspectRatios((prev) => {
        if (prev[id] === w / h) return prev;
        return { ...prev, [id]: w / h };
      });
    }
  };

  // Grid template for placement
  const gridTemplateRows = `repeat(${layout.choice.rows}, 1fr)`;
  const gridTemplateCols = `repeat(${layout.choice.cols}, 1fr)`;

  // We no longer need to extract forceAudio here as VideoPlayer will handle it

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateRows,
        gridTemplateColumns: gridTemplateCols,
        gap: gapPx ? `${gapPx}px` : undefined,
        background: "black", // overall bg; individual bars come from object-fit behavior
      }}
    >
      {layout.items.map((item) => {
        const id = item.id;
        const src = item.src;

        return (
          <div
            key={id}
            className="stream-tile"
            style={{
              gridRowStart: item.row + 1,
              gridColumnStart: item.col + 1,
              // Let the video player center itself in the cell with its contained size:
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              background: "black", // cell background: shows as "bars" only if needed
              position: "relative",
            }}
          >
            <VideoPlayer
              id={id}
              src={src}
              width={item.width}
              height={item.height}
              onLoadedMetadata={handleLoadedMetadata}
            />
            {/* Labels are now handled inside the VideoPlayer component */}
          </div>
        );
      })}
    </div>
  );
};
