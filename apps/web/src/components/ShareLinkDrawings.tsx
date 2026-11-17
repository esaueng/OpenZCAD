import { FileText } from 'lucide-react';

export interface ShareLinkDrawingsProps {
  sheets: readonly { id: string; name: string }[];
  /** The sheets links show now. */
  sharedSheetIds: readonly string[];
  /** Absent while the project cannot be edited: the choice is shown only. */
  onChange?(sheetIds: string[]): void;
}

/**
 * L08: which drawing sheets the project's share links show. Off by default,
 * because a sheet's title block can name its author, date and drawing
 * number; a visitor opens the chosen sheets read only in Draw and can
 * download each as a PDF. The choice is saved with the project, so links
 * already made pick it up from the next snapshot they serve.
 */
export function ShareLinkDrawings({
  sheets,
  sharedSheetIds,
  onChange
}: ShareLinkDrawingsProps) {
  const shared = new Set(sharedSheetIds);
  return (
    <section
      className="sharing-section share-link-drawings"
      aria-label="Drawings on links"
    >
      <h3 className="sharing-section-label">Drawings on links</h3>
      <p className="sharing-hint">
        Visitors see the sheets you tick, read only, and can download them as
        PDF. Title blocks show as drawn, including any author, date and drawing
        number.
      </p>
      <ul className="share-link-drawings-list">
        {sheets.map((sheet) => (
          <li key={sheet.id}>
            <label className="share-link-drawings-sheet">
              <input
                type="checkbox"
                checked={shared.has(sheet.id)}
                disabled={!onChange}
                onChange={(event) =>
                  onChange?.(
                    sheets
                      .map((entry) => entry.id)
                      .filter((id) =>
                        id === sheet.id ? event.target.checked : shared.has(id)
                      )
                  )
                }
              />
              <FileText size={13} aria-hidden="true" />
              <span>{sheet.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
