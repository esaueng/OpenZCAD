/** The user asked the browser to save data: fetch nothing speculatively. */
export function prefersSavingData(): boolean {
  return (
    (navigator as { connection?: { saveData?: boolean } }).connection
      ?.saveData === true
  );
}
