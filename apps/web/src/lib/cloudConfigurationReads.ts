/** Independent readiness reads share a cloud-mode generation, not a waterfall. */
export function createCloudConfigurationReads() {
  let mode = 0;
  const reads = { auth: 0, health: 0 };
  return {
    changeMode() {
      mode++;
    },
    captureMode() {
      const captured = mode;
      return () => mode === captured;
    },
    begin(kind: keyof typeof reads) {
      const capturedMode = mode;
      const request = ++reads[kind];
      return () => mode === capturedMode && reads[kind] === request;
    }
  };
}
