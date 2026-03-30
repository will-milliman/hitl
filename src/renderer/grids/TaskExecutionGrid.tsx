import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ActionLink, Placeholder, ActivityIndicator, ErrorIndicator } from '../components/common'
import { trpc } from '../trpc/client'
import type { Task, ProfileMap } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Task>()

interface TaskExecutionGridProps {
  tasks: Task[]
  profiles: ProfileMap
}

export function TaskExecutionGrid({ tasks, profiles }: TaskExecutionGridProps) {
  const openVSCode = trpc.openInVSCode.useMutation()
  const openTerminal = trpc.openInTerminal.useMutation()
  const openExternal = trpc.openExternal.useMutation()
  const openSession = trpc.openSession.useMutation()
  const createVirtualDesktop = trpc.createVirtualDesktop.useMutation()

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
      columnHelper.accessor('sessionId', {
        header: 'Copilot Session',
        cell: (info) => {
          const sessionId = info.getValue()
          const worktreePath = info.row.original.worktreePath
          const disabled = info.row.original.disabled
          if (!sessionId && disabled) {
            return <ActivityIndicator tooltip="Starting session..." />
          }
          if (!sessionId) return <Placeholder />
          if (disabled) {
            return (
              <ActionLink
                onClick={() => {
                  if (worktreePath) {
                    openSession.mutate({ sessionId, cwd: worktreePath })
                  }
                }}
                title={`Copilot session ${sessionId} is active — click to open in terminal`}
              >
                <ActivityIndicator tooltip={`Active session: ${sessionId}`} />
              </ActionLink>
            )
          }
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath })
                }
              }}
              title={`Open Copilot session ${sessionId} in terminal`}
            >
              {sessionId.substring(0, 8)}...
            </ActionLink>
          )
        },
      }),
      columnHelper.accessor('worktreePath', {
        header: 'VS Code',
        cell: (info) => {
          const path = info.getValue()
          const profileKey = info.row.original.profileKey
          const workspace = profileKey ? profiles[profileKey]?.workspace : undefined
          if (!path) return <Placeholder />
          return (
            <ActionLink
              onClick={() => openVSCode.mutate({ path, workspace })}
              title={`Open ${workspace ?? path} in VS Code`}
            >
              Open
            </ActionLink>
          )
        },
      }),
      columnHelper.display({
        id: 'workspace',
        header: 'Virtual Desktop',
        cell: (info) => {
          const row = info.row.original
          if (!row.worktreePath) return <Placeholder />
          const workspace = row.profileKey ? profiles[row.profileKey]?.workspace : undefined
          return (
            <ActionLink
              onClick={async () => {
                try {
                  await createVirtualDesktop.mutateAsync({ name: `Task #${row.id}` })
                } catch (e) {
                  console.error('[grid] createVirtualDesktop failed:', e)
                }
                const opens: Promise<unknown>[] = [
                  openVSCode.mutateAsync({ path: row.worktreePath!, workspace }).catch((e) => console.error('[grid] openVSCode failed:', e)),
                  openExternal.mutateAsync({ url: row.azureUrl }).catch((e) => console.error('[grid] openExternal failed:', e)),
                ]
                if (row.sessionId) {
                  opens.push(openSession.mutateAsync({ sessionId: row.sessionId, cwd: row.worktreePath! }).catch((e) => console.error('[grid] openSession failed:', e)))
                } else {
                  opens.push(openTerminal.mutateAsync({ path: row.worktreePath! }).catch((e) => console.error('[grid] openTerminal failed:', e)))
                }
                await Promise.all(opens)
              }}
              title="Open VS Code, Copilot session, and Azure work item on a new virtual desktop"
            >
              Open
            </ActionLink>
          )
        },
      }),
      columnHelper.accessor('errorMessage', {
        header: 'Status',
        cell: (info) => {
          const error = info.getValue()
          return <ErrorIndicator errorMessage={error} />
        },
      }),
    ],
    [openVSCode, openTerminal, openExternal, openSession, createVirtualDesktop, profiles]
  )

  return (
    <Grid
      title="Task Execution"
      data={tasks}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.blue}
    />
  )
}
