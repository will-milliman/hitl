import React, { useState, useEffect, useCallback } from "react";
import styled from "styled-components";
import { trpc } from "../../trpc/client";
import { LogViewer } from "../LogViewer/LogViewer";
import { SettingsPage } from "../Settings/SettingsPage";

const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: ${({ theme }) => theme.colors.base};
`;

const TitleBar = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  padding-left: ${({ theme }) => theme.spacing.lg};
  background: ${({ theme }) => theme.colors.crust};
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
  -webkit-app-region: drag;
  user-select: none;
  height: 36px;
  flex-shrink: 0;
`;

const Title = styled.h1`
  font-size: 13px;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.text};
  letter-spacing: 1.5px;
  text-transform: uppercase;

  span {
    color: ${({ theme }) => theme.colors.mauve};
  }
`;

const WindowControls = styled.div`
  display: flex;
  align-items: stretch;
  height: 100%;
  -webkit-app-region: no-drag;
`;

const WindowButton = styled.button`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.overlay1};
  font-size: 12px;
  cursor: pointer;
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s;

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`;

const CloseButton = styled(WindowButton)`
  &:hover {
    background: #e81123;
    color: #ffffff;
  }
`;

const ContentArea = styled.div`
  display: flex;
  flex: 1;
  overflow: hidden;
`;

const Content = styled.main`
  flex: 1;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.lg};
`;

const StatusSidebar = styled.aside`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spacing.sm};
  margin-right: ${({ theme }) => theme.spacing.lg};
  margin-top: ${({ theme }) => theme.spacing.lg};
  margin-bottom: ${({ theme }) => theme.spacing.lg};
  padding: ${({ theme }) => theme.spacing.md};
  background: ${({ theme }) => theme.colors.mantle};
  border: 1px solid ${({ theme }) => theme.colors.surface0};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.overlay1};
  min-width: 200px;
  overflow-y: auto;
`;

const StatusGroup = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
`;

const StatusDot = styled.div<{ $color: string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ $color }) => $color};
  flex-shrink: 0;
`;

export interface CronStatusInfo {
  running: boolean;
  idle: boolean;
  lastRunAt: Date | string | null;
  lastError: string | null;
  azureConfigured: boolean;
  githubConfigured?: boolean;
  activeWatchers?: number;
  stepErrors?: Record<string, string>;
}

interface LayoutProps {
  children: React.ReactNode;
  connected?: boolean;
  cronStatus?: CronStatusInfo | null;
}

function formatRelativeTime(date: Date | string | null): string {
  if (!date) return "never";
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function Layout({
  children,
  connected = false,
  cronStatus,
}: LayoutProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const windowMinimize = trpc.windowMinimize.useMutation();
  const windowMaximize = trpc.windowMaximize.useMutation({
    onSuccess: () => {
      // Refetch maximized state after toggling
      windowIsMaximizedQuery.refetch();
    },
  });
  const windowClose = trpc.windowClose.useMutation();

  const windowIsMaximizedQuery = trpc.windowIsMaximized.useQuery(undefined, {
    refetchInterval: 2000,
    onSuccess: (data) => {
      setIsMaximized(data.maximized);
    },
  });

  // Keyboard shortcut: Ctrl+, to open settings
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
      // Escape to close settings
      if (e.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
      }
    },
    [settingsOpen],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <Shell>
      <TitleBar>
        <Title>
          <span>HITL</span>
        </Title>
        <WindowControls>
          <WindowButton
            onClick={() => windowMinimize.mutate()}
            title="Minimize"
          >
            &#x2500;
          </WindowButton>
          <WindowButton
            onClick={() => windowMaximize.mutate()}
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? "\u29C9" : "\u25A1"}
          </WindowButton>
          <CloseButton onClick={() => windowClose.mutate()} title="Close">
            &#x2715;
          </CloseButton>
        </WindowControls>
      </TitleBar>
      <ContentArea>
        <Content>{children}</Content>
        <StatusSidebar>
          {cronStatus && (
            <>
              {/* Azure connection status */}
              <StatusGroup
                title={
                  cronStatus.azureConfigured
                    ? "Azure DevOps connected"
                    : "Azure DevOps not configured"
                }
              >
                <StatusDot
                  $color={cronStatus.azureConfigured ? "#a6e3a1" : "#fab387"}
                />
                {cronStatus.azureConfigured ? "Azure" : "No Azure"}
              </StatusGroup>

              {/* GitHub connection status */}
              <StatusGroup
                title={
                  cronStatus.githubConfigured
                    ? "GitHub connected (gh CLI)"
                    : "GitHub not configured (run gh auth login)"
                }
              >
                <StatusDot
                  $color={cronStatus.githubConfigured ? "#a6e3a1" : "#fab387"}
                />
                {cronStatus.githubConfigured ? "GitHub" : "No GitHub"}
              </StatusGroup>
            </>
          )}

          {/* Database connection */}
          <StatusGroup>
            <StatusDot $color={connected ? "#a6e3a1" : "#f38ba8"} />
            {connected ? "Database" : "Initializing"}
          </StatusGroup>

          {cronStatus && (
            <>
              {/* Active session watchers */}
              <StatusGroup
                title={`${cronStatus.activeWatchers ?? 0} active session watchers`}
              >
                <StatusDot
                  $color={
                    (cronStatus.activeWatchers ?? 0) > 0 ? "#89b4fa" : "#6c7086"
                  }
                />
                {(cronStatus.activeWatchers ?? 0) > 0
                  ? `${cronStatus.activeWatchers} sessions`
                  : "No sessions"}
              </StatusGroup>
            </>
          )}

          {cronStatus && (
            <>
              {/* Last sync time */}
              <StatusGroup
                title={
                  cronStatus.lastError
                    ? `Error: ${cronStatus.lastError}${
                        cronStatus.stepErrors
                          ? "\n\n" +
                            Object.entries(cronStatus.stepErrors)
                              .map(([step, err]) => `${step}: ${err}`)
                              .join("\n")
                          : ""
                      }`
                    : `Last sync: ${cronStatus.lastRunAt ?? "never"}`
                }
              >
                <StatusDot
                  $color={
                    cronStatus.lastError
                      ? "#f38ba8"
                      : cronStatus.running
                        ? "#89b4fa"
                        : "#6c7086"
                  }
                />
                {cronStatus.running
                  ? "Syncing..."
                  : cronStatus.lastError
                    ? "Sync error"
                    : `Sync ${formatRelativeTime(cronStatus.lastRunAt)}`}
              </StatusGroup>
            </>
          )}
        </StatusSidebar>
      </ContentArea>
      <LogViewer onSettingsOpen={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
    </Shell>
  );
}
