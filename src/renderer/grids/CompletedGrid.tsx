import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';
import styled from 'styled-components';

import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ActionLink, ExternalLink, Placeholder, StatusIndicator, formatRelativeTime } from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

const CompletedDate = styled.span`
  color: ${({ theme }) => theme.colors.subtext0};
  font-size: 11px;
`;

function formatCompletedDate(date: Date | string | null): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface CompletedGridProps {
  tasks: Task[];
}

export function CompletedGrid({ tasks }: CompletedGridProps) {
  const openSession = trpc.openSession.useMutation();

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
        meta: { fixedWidth: 70 },
        cell: (info) => <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>,
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.accessor('completedAt', {
        header: 'Completed',
        meta: { shrink: true },
        cell: (info) => {
          const completedAt = info.getValue();
          if (!completedAt) return <Placeholder />;
          return <CompletedDate title={formatCompletedDate(completedAt)}>{formatRelativeTime(completedAt)}</CompletedDate>;
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
    ],
    [openSession],
  );

  return (
    <Grid
      title="Completed"
      data={tasks}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.green}
    />
  );
}
