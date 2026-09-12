import {
  type ColumnDef,
  type RowData,
  columnVisibilityFeature,
  coreFeatures,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * TanStack Table 9 registers features per table instead of bundling every stock
 * feature, and that set became part of each public type: `ColumnDef` now takes
 * `<TFeatures, TData, TValue>` rather than `<TData>`.
 *
 * The core set provides table/column/row/header/cell behavior and the core row
 * model. This app additionally needs `columnVisibilityFeature`, because
 * `row.getVisibleCells()` — how `DataTable` emits one cell per column — left core
 * and joined that feature. Nothing here sorts, filters, paginates or selects
 * through the table: sort animation lives in `use-sort-animation` and in the GSAP
 * row transitions inside `DataTable`. So the remaining stock features stay
 * unbuilt instead of being pulled in wholesale by `stockFeatures`.
 */
export const features = tableFeatures({
  ...coreFeatures,
  columnVisibilityFeature,
});

/** A column definition for this app's table configuration. */
export type Column<TData extends RowData> = ColumnDef<typeof features, TData>;
