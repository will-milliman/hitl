/**
 * Notification module — sends OS-level notifications at key lifecycle events.
 *
 * Events that trigger notifications:
 * - Plan approval ready (story moved to PLAN_APPROVAL with session finished)
 * - PR review needed (story or task PR has review comments)
 * - Cron step errors
 * - All tasks merged (story ready for story PR)
 * - Story PR merged (story completed)
 *
 * Notifications respect user preferences stored in settings.
 */

import { Notification, BrowserWindow } from 'electron'
import { createLogger } from '../logger'
import { loadSettings } from '../settings'

const logger = createLogger('notify')

/** Notification types that map to user preferences */
type NotificationType = 'planApprovalReady' | 'prReviewNeeded' | 'cronErrors'

/**
 * Checks if a notification type is enabled in settings.
 */
function isEnabled(type: NotificationType): boolean {
  try {
    const settings = loadSettings()
    if (!settings.notifications.enabled) return false
    return settings.notifications[type] ?? false
  } catch {
    return false
  }
}

/**
 * Shows an OS notification if the type is enabled.
 */
function show(title: string, body: string, type: NotificationType): void {
  if (!isEnabled(type)) return
  if (!Notification.isSupported()) {
    logger.debug(`Notifications not supported on this platform`)
    return
  }

  try {
    const notification = new Notification({
      title,
      body,
      silent: false,
    })

    notification.on('click', () => {
      // Bring the main window to focus
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        const win = wins[0]
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })

    notification.show()
    logger.debug(`Notification shown: ${title}`)
  } catch (err) {
    logger.error(`Failed to show notification: ${err}`)
  }
}

// ─── Public API ────────────────────────────────────────

/**
 * Notify that a plan is ready for approval.
 */
export function notifyPlanReady(storyId: number, storyTitle: string): void {
  show(
    'Plan Ready for Approval',
    `Story #${storyId}: ${storyTitle}`,
    'planApprovalReady'
  )
}

/**
 * Notify that a PR has review comments needing attention.
 */
export function notifyPrReviewNeeded(
  itemType: 'story' | 'task',
  itemId: number,
  itemTitle: string,
  commentCount: number
): void {
  show(
    `PR Review Comments (${itemType} #${itemId})`,
    `${commentCount} unresolved comment(s) on "${itemTitle}"`,
    'prReviewNeeded'
  )
}

/**
 * Notify that all tasks are merged for a story.
 */
export function notifyAllTasksMerged(storyId: number, storyTitle: string): void {
  show(
    'All Tasks Merged',
    `Story #${storyId}: ${storyTitle} — ready for story PR`,
    'planApprovalReady'
  )
}

/**
 * Notify that a story PR has been merged (completed).
 */
export function notifyStoryCompleted(storyId: number, storyTitle: string): void {
  show(
    'Story Completed',
    `Story #${storyId}: ${storyTitle}`,
    'planApprovalReady'
  )
}

/**
 * Notify that a cron step failed.
 */
export function notifyCronError(stepName: string, errorMessage: string): void {
  show(
    `Cron Error: ${stepName}`,
    errorMessage.slice(0, 200),
    'cronErrors'
  )
}
