import React, { useMemo } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Grid } from "../components/Grid";
import { ExternalLink, StatusIndicator } from "../components/common";
import type { Task } from "../../shared/types";
import { theme } from "../styles/theme";

const columnHelper = createColumnHelper<Task>();

interface BlockedGridProps {
  tasks: Task[];
}

export function BlockedGrid({ tasks }: BlockedGridProps) {
  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "status",
        header: "",
        meta: { fixedWidth: 20 },
        cell: (info) => (
          <StatusIndicator
            errorMessage={info.row.original.errorMessage}
            disabled={info.row.original.disabled}
          />
        ),
      }),
      columnHelper.accessor("id", {
        header: "Task Id",
        meta: { fixedWidth: 70 },
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor("title", {
        header: "Task Title",
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
