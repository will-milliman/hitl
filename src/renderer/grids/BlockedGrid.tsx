import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink } from '../components/common'
import type { Task } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Task>()

interface BlockedGridProps {
  tasks: Task[]
}

export function BlockedGrid({ tasks }: BlockedGridProps) {
  const columns = useMemo(
    () => [
      columnHelper.accessor('id', {
        header: 'Task Id',
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.display({
        id: 'story',
        header: 'Story',
        cell: (info) => {
          const story = info.row.original.story
          if (!story) return null
          return (
            <ExternalLink href={story.azureUrl}>
              #{story.id}
            </ExternalLink>
          )
        },
      }),
    ],
    []
  )

  return (
    <Grid
      title="Blocked"
      data={tasks}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.red}
    />
  )
}
