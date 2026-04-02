import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ExternalLink, StatusIndicator, WorkItemTypeIcon } from '../components/common';
import { theme } from '../styles/theme';

const columnHelper = createColumnHelper<Task>();

interface BlockedGridProps {
  tasks: Task[];
}

export function BlockedGrid({ tasks }: BlockedGridProps) {
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
    ],
    [],
  );

  return (
    <Grid
      title="Blocked"
      data={tasks}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.red}
    />
  );
}
