import type { ReactNode, Ref } from 'react';
import { BrandMark } from './BrandMark';

/**
 * The workspace's floating top bar for the pages around it (the parts
 * library and Settings): the identity island on the left, a page control in
 * the middle, the actions island on the right. Each page puts Settings last
 * in its actions, so the logo and that button land on the same pixels as
 * they do in the workspace.
 */
export function PageTopBar({
  className,
  title,
  brandRef,
  onBrand,
  brandTitle,
  center,
  actions,
  actionsLabel
}: {
  className?: string;
  /** The page's name, beside the logo where the workspace shows the part. */
  title: string;
  brandRef?: Ref<HTMLButtonElement>;
  /** Makes the logo a button (Settings uses it to close). */
  onBrand?(): void;
  brandTitle?: string;
  center?: ReactNode;
  actions: ReactNode;
  actionsLabel: string;
}) {
  const brand = (
    <>
      <BrandMark compact />
      OpenZCAD <span className="beta-tag">Beta</span>
    </>
  );
  return (
    <header className={['page-topbar', className].filter(Boolean).join(' ')}>
      <div className="topbar-island topbar-identity">
        {/* The page's one heading: the product on the library, where the
            logo goes nowhere, and the page name where the logo is a way out. */}
        {onBrand ? (
          <button
            ref={brandRef}
            className="brand"
            type="button"
            title={brandTitle}
            onClick={onBrand}
          >
            {brand}
          </button>
        ) : (
          <h1 className="brand">{brand}</h1>
        )}
        <div className="topbar-divider" />
        {onBrand ? (
          <h1 className="page-topbar-title">{title}</h1>
        ) : (
          <span className="page-topbar-title">{title}</span>
        )}
      </div>
      <div className="page-topbar-center">{center}</div>
      <div className="topbar-island topbar-actions-island">
        <div className="topbar-actions" role="group" aria-label={actionsLabel}>
          {actions}
        </div>
      </div>
    </header>
  );
}
