import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ActionLink, Placeholder, formatRelativeTime } from '../components/common'
import { trpc } from '../trpc/client'
import type { Story, Task } from '../../shared/types'
import { theme } from '../styles/theme'
import styled from 'styled-components'

const columnHelper = createColumnHelper<Story>()

const ErrorBadge = styled.span`
  color: ${({ theme }) => theme.colors.red};
  font-size: 11px;
  cursor: help;
`

const CompletedDate = styled.span`
  color: ${({ theme }) => theme.colors.subtext0};
  font-size: 11px;
`

const TaskList = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.subtext0};
  padding: 4px 0;
`

const TaskItem = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
`

const TaskCheckmark = styled.span`
  color: ${({ theme }) => theme.colors.green};
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
  stories: Story[]
  tasks: Task[]
}

export function CompletedGrid({ stories, tasks }: CompletedGridProps) {
  const openSession = trpc.openSession.useMutation()

  // Group tasks by storyId for display
  const tasksByStory = useMemo(() => {
    const grouped: Record<number, Task[]> = {}
    for (const task of tasks) {
      if (!grouped[task.storyId]) grouped[task.storyId] = []
      grouped[task.storyId].push(task)
    }
    return grouped
  }, [tasks])

  const columns = useMemo(
    () => [
      columnHelper.accessor('id', {
        header: 'Id',
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Title',
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
      columnHelper.display({
        id: 'tasks',
        header: 'Tasks',
        cell: (info) => {
          const storyTasks = tasksByStory[info.row.original.id] ?? []
          if (storyTasks.length === 0) return <Placeholder />
          return (
            <TaskList>
              {storyTasks.map((task) => (
                <TaskItem key={task.id}>
                  <TaskCheckmark>{task.prMerged ? '✓' : '○'}</TaskCheckmark>
                  <ExternalLink href={task.azureUrl}>
                    #{task.id}
                  </ExternalLink>
                  <span>{task.title}</span>
                </TaskItem>
              ))}
            </TaskList>
          )
        },
      }),
      columnHelper.accessor('errorMessage', {
        header: 'Status',
        cell: (info) => {
          const error = info.getValue()
          if (!error) return <CompletedDate>OK</CompletedDate>
          return (
            <ErrorBadge title={error}>
              Error
            </ErrorBadge>
          )
        },
      }),
    ],
    [openSession, tasksByStory]
  )

  return (
    <Grid
      title="Completed"
      data={stories}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.green}
    />
  )
}
