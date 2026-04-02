import React, { useMemo, useState } from 'react';
import styled from 'styled-components';

import { trpc } from '../../trpc/client';

const Panel = styled.div<{ $expanded: boolean }>`
  border-top: 1px solid ${({ theme }) => theme.colors.surface0};
  background: ${({ theme }) => theme.colors.mantle};
  max-height: ${({ $expanded }) => ($expanded ? '300px' : '32px')};
  transition: max-height 0.2s ease;
  display: flex;
  flex-direction: column;
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px ${({ theme }) => theme.spacing.md};
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.subtext0};

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
  }
`;

const PanelTitle = styled.span`
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
`;

const FilterGroup = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`;

const FilterButton = styled.button<{ $active?: boolean }>`
  background: ${({ theme, $active }) => ($active ? theme.colors.surface1 : 'transparent')};
  color: ${({ theme, $active }) => ($active ? theme.colors.text : theme.colors.overlay0)};
  border: 1px solid ${({ theme, $active }) => ($active ? theme.colors.surface2 : 'transparent')};
  padding: 2px 8px;
  font-size: 10px;
  cursor: pointer;
  font-family: ${({ theme }) => theme.fonts.sans};

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`;

const LogList = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 8px;
  font-family: ${({ theme }) => theme.fonts.mono};
  font-size: 11px;
  line-height: 1.5;
`;

const LogLine = styled.div<{ $level: string }>`
  display: flex;
  gap: 8px;
  color: ${({ theme, $level }) => {
    switch ($level) {
      case 'error':
        return theme.colors.red;
      case 'warn':
        return theme.colors.yellow;
      case 'debug':
        return theme.colors.overlay0;
      default:
        return theme.colors.subtext1;
    }
  }};
`;

const LogTimestamp = styled.span`
  color: ${({ theme }) => theme.colors.overlay0};
  flex-shrink: 0;
`;

const LogSource = styled.span`
  color: ${({ theme }) => theme.colors.lavender};
  flex-shrink: 0;
  min-width: 60px;
`;

const LogMessage = styled.span`
  word-break: break-word;
`;

const SettingsButton = styled.button`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.overlay1};
  font-size: 11px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-family: ${({ theme }) => theme.fonts.sans};

  span {
    font-size: 14px;
  }

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

interface LogViewerProps {
  onSettingsOpen?: () => void;
}

export function LogViewer({ onSettingsOpen }: LogViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');

  const logsQuery = trpc.recentLogs.useQuery(
    { limit: 200 },
    {
      refetchInterval: expanded ? 5000 : 30000,
      enabled: true,
    },
  );

  const filteredLogs = useMemo(() => {
    const logs = logsQuery.data ?? [];
    const filtered =
      levelFilter === 'all'
        ? logs
        : (() => {
            const order: Record<string, number> = {
              debug: 0,
              info: 1,
              warn: 2,
              error: 3,
            };
            const minOrder = order[levelFilter] ?? 0;
            return logs.filter((l) => (order[l.level] ?? 0) >= minOrder);
          })();
    return [...filtered].reverse();
  }, [logsQuery.data, levelFilter]);

  const errorCount = useMemo(() => (logsQuery.data ?? []).filter((l) => l.level === 'error').length, [logsQuery.data]);

  const warnCount = useMemo(() => (logsQuery.data ?? []).filter((l) => l.level === 'warn').length, [logsQuery.data]);

  function formatTime(timestamp: string): string {
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return timestamp;
    }
  }

  return (
    <Panel $expanded={expanded}>
      <PanelHeader onClick={() => setExpanded(!expanded)}>
        <PanelTitle>
          {expanded ? '▼' : '▶'} Logs
          {errorCount > 0 && ` (${errorCount} errors)`}
          {warnCount > 0 && errorCount === 0 && ` (${warnCount} warnings)`}
        </PanelTitle>
        <FilterGroup onClick={(e) => e.stopPropagation()}>
          {expanded && (
            <>
              <FilterButton $active={levelFilter === 'all'} onClick={() => setLevelFilter('all')}>
                All
              </FilterButton>
              <FilterButton $active={levelFilter === 'info'} onClick={() => setLevelFilter('info')}>
                Info+
              </FilterButton>
              <FilterButton $active={levelFilter === 'warn'} onClick={() => setLevelFilter('warn')}>
                Warn+
              </FilterButton>
              <FilterButton $active={levelFilter === 'error'} onClick={() => setLevelFilter('error')}>
                Errors
              </FilterButton>
            </>
          )}
          {onSettingsOpen && (
            <SettingsButton onClick={onSettingsOpen} title="Settings (Ctrl+,)">
              <span>&#9881;</span> Settings
            </SettingsButton>
          )}
        </FilterGroup>
      </PanelHeader>
      {expanded && (
        <LogList>
          {filteredLogs.length === 0 ? (
            <LogLine $level="info">No logs yet</LogLine>
          ) : (
            filteredLogs.map((entry, i) => (
              <LogLine key={i} $level={entry.level}>
                <LogTimestamp>{formatTime(entry.timestamp)}</LogTimestamp>
                <LogSource>[{entry.source}]</LogSource>
                <LogMessage>{entry.message}</LogMessage>
              </LogLine>
            ))
          )}
        </LogList>
      )}
    </Panel>
  );
}
