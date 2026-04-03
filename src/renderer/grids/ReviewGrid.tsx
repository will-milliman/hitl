import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';
import styled from 'styled-components';

import { GridState } from '../../shared/constants';
import type { ProfileMap, Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import {
  ActionLink,
  ActivityIndicator,
  ExternalLink,
  Placeholder,
  StatusIndicator,
  WorkItemTypeIcon,
} from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

const GridButton = styled.button<{ $color: string }>`
  background: ${({ $color }) => $color};
  color: ${({ theme }) => theme.colors.base};
  border: none;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.sans};
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
`;

interface ReviewGridProps {
  tasks: Task[];
  profiles: ProfileMap;
}

export function ReviewGrid({ tasks, profiles }: ReviewGridProps) {
  const openVSCode = trpc.openInVSCode.useMutation();
  const openTerminal = trpc.openInTerminal.useMutation();
  const openExternal = trpc.openExternal.useMutation();
  const openSession = trpc.openSession.useMutation();
  const createVirtualDesktop = trpc.createVirtualDesktop.useMutation();
  const closeVirtualDesktop = trpc.closeVirtualDesktop.useMutation();
  const startFixSession = trpc.startFixSession.useMutation();

  // Track which task IDs have an open virtual desktop
  const [openDesktops, setOpenDesktops] = React.useState<Set<number>>(() => new Set());

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: (info) => <StatusIndicator errorMessage={info.row.original.errorMessage} disabled={info.row.original.disabled} />,
      }),
      columnHelper.accessor('id', {
        header: 'Task Id',
        meta: { fixedWidth: 90 },
        cell: (info) => (
          <>
            <WorkItemTypeIcon type={info.row.original.workItemType} />{' '}
            <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>
          </>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.accessor('sessionId', {
        header: 'Copilot Session',
        meta: { shrink: true },
        cell: (info) => {
          const sessionId = info.getValue();
          const worktreePath = info.row.original.worktreePath;
          const disabled = info.row.original.disabled;
          const state = info.row.original.state;
          // In PR_REVIEW, disabled means the PR is not ready to merge —
          // it does NOT mean a copilot session is active. Only treat
          // disabled as "session active" in TASK_EXECUTION state.
          const sessionActive = disabled && state !== GridState.PR_REVIEW;
          if (!sessionId && sessionActive) {
            return <ActivityIndicator tooltip="Starting session..." />;
          }
          if (!sessionId) return <Placeholder />;
          if (sessionActive) {
            return (
              <ActionLink
                onClick={() => {
                  if (worktreePath) {
                    openSession.mutate({ sessionId, cwd: worktreePath });
                  }
                }}
                title={`Session ${sessionId} is active — click to open in terminal`}
              >
                <ActivityIndicator tooltip={`Active session: ${sessionId}`} />
              </ActionLink>
            );
          }
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath });
                }
              }}
              title={`Open session ${sessionId} in terminal`}
            >
              {sessionId}
            </ActionLink>
          );
        },
      }),
      columnHelper.accessor('worktreePath', {
        header: 'IDE',
        meta: { fixedWidth: 200 },
        cell: (info) => {
          const path = info.getValue();
          const profileKey = info.row.original.profileKey;
          const workspace = profileKey ? profiles[profileKey]?.workspace : undefined;
          if (!path) return <Placeholder />;
          return (
            <ActionLink onClick={() => openVSCode.mutate({ path, workspace })} title={`Open ${path} in VS Code`}>
              {(workspace ?? path).split('\\').pop()}
            </ActionLink>
          );
        },
      }),
      columnHelper.display({
        id: 'workspace',
        header: 'Virtual Desktop',
        meta: { shrink: true },
        cell: (info) => {
          const row = info.row.original;
          if (!row.worktreePath) return <Placeholder />;
          const workspace = row.profileKey ? profiles[row.profileKey]?.workspace : undefined;
          const isOpen = openDesktops.has(row.id);

          if (isOpen) {
            return (
              <ActionLink
                onClick={async () => {
                  try {
                    await closeVirtualDesktop.mutateAsync({
                      name: `Task #${row.id}`,
                    });
                  } catch (e) {
                    console.error('[grid] closeVirtualDesktop failed:', e);
                  }
                  setOpenDesktops((prev) => {
                    const next = new Set(prev);
                    next.delete(row.id);
                    return next;
                  });
                }}
                title="Close all windows and remove this virtual desktop"
              >
                Close
              </ActionLink>
            );
          }

          return (
            <ActionLink
              onClick={async () => {
                try {
                  await createVirtualDesktop.mutateAsync({
                    name: `Task #${row.id}`,
                  });
                } catch (e) {
                  console.error('[grid] createVirtualDesktop failed:', e);
                }
                setOpenDesktops((prev) => new Set(prev).add(row.id));
                const opens: Promise<unknown>[] = [
                  openVSCode
                    .mutateAsync({ path: row.worktreePath!, workspace })
                    .catch((e) => console.error('[grid] openVSCode failed:', e)),
                  openExternal.mutateAsync({ url: row.azureUrl }).catch((e) => console.error('[grid] openExternal failed:', e)),
                ];
                if (row.sessionId) {
                  opens.push(
                    openSession
                      .mutateAsync({
                        sessionId: row.sessionId,
                        cwd: row.worktreePath!,
                      })
                      .catch((e) => console.error('[grid] openSession failed:', e)),
                  );
                } else {
                  opens.push(
                    openTerminal
                      .mutateAsync({ path: row.worktreePath! })
                      .catch((e) => console.error('[grid] openTerminal failed:', e)),
                  );
                }
                if (row.prUrl) {
                  opens.push(
                    openExternal.mutateAsync({ url: row.prUrl }).catch((e) => console.error('[grid] openExternal failed:', e)),
                  );
                }
                await Promise.all(opens);
              }}
              title="Open VS Code, Terminal/Session, Azure work item, and PR on a new virtual desktop"
            >
              Open
            </ActionLink>
          );
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Pull Request',
        meta: { shrink: true, minWidth: 120 },
        cell: (info) => {
          const prUrl = info.getValue();
          if (!prUrl) return <Placeholder />;
          return <ExternalLink href={prUrl}>{prUrl.split('/').pop()}</ExternalLink>;
        },
      }),
      columnHelper.display({
        id: 'fix',
        header: '',
        meta: { fixedWidth: 60 },
        cell: (info) => {
          const row = info.row.original;
          // Show Fix button only when PR is not ready (disabled) and no session is running
          if (!row.disabled || !row.worktreePath || !row.prUrl) return null;
          // If a session is actively running (disabled + sessionId), don't show Fix
          if (row.sessionId) return null;
          return (
            <GridButton
              $color={theme.colors.yellow}
              onClick={() => startFixSession.mutate({ taskId: row.id })}
              disabled={startFixSession.isPending}
              title="Start a copilot session to fix PR issues (failing checks, unresolved comments)"
            >
              Fix
            </GridButton>
          );
        },
      }),
    ],
    [
      openVSCode,
      openTerminal,
      openExternal,
      openSession,
      createVirtualDesktop,
      closeVirtualDesktop,
      startFixSession,
      openDesktops,
      profiles,
    ],
  );

  return (
    <Grid
      title="PR Review"
      data={tasks}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.peach}
    />
  );
}
