import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import {
  ActionLink,
  ActivityIndicator,
  ExternalLink,
  OverflowMenu,
  Placeholder,
  StatusIndicator,
  WorkItemTypeIcon,
} from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

interface CopilotKickoffGridProps {
  tasks: Task[];
}

export function CopilotKickoffGrid({ tasks }: CopilotKickoffGridProps) {
  const utils = trpc.useContext();
  const openSession = trpc.openSession.useMutation({ onSuccess: () => utils.tasks.invalidate() });
  const resetTask = trpc.resetTask.useMutation({ onSuccess: () => utils.tasks.invalidate() });

  // Sort by createdAt ascending (creation order)
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [tasks]);

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
        header: 'Session',
        meta: { shrink: true },
        cell: (info) => {
          const sessionId = info.getValue();
          const worktreePath = info.row.original.worktreePath;
          const disabled = info.row.original.disabled;
          const taskId = info.row.original.id;

          if (!sessionId && disabled) {
            return <ActivityIndicator tooltip="Starting session..." />;
          }
          if (!sessionId) return <Placeholder />;
          if (disabled) {
            return (
              <ActionLink
                onClick={() => {
                  if (worktreePath) {
                    openSession.mutate({ sessionId, cwd: worktreePath, taskId });
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
                  openSession.mutate({ sessionId, cwd: worktreePath, taskId });
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
        header: 'Worktree',
        meta: { shrink: true, minWidth: 120 },
        cell: (info) => {
          const path = info.getValue();
          if (!path) return <Placeholder />;
          // Show just the last segment (worktree folder name)
          const label = path.split(/[\\/]/).pop();
          return <span title={path}>{label}</span>;
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        meta: { fixedWidth: 50, overflowVisible: true },
        cell: (info) => {
          const row = info.row.original;
          return (
            <OverflowMenu
              options={[
                {
                  label: 'Reset',
                  tooltip: 'Clean up the current session and worktree, then move this task back to Profile Assignment',
                  onClick: () => resetTask.mutate({ taskId: row.id }),
                },
              ]}
            />
          );
        },
      }),
    ],
    [openSession, resetTask, utils],
  );

  return (
    <Grid
      title="Copilot Kickoff"
      data={sortedTasks}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.teal}
    />
  );
}
