import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink } from '../components/common'
import type { Story } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Story>()

interface BlockedGridProps {
  stories: Story[]
}

export function BlockedGrid({ stories }: BlockedGridProps) {
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
    ],
    []
  )

  return (
    <Grid
      title="Blocked"
      data={stories}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.red}
    />
  )
}
