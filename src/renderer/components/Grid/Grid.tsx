import React, { useState, useEffect, useRef } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getGroupedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type GroupingState,
} from "@tanstack/react-table";
import styled from "styled-components";

const Section = styled.div`
  margin-bottom: ${({ theme }) => theme.spacing.md};
`;

const Header = styled.button`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
  width: 100%;
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.md}`};
  background: ${({ theme }) => theme.colors.surface0};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
  color: ${({ theme }) => theme.colors.text};
  font-family: ${({ theme }) => theme.fonts.sans};
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover {
    background: ${({ theme }) => theme.colors.surface1};
  }
`;

const Chevron = styled.span<{ $expanded: boolean }>`
  display: inline-block;
  transition: transform 0.2s ease;
  transform: rotate(${({ $expanded }) => ($expanded ? "90deg" : "0deg")});
  font-size: 12px;
  color: ${({ theme }) => theme.colors.overlay1};
`;

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: ${({ theme }) => theme.colors.surface2};
  color: ${({ theme }) => theme.colors.subtext0};
  font-size: 9px;
  font-weight: 600;
`;

const TableWrapper = styled.div<{ $visible: boolean }>`
  display: ${({ $visible }) => ($visible ? "block" : "none")};
  border-left: 1px solid ${({ theme }) => theme.colors.surface0};
  border-right: 1px solid ${({ theme }) => theme.colors.surface0};
  overflow: hidden;
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
`;

const Th = styled.th`
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.md}`};
  background: ${({ theme }) => theme.colors.mantle};
  color: ${({ theme }) => theme.colors.subtext0};
  font-weight: 500;
  text-align: left;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
  cursor: pointer;
  user-select: none;
  white-space: nowrap;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Tr = styled.tr<{ $disabled?: boolean }>`
  opacity: ${({ $disabled }) => ($disabled ? 0.45 : 1)};

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
  }
`;

const Td = styled.td`
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.md}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
  color: ${({ theme }) => theme.colors.text};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
`;

const EmptyState = styled.div`
  padding: ${({ theme }) => theme.spacing.lg};
  text-align: center;
  color: ${({ theme }) => theme.colors.overlay0};
  font-size: 13px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
`;

const SortIndicator = styled.span`
  margin-left: 4px;
  color: ${({ theme }) => theme.colors.overlay0};
`;

interface GridProps<T> {
  title: string;
  data: T[];
  columns: ColumnDef<T, any>[];
  defaultExpanded?: boolean;
  grouping?: string[];
  getRowDisabled?: (row: T) => boolean;
  accentColor?: string;
}

export function Grid<T>({
  title,
  data,
  columns,
  defaultExpanded = true,
  grouping = [],
  getRowDisabled,
  accentColor,
}: GridProps<T>) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [groupingState] = useState<GroupingState>(grouping);

  // Track previous data length to auto collapse/expand
  const prevLengthRef = useRef(data.length);
  useEffect(() => {
    const prevLength = prevLengthRef.current;
    prevLengthRef.current = data.length;

    // Grid became empty — auto collapse
    if (data.length === 0 && prevLength > 0) {
      setExpanded(false);
    }
    // Grid got its first item — auto expand
    if (data.length > 0 && prevLength === 0) {
      setExpanded(true);
    }
  }, [data.length]);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      grouping: groupingState,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: grouping.length > 0 ? getGroupedRowModel() : undefined,
  });

  return (
    <Section>
      <Header onClick={() => setExpanded(!expanded)}>
        <Chevron
          style={{
            color: accentColor,
          }}
          $expanded={expanded}
        >
          &#9654;
        </Chevron>
        {title}
        <Badge>{data.length}</Badge>
      </Header>
      <TableWrapper $visible={expanded}>
        {data.length === 0 ? (
          <EmptyState>No items</EmptyState>
        ) : (
          <Table>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <Th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      style={
                        (header.column.columnDef.meta as any)?.fixedWidth
                          ? {
                              width: (header.column.columnDef.meta as any)
                                .fixedWidth,
                              maxWidth: (header.column.columnDef.meta as any)
                                .fixedWidth,
                            }
                          : (header.column.columnDef.meta as any)?.shrink
                            ? {
                                width: "1px",
                                minWidth: (header.column.columnDef.meta as any)
                                  .minWidth,
                              }
                            : undefined
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                      <SortIndicator>
                        {{ asc: " ↑", desc: " ↓" }[
                          header.column.getIsSorted() as string
                        ] ?? ""}
                      </SortIndicator>
                    </Th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <Tr key={row.id} $disabled={getRowDisabled?.(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <Td
                      key={cell.id}
                      style={
                        (cell.column.columnDef.meta as any)?.fixedWidth
                          ? {
                              width: (cell.column.columnDef.meta as any)
                                .fixedWidth,
                              maxWidth: (cell.column.columnDef.meta as any)
                                .fixedWidth,
                            }
                          : (cell.column.columnDef.meta as any)?.shrink
                            ? { width: "1px" }
                            : undefined
                      }
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </TableWrapper>
    </Section>
  );
}
