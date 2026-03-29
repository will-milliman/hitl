import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ActionLink, Placeholder, ErrorIndicator } from '../components/common'
import { trpc } from '../trpc/client'
import type { Story } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Story>()

interface PlanApprovalGridProps {
  stories: Story[]
}

export function PlanApprovalGrid({ stories }: PlanApprovalGridProps) {
  const utils = trpc.useContext()
  const openVSCode = trpc.openInVSCode.useMutation()
  const openTerminal = trpc.openInTerminal.useMutation()
  const openExternal = trpc.openExternal.useMutation()
  const openSession = trpc.openSession.useMutation()
  const approvePlanMutation = trpc.approvePlan.useMutation({
    onSuccess: () => {
      utils.stories.invalidate()
      utils.tasks.invalidate()
    },
  })

  const columns = useMemo(
    () => [
      columnHelper.accessor('id', {
        header: 'Story Id',
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Story Title',
      }),
      columnHelper.accessor('worktreePath', {
        header: 'Worktree',
        cell: (info) => {
          const path = info.getValue()
          if (!path) return <Placeholder />
          return (
            <ActionLink
              onClick={() => openVSCode.mutate({ path })}
              title={`Open ${path} in VS Code`}
            >
              Open in VS Code
            </ActionLink>
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
      columnHelper.display({
        id: 'workspace',
        header: 'Workspace',
        cell: (info) => {
          const row = info.row.original
          if (!row.worktreePath) return <Placeholder />
          return (
            <ActionLink
              onClick={() => {
                openVSCode.mutate({ path: row.worktreePath! })
                openTerminal.mutate({ path: row.worktreePath! })
                openExternal.mutate({ url: row.azureUrl })
                if (row.sessionId) {
                  openSession.mutate({
                    sessionId: row.sessionId,
                    cwd: row.worktreePath!,
                  })
                }
              }}
              title="Open VS Code, Terminal, Session, and Azure work item"
            >
              Open All
            </ActionLink>
          )
        },
      }),
      columnHelper.display({
        id: 'approve',
        header: 'Action',
        cell: (info) => {
          const row = info.row.original
          // Only show approve button when:
          // - Story is not disabled (session is idle/done)
          // - Story has a session (planning was done)
          if (row.disabled || !row.sessionId) return <Placeholder text="" />
          return (
            <ActionLink
              onClick={() => {
                if (confirm(`Approve plan for Story #${row.id}?\n\nThis will create tasks and move the story to Task PR Review.`)) {
                  approvePlanMutation.mutate({ storyId: row.id })
                }
              }}
              title="Approve the plan and create tasks"
            >
              Approve Plan
            </ActionLink>
          )
        },
      }),
    ],
    [openVSCode, openTerminal, openExternal, openSession, approvePlanMutation]
  )

  return (
    <Grid
      title="Plan Approval"
      data={stories}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.blue}
    />
  )
}
