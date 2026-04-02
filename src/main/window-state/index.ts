/**
 * Window state persistence — saves and restores window position, size,
 * and maximized state across restarts.
 *
 * State is stored in a small JSON file in userData (separate from app settings).
 */
import { BrowserWindow, app, screen } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { createLogger } from '../logger';

const logger = createLogger('window-state');

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULTS: WindowState = {
  x: -1, // -1 means "let the OS decide"
  y: -1,
  width: 1400,
  height: 900,
  isMaximized: false,
};

function getStatePath(): string {
  if (!app.isPackaged) {
    return join(__dirname, '../../window-state.json');
  }
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'window-state.json');
}

/**
 * Loads saved window state from disk, falling back to defaults.
 */
export function loadWindowState(): WindowState {
  const path = getStatePath();

  if (!existsSync(path)) {
    return { ...DEFAULTS };
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WindowState>;
    return {
      x: data.x ?? DEFAULTS.x,
      y: data.y ?? DEFAULTS.y,
      width: data.width ?? DEFAULTS.width,
      height: data.height ?? DEFAULTS.height,
      isMaximized: data.isMaximized ?? DEFAULTS.isMaximized,
    };
  } catch (err) {
    logger.error(`Failed to load window state: ${err}`);
    return { ...DEFAULTS };
  }
}

/**
 * Saves window state to disk.
 */
function saveWindowState(state: WindowState): void {
  const path = getStatePath();
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`Failed to save window state: ${err}`);
  }
}

/**
 * Validates that the saved position is still visible on a connected display.
 * If the window would be entirely off-screen (e.g. monitor disconnected),
 * resets position to OS default.
 */
function ensureVisibleOnDisplay(state: WindowState): WindowState {
  const displays = screen.getAllDisplays();

  // If position was never saved, let the OS decide
  if (state.x === -1 || state.y === -1) {
    return state;
  }

  // Check if at least part of the window is visible on any display
  const visible = displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    // Window is "visible" if at least 100px overlaps with the display
    return (
      state.x + state.width > x + 100 &&
      state.x < x + width - 100 &&
      state.y + state.height > y + 100 &&
      state.y < y + height - 100
    );
  });

  if (!visible) {
    logger.info('Saved window position is off-screen, resetting to OS default');
    return { ...state, x: -1, y: -1 };
  }

  return state;
}

/**
 * Attaches event listeners to track and persist window state changes.
 * Call this after creating the BrowserWindow.
 */
export function trackWindowState(win: BrowserWindow): void {
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  const debouncedSave = (): void => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (win.isDestroyed()) return;

      const isMaximized = win.isMaximized();
      // Only save bounds when not maximized — we want to restore
      // the "normal" size, not the maximized full-screen size
      const bounds = isMaximized ? loadWindowState() : win.getBounds();

      saveWindowState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized,
      });
    }, 500);
  };

  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', debouncedSave);
  win.on('unmaximize', debouncedSave);
  win.on('close', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (win.isDestroyed()) return;

    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? loadWindowState() : win.getBounds();

    saveWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    });
  });
}

/**
 * Returns BrowserWindow constructor options derived from saved state.
 */
export function getWindowStateOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  const state = ensureVisibleOnDisplay(loadWindowState());

  const opts: Partial<Electron.BrowserWindowConstructorOptions> = {
    width: state.width,
    height: state.height,
  };

  // Only set position if we have a saved one (not -1)
  if (state.x !== -1 && state.y !== -1) {
    opts.x = state.x;
    opts.y = state.y;
  }

  return opts;
}

/**
 * Returns whether the saved state was maximized.
 */
export function wasMaximized(): boolean {
  return loadWindowState().isMaximized;
}
