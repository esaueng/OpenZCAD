import { BrandMark } from './BrandMark';

export function StartupScreen() {
  return (
    <div
      className="startup-screen"
      role="status"
      aria-live="polite"
      aria-label="Restoring workspace"
    >
      <div className="startup-card">
        <BrandMark />
        <strong>OpenZCAD</strong>
        <span>Restoring workspace…</span>
      </div>
    </div>
  );
}
