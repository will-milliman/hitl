import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

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

interface TaskExecutionGridProps {
  tasks: Task[];
  profiles: ProfileMap;
}

export function TaskExecutionGrid({ tasks, profiles }: TaskExecutionGridProps) {
  const openVSCode = trpc.openInVSCode.useMutation();
  const openTerminal = trpc.openInTerminal.useMutation();
  const openExternal = trpc.openExternal.useMutation();
  const openSession = trpc.openSession.useMutation();
  const startCopilotSession = trpc.startCopilotSession.useMutation();
  const createVirtualDesktop = trpc.createVirtualDesktop.useMutation();
  const closeVirtualDesktop = trpc.closeVirtualDesktop.useMutation();

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
          const skipCopilot = info.row.original.skipCopilot;
          const taskId = info.row.original.id;

          // Manual mode: no session yet, show "Start" link
          if (!sessionId && skipCopilot && worktreePath) {
            return (
              <ActionLink
                onClick={() => startCopilotSession.mutate({ cwd: worktreePath, taskId })}
                title="Start a new copilot session in this worktree"
              >
                Start
              </ActionLink>
            );
          }

          if (!sessionId && disabled) {
            return <ActivityIndicator tooltip="Starting session..." />;
          }
          if (!sessionId) return <Placeholder />;
          if (disabled) {
            return (
              <ActionLink
                onClick={() => {
                  if (worktreePath) {
                    openSession.mutate({ sessionId, cwd: worktreePath });
                  }
                }}
                title={`Copilot session ${sessionId} is active — click to open in terminal`}
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
              title={`Open Copilot session ${sessionId} in terminal`}
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
            <ActionLink onClick={() => openVSCode.mutate({ path, workspace })} title={`Open ${workspace ?? path} in VS Code`}>
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
                } else if (row.skipCopilot) {
                  // Manual mode: start a fresh copilot session
                  opens.push(
                    startCopilotSession
                      .mutateAsync({ cwd: row.worktreePath!, taskId: row.id })
                      .catch((e) => console.error('[grid] startCopilotSession failed:', e)),
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
              title="Open VS Code, Copilot session, and Azure work item on a new virtual desktop"
            >
              Open
            </ActionLink>
          );
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Draft PR',
        meta: { shrink: true, minWidth: 120 },
        cell: (info) => {
          const prUrl = info.getValue();
          if (!prUrl) return <Placeholder />;
          return <ExternalLink href={prUrl}>{prUrl.split('/').pop()}</ExternalLink>;
        },
      }),
    ],
    [
      openVSCode,
      openTerminal,
      openExternal,
      openSession,
      startCopilotSession,
      createVirtualDesktop,
      closeVirtualDesktop,
      openDesktops,
      profiles,
    ],
  );

  return (
    <Grid
      title="Task Execution"
      data={tasks}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.blue}
    />
  );
}
