import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ActionLink, Placeholder, formatRelativeTime } from '../components/common'
import { trpc } from '../trpc/client'
import type { Task } from '../../shared/types'
import { theme } from '../styles/theme'
import styled from 'styled-components'

const columnHelper = createColumnHelper<Task>()

const CompletedDate = styled.span`
  color: ${({ theme }) => theme.colors.subtext0};
  font-size: 11px;
`

function formatCompletedDate(date: Date | string | null): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface CompletedGridProps {
  tasks: Task[]
}

export function CompletedGrid({ tasks }: CompletedGridProps) {
  const openSession = trpc.openSession.useMutation()

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
      columnHelper.accessor('completedAt', {
        header: 'Completed',
        cell: (info) => {
          const completedAt = info.getValue()
          if (!completedAt) return <Placeholder />
          return (
            <CompletedDate title={formatCompletedDate(completedAt)}>
              {formatRelativeTime(completedAt)}
            </CompletedDate>
          )
        },
      }),
      columnHelper.accessor('sessionId', {
        header: 'Session',
        cell: (info) => {
          const sessionId = info.getValue()
          const worktreePath = info.row.original.worktreePath
          if (!sessionId) return <Placeholder />
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath })
                }
              }}
              title={`Open session ${sessionId} in terminal`}
            >
              {sessionId.substring(0, 8)}...
            </ActionLink>
          )
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Pull Request',
        cell: (info) => {
          const prUrl = info.getValue()
          if (!prUrl) return <Placeholder />
          return (
            <ExternalLink href={prUrl}>
              {prUrl.split('/').pop()}
            </ExternalLink>
          )
        },
      }),
    ],
    [openSession]
  )

  return (
    <Grid
      title="Completed"
      data={tasks}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.green}
    />
  )
}
