import { useState, useEffect } from "react";
import "./dashboard.css";
import { useSearchParams } from "./search-params";

export function Dashboard() {
  const [availableStreams, setAvailableStreams] = useState<string[]>([]);
  const [selectedStreams, setSelectedStreams] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setSearchParams] = useSearchParams();

  useEffect(() => {
    const fetchStreams = async () => {
      try {
        setIsLoading(true);
        const response = await fetch("/api/streams");
        
        if (!response.ok) {
          throw new Error(`Failed to fetch streams: ${response.status}`);
        }
        
        const streamKeys = await response.json();
        setAvailableStreams(streamKeys);
      } catch (error) {
        console.error("Error fetching streams:", error);
        setError("Failed to load available streams. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchStreams();
  }, []);

  const handleStreamToggle = (stream: string) => {
    setSelectedStreams(prev => 
      prev.includes(stream)
        ? prev.filter(s => s !== stream)
        : [...prev, stream]
    );
  };

  const handleSubmit = () => {
    if (selectedStreams.length > 0) {
      setSearchParams({ streams: selectedStreams });
    }
  };

  if (isLoading) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-content">
          <div className="dashboard-loading">
            <div className="loading-spinner"></div>
            <p>Loading available streams...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-content">
          <div className="dashboard-error">
            <h2>Error</h2>
            <p>{error}</p>
            <button onClick={() => window.location.reload()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div className="dashboard-content">
        <h1>Camera Streams</h1>
        <p>Select the streams you want to view:</p>
        
        <div className="stream-list">
          {availableStreams.length === 0 ? (
            <p>No streams available</p>
          ) : (
            availableStreams.map(stream => (
              <div key={stream} className="stream-item">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedStreams.includes(stream)}
                    onChange={() => handleStreamToggle(stream)}
                  />
                  <span>{stream.replace(/_/g, " ")}</span>
                </label>
              </div>
            ))
          )}
        </div>
        
        <div className="dashboard-actions">
          <button 
            className="primary-button"
            onClick={handleSubmit}
            disabled={selectedStreams.length === 0}
          >
            View Selected Streams
          </button>
        </div>
      </div>
    </div>
  );
}
