import type { ReactNode } from 'react';
import { isDesktopApp, openExternalUrl } from '../lib/desktopBridge';

interface ExternalAnchorProps {
  href: string;
  className?: string;
  children: ReactNode;
}

/**
 * A link to a page outside the app. In a browser it is a plain new-tab
 * anchor. The desktop app's WKWebView silently ignores `target="_blank"`, so
 * there a click asks the native shell to open the page in the system browser;
 * the shell refuses any URL outside its allowlist.
 */
export function ExternalAnchor({
  href,
  className,
  children
}: ExternalAnchorProps) {
  const desktop = isDesktopApp();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={
        desktop
          ? (event) => {
              event.preventDefault();
              openExternalUrl(href).catch((error: unknown) => {
                console.error('OpenZCAD could not open the link:', error);
              });
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}
