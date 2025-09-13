import { DynamicVideoGrid } from "./DynamicVideoGrid";
import { Dashboard } from "./Dashboard";
import type { StreamInfo } from "./grid-solver";
import "./app.css";
import { useSearchParams } from "./search-params";

export function App({ streamInfo }: { streamInfo: StreamInfo[] }) {
  const [{ showControls, showLabels, streams, hideControls }, setSearchParams] =
    useSearchParams();

  const toggleControls = () => {
    setSearchParams({ showControls: !showControls });
  };

  const toggleLabels = () => {
    setSearchParams({ showLabels: !showLabels });
  };

  // If no streams are selected, show the dashboard
  if (!streams || streams.length === 0) {
    return <Dashboard />;
  }

  // Otherwise show the video grid
  return (
    <div className="app-container">
      <div className={`controls-panel-container ${hideControls ? 'hidden' : ''}`}>
        <div 
          className="controls-toggle" 
          onClick={() => setSearchParams({ hideControls: !hideControls })}
        >
          {hideControls ? '◀' : '▶'}
        </div>
        <div className="controls-panel">
          <button className="control-button" onClick={toggleControls}>
            {showControls ? "Hide Controls" : "Show Controls"}
          </button>
          <button className="control-button" onClick={toggleLabels}>
            {showLabels ? "Hide Labels" : "Show Labels"}
          </button>
          <button
            className="control-button"
            onClick={() => setSearchParams({ streams: [] })}
          >
            Back to Dashboard
          </button>
        </div>
      </div>

      <div
        style={{
          height: "100vh",
          width: "100vw",
          boxSizing: "border-box",
        }}
      >
        <DynamicVideoGrid streamInfo={streamInfo} />
      </div>
    </div>
  );
}
