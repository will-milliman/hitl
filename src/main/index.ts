// Load .env before anything else so all modules see env vars
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

// In dev, load from project root. In production, .env is optional.
dotenvConfig({ path: resolve(__dirname, '../../.env') })

import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { createIPCHandler } from 'electron-trpc/main'
import { appRouter } from './trpc/router'
import { initDatabase, closeDatabase } from './db'
import { startCron, stopCron } from './cron'
import { clearConfigCache } from './cron/config'
import { unwatchAll, ensureGlobalHooks } from './copilot'
import { initLogger, createLogger } from './logger'
import { initAutoUpdater } from './updater'
import { getWindowStateOptions, wasMaximized, trackWindowState } from './window-state'

const logger = createLogger('app')

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  // Initialize logger
  initLogger('info')
  logger.info('Starting HITL Orchestrator')

  // Initialize database before creating the window
  await initDatabase()

  const savedState = getWindowStateOptions()

  mainWindow = new BrowserWindow({
    ...savedState,
    minWidth: 1000,
    minHeight: 600,
    title: 'HITL',
    backgroundColor: '#1e1e2e', // Catppuccin Mocha base
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Restore maximized state after window is created
  if (wasMaximized()) {
    mainWindow.maximize()
  }

  // Track window position/size changes for next launch
  trackWindowState(mainWindow)

  // Hide the application menu (File, Edit, etc.)
  Menu.setApplicationMenu(null)

  createIPCHandler({ router: appRouter, windows: [mainWindow] })

  // In dev, load from vite dev server; in prod, load the built file
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Clear any cached config so it re-reads env vars (in case loaded before dotenv ran)
  clearConfigCache()

  // Set up global Copilot CLI hooks in ~/.copilot/config.json
  ensureGlobalHooks()

  startCron()

  // Auto-updater only in packaged builds
  if (app.isPackaged) {
    initAutoUpdater()
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  logger.info('Shutting down HITL Orchestrator')
  stopCron()
  unwatchAll()
  await closeDatabase()
})
