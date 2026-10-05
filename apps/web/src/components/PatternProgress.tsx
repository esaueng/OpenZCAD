import { useEffect, useState } from 'react';

export function PatternProgress({
  name,
  onCancel
}: {
  name: string;
  onCancel(): void;
}) {
  const [started] = useState(Date.now);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed(Date.now() - started),
      1000
    );
    return () => window.clearInterval(timer);
  }, [started]);
  return (
    <div
      className="pattern-progress"
      role="region"
      aria-label="Pattern rebuild"
      aria-busy="true"
    >
      <span role="status">
        Rebuilding {name}. Overlapping copies need exact merging; you can cancel
        without changing the model.
      </span>
      <small aria-hidden="true">{Math.floor(elapsed / 1000)} s</small>
      <button type="button" onClick={onCancel}>
        Cancel pattern
      </button>
    </div>
  );
}
