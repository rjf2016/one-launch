import { Menu, nativeImage, Tray } from 'electron';

export interface TrayOptions {
  /** A PNG of the app icon; scaled down to the tray size for the primary display's scale factor. */
  iconPath: string;
  scaleFactor: number;
  tooltip: string;
  onOpen: () => void;
  onQuit: () => void;
}

/** The notification-area icon that keeps the app reachable while its window is hidden. Throws when the icon file cannot be read. */
export function createTray(opts: TrayOptions): Tray {
  const px = Math.max(16, Math.round(16 * opts.scaleFactor));
  const icon = nativeImage.createFromPath(opts.iconPath);
  if (icon.isEmpty()) throw new Error(`tray icon not found at ${opts.iconPath}`);
  const tray = new Tray(icon.resize({ width: px, height: px }));
  tray.setToolTip(opts.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([{ label: 'Open One Launch', click: opts.onOpen }, { type: 'separator' }, { label: 'Quit One Launch', click: opts.onQuit }]),
  );
  tray.on('click', opts.onOpen);
  tray.on('double-click', opts.onOpen);
  return tray;
}
