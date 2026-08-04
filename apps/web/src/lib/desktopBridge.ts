export type DesktopMenuCommand =
  | 'open-model'
  | 'save-project'
  | 'export-step'
  | 'export-stl'
  | 'undo'
  | 'redo'
  | 'settings';

interface NativeCadFile {
  name: string;
  bytes: number[];
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export function isDesktopApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as TauriWindow)
  );
}

function contentTypeFor(name: string): string {
  return name.toLowerCase().endsWith('.stl') ? 'model/stl' : 'model/step';
}

export function nativeCadFile(value: NativeCadFile): File {
  return new File([Uint8Array.from(value.bytes)], value.name, {
    type: contentTypeFor(value.name)
  });
}

export async function openDesktopCadFile(): Promise<File | null> {
  if (!isDesktopApp()) {
    return null;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const selected = await invoke<NativeCadFile | null>('open_cad_file');
  return selected ? nativeCadFile(selected) : null;
}

function downloadTextFile(
  fileName: string,
  contents: string,
  contentType: string
): void {
  const href = URL.createObjectURL(new Blob([contents], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

export async function saveCadTextFile(
  suggestedName: string,
  format: 'step' | 'stl',
  contents: string
): Promise<boolean> {
  if (!isDesktopApp()) {
    downloadTextFile(
      suggestedName,
      contents,
      format === 'step' ? 'model/step' : 'model/stl'
    );
    return true;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('save_cad_file', {
    suggestedName,
    format,
    contents
  });
}

export async function listenForDesktopMenu(
  handler: (command: DesktopMenuCommand) => void
): Promise<() => void> {
  if (!isDesktopApp()) {
    return () => undefined;
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DesktopMenuCommand>('openzcad://menu', (event) => {
    handler(event.payload);
  });
}

export async function protectDesktopClose(
  shouldConfirm: () => boolean
): Promise<() => void> {
  if (!isDesktopApp()) {
    return () => undefined;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const appWindow = getCurrentWindow();
  return appWindow.onCloseRequested(async (event) => {
    if (!shouldConfirm()) {
      return;
    }
    event.preventDefault();
    if (
      window.confirm(
        'OpenZCAD is still saving this project on this device. Close anyway?'
      )
    ) {
      await appWindow.destroy();
    }
  });
}
