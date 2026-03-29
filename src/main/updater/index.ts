/**
 * Auto-update module using electron-updater.
 *
 * Checks for updates on app launch and periodically.
 * Downloads updates automatically and prompts to install on quit.
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, dialog } from 'electron'
import { createLogger } from '../logger'

const logger = createLogger('updater')

let updateAvailable = false
let updateDownloaded = false
let updateVersion: string | null = null

export interface UpdateStatus {
  available: boolean
  downloaded: boolean
  version: string | null
  checking: boolean
  error: string | null
}

let checking = false
let lastError: string | null = null

/**
 * Returns the current auto-update status (for UI display).
 */
export function getUpdateStatus(): UpdateStatus {
  return {
    available: updateAvailable,
    downloaded: updateDownloaded,
    version: updateVersion,
    checking,
    error: lastError,
  }
}

/**
 * Initializes auto-updater event listeners and performs first check.
 * Should only be called in packaged builds (app.isPackaged).
 */
export function initAutoUpdater(): void {
  autoUpdater.logger = null // We use our own logger
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    checking = true
    lastError = null
    logger.info('Checking for updates...')
  })

  autoUpdater.on('update-available', (info) => {
    checking = false
    updateAvailable = true
    updateVersion = info.version
    logger.info(`Update available: v${info.version}`)
  })

  autoUpdater.on('update-not-available', () => {
    checking = false
    updateAvailable = false
    logger.debug('No update available')
  })

  autoUpdater.on('download-progress', (progress) => {
    logger.debug(`Download progress: ${Math.round(progress.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true
    updateVersion = info.version
    logger.info(`Update downloaded: v${info.version}`)

    // Notify the user
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `HITL v${info.version} has been downloaded.`,
        detail: 'The update will be installed when you restart the app.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true)
        }
      })
    }
  })

  autoUpdater.on('error', (err) => {
    checking = false
    lastError = err.message
    logger.error(`Auto-update error: ${err.message}`)
  })

  // Check on startup (after short delay to let app initialize)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error(`Failed to check for updates: ${err.message}`)
    })
  }, 10_000)

  // Check periodically (every 4 hours)
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error(`Failed to check for updates: ${err.message}`)
    })
  }, 4 * 60 * 60 * 1000)
}

/**
 * Manually triggers an update check.
 */
export async function checkForUpdates(): Promise<void> {
  await autoUpdater.checkForUpdates()
}

/**
 * Quits and installs the downloaded update.
 */
export function installUpdate(): void {
  if (updateDownloaded) {
    autoUpdater.quitAndInstall(false, true)
  }
}
