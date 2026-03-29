import React, { useState, useEffect, useCallback } from 'react'
import styled from 'styled-components'
import { LogViewer } from '../LogViewer/LogViewer'
import { SettingsPage } from '../Settings/SettingsPage'

const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: ${({ theme }) => theme.colors.base};
`

const TitleBar = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.lg}`};
  background: ${({ theme }) => theme.colors.crust};
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
  -webkit-app-region: drag;
  user-select: none;
`

const Title = styled.h1`
  font-size: 15px;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.text};
  letter-spacing: 1.5px;
  text-transform: uppercase;

  span {
    color: ${({ theme }) => theme.colors.mauve};
  }
`

const StatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.md};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.overlay1};
  -webkit-app-region: no-drag;
`

const StatusGroup = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.xs};
`

const StatusDot = styled.div<{ $color: string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ $color }) => $color};
`

const Separator = styled.div`
  width: 1px;
  height: 14px;
  background: ${({ theme }) => theme.colors.surface1};
`

const Content = styled.main`
  flex: 1;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.lg};
`

const SettingsButton = styled.button`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.overlay1};
  font-size: 14px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: ${({ theme }) => theme.radii.sm};
  -webkit-app-region: no-drag;
  transition: color 0.15s, background 0.15s;

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`

export interface CronStatusInfo {
  running: boolean
  idle: boolean
  lastRunAt: Date | string | null
  lastError: string | null
  azureConfigured: boolean
  githubConfigured?: boolean
  activeWatchers?: number
  stepErrors?: Record<string, string>
}

interface LayoutProps {
  children: React.ReactNode
  connected?: boolean
  cronStatus?: CronStatusInfo | null
}

function formatRelativeTime(date: Date | string | null): string {
  if (!date) return 'never'
  const d = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export function Layout({ children, connected = false, cronStatus }: LayoutProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Keyboard shortcut: Ctrl+, to open settings
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault()
      setSettingsOpen((prev) => !prev)
    }
    // Escape to close settings
    if (e.key === 'Escape' && settingsOpen) {
      setSettingsOpen(false)
    }
  }, [settingsOpen])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <Shell>
      <TitleBar>
        <Title>
          <span>HITL</span> Orchestrator
        </Title>
        <StatusBar>
          {cronStatus && (
            <>
              {/* Azure connection status */}
              <StatusGroup title={
                cronStatus.azureConfigured
                  ? 'Azure DevOps connected'
                  : 'Azure DevOps not configured'
              }>
                <StatusDot
                  $color={cronStatus.azureConfigured ? '#a6e3a1' : '#fab387'}
                />
                {cronStatus.azureConfigured ? 'Azure' : 'No Azure'}
              </StatusGroup>

              <Separator />

              {/* GitHub connection status */}
              <StatusGroup title={
                cronStatus.githubConfigured
                  ? 'GitHub connected (gh CLI)'
                  : 'GitHub not configured (run gh auth login)'
              }>
                <StatusDot
                  $color={cronStatus.githubConfigured ? '#a6e3a1' : '#fab387'}
                />
                {cronStatus.githubConfigured ? 'GitHub' : 'No GitHub'}
              </StatusGroup>

              <Separator />

              {/* Idle status */}
              <StatusGroup title={
                cronStatus.idle
                  ? 'System idle — cron paused'
                  : 'System active'
              }>
                <StatusDot
                  $color={cronStatus.idle ? '#f9e2af' : '#a6e3a1'}
                />
                {cronStatus.idle ? 'Idle' : 'Active'}
              </StatusGroup>

              <Separator />

              {/* Last sync time */}
              <StatusGroup title={
                cronStatus.lastError
                  ? `Error: ${cronStatus.lastError}${
                      cronStatus.stepErrors
                        ? '\n\n' + Object.entries(cronStatus.stepErrors)
                            .map(([step, err]) => `${step}: ${err}`)
                            .join('\n')
                        : ''
                    }`
                  : `Last sync: ${cronStatus.lastRunAt ?? 'never'}`
              }>
                <StatusDot
                  $color={
                    cronStatus.lastError
                      ? '#f38ba8'
                      : cronStatus.running
                        ? '#89b4fa'
                        : '#6c7086'
                  }
                />
                {cronStatus.running
                  ? 'Syncing...'
                  : cronStatus.lastError
                    ? 'Sync error'
                    : `Sync ${formatRelativeTime(cronStatus.lastRunAt)}`
                }
              </StatusGroup>

              <Separator />

              {/* Active session watchers */}
              <StatusGroup title={`${cronStatus.activeWatchers ?? 0} active session watchers`}>
                <StatusDot
                  $color={(cronStatus.activeWatchers ?? 0) > 0 ? '#89b4fa' : '#6c7086'}
                />
                {(cronStatus.activeWatchers ?? 0) > 0
                  ? `${cronStatus.activeWatchers} sessions`
                  : 'No sessions'
                }
              </StatusGroup>

              <Separator />
            </>
          )}

          {/* DB connection */}
          <StatusGroup>
            <StatusDot $color={connected ? '#a6e3a1' : '#f38ba8'} />
            {connected ? 'DB' : 'Initializing'}
          </StatusGroup>

          <Separator />

          {/* Settings gear */}
          <SettingsButton
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            Settings
          </SettingsButton>
        </StatusBar>
      </TitleBar>
      <Content>{children}</Content>
      <LogViewer />
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
    </Shell>
  )
}
