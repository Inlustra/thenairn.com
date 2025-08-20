import { DynamicVideoGrid } from "./DynamicVideoGrid";
import type { StreamInfo } from "./grid-solver";
import "./app.css";
import { useSearchParams } from "./search-params";

export function App({
  streamInfo,
}: {
  streamInfo: StreamInfo[];
}) {
  const [{ showControls, showLabels }, setSearchParams] = useSearchParams();

  const toggleControls = () => {
    // Toggle between true/false/auto states
    const newValue = showControls === "true" ? "false" : "true";
    setSearchParams({ showControls: newValue });
  };

  const toggleLabels = () => {
    // Toggle between true/false/auto states
    const newValue = showLabels === "true" ? "false" : "true";
    setSearchParams({ showLabels: newValue });
  };

  return (
    <div className="app-container">
      <div className="controls-panel">
        {showControls !== "hide" && (
          <button className="control-button" onClick={toggleControls}>
            {showControls === "true" ? "Hide Controls" : "Show Controls"}
          </button>
        )}
        {showLabels !== "hide" && (
          <button className="control-button" onClick={toggleLabels}>
            {showLabels === "true" ? "Hide Labels" : "Show Labels"}
          </button>
        )}
      </div>

      <div
        style={{
          height: "100vh",
          width: "100vw",
          boxSizing: "border-box",
        }}
      >
        <DynamicVideoGrid
          streamInfo={streamInfo}
        />
      </div>
    </div>
  );
}
