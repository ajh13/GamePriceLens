// ═══════════════════════════════════════════════════════════════════════════
// GridTypes.ts — Grid-specific vocabulary. Zero Lens Studio imports.
// Defines track definitions, placement, alignment, and I/O interfaces
// for the pure CSS Grid engine.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Track Definition ───────────────────────────────────────────────────

/** Unit type for a grid track definition. */
export enum GridTrackUnit {
  /** Fixed size in centimeters. */
  Cm = "cm",
  /** Fractional unit — distributes remaining space proportionally. */
  Fr = "fr",
  /**
   * Auto-sized from items' preferred (intrinsic) sizes.
   * The track grows to fit the widest preferred item.
   */
  Auto = "auto",
  /**
   * Sized to the largest min-content of the items in the track.
   * For text items this is the widest unbreakable run (per CSS Sizing 3 §5.1);
   * for rigid content it degenerates to the preferred size.
   */
  MinContent = "min-content",
  /**
   * Sized to the largest max-content of the items in the track.
   * For text items this is the no-wrap width; for unbounded content
   * (`contentMax = Infinity`) it falls back to preferred.
   */
  MaxContent = "max-content",
  /** Range with explicit min and max (e.g. `minmax(2cm, 1fr)`, `minmax(min-content, 1fr)`). */
  MinMax = "minmax"
}

/**
 * Definition of a single grid track (column or row).
 * Parsed from template strings like `"1fr 2cm auto minmax(1cm, 1fr)"`.
 */
export interface GridTrackDef {
  /** Numeric value (e.g. `1` for `1fr`, `2` for `2cm`). Ignored for Auto. */
  readonly value: number
  /** Unit type for this track. */
  readonly unit: GridTrackUnit
  /** Minimum bound (only present when unit is MinMax). */
  readonly min?: GridTrackDef
  /** Maximum bound (only present when unit is MinMax). */
  readonly max?: GridTrackDef
}

// ─── Auto-flow ──────────────────────────────────────────────────────────

/** Controls how auto-placed items fill the grid. Maps to CSS `grid-auto-flow`. */
export enum GridAutoFlow {
  /** Fill rows left-to-right, then move to the next row. */
  Row = "row",
  /** Fill columns top-to-bottom, then move to the next column. */
  Column = "column",
  /** Row flow with dense packing (fills earlier gaps). */
  RowDense = "rowDense",
  /** Column flow with dense packing (fills earlier gaps). */
  ColumnDense = "columnDense"
}

// ─── Item Alignment ─────────────────────────────────────────────────────

/** Alignment for a grid item within its cell. Maps to CSS `justify-self` / `align-self`. */
export enum GridAlign {
  /** Inherit alignment from the container's `justifyItems` / `alignItems`. */
  Auto = "auto",
  /** Align to the start of the cell. */
  Start = "start",
  /** Center within the cell. */
  Center = "center",
  /** Align to the end of the cell. */
  End = "end",
  /** Stretch to fill the entire cell. */
  Stretch = "stretch"
}

// ─── Item Input ─────────────────────────────────────────────────────────

/** Input data for a single grid item, passed to the pure layout engine. */
export interface GridItemInput {
  /** Original index in the items array. */
  index: number
  /** Measured intrinsic width in cm (the content's preferred width). */
  intrinsicWidth: number
  /** Measured intrinsic height in cm (the content's preferred height). */
  intrinsicHeight: number
  /**
   * Content min-content width in cm — widest unbreakable run for text,
   * preferred for rigid content. Consulted by `min-content` track units.
   * Default 0 = no intrinsic minimum.
   */
  contentMinWidth: number
  /** Content min-content height in cm. Symmetric to contentMinWidth. */
  contentMinHeight: number
  /**
   * Content max-content width in cm — no-wrap text width, preferred for
   * rigid content. Consulted by `max-content` track units.
   * Default Infinity = unbounded content (falls back to preferred for sizing).
   */
  contentMaxWidth: number
  /** Content max-content height in cm. Symmetric to contentMaxWidth. */
  contentMaxHeight: number
  /** Minimum width in cm (0 = no minimum). */
  minWidth: number
  /** Maximum width in cm (0 = no maximum). */
  maxWidth: number
  /** Minimum height in cm (0 = no minimum). */
  minHeight: number
  /** Maximum height in cm (0 = no maximum). */
  maxHeight: number
  /** If true, the grid auto-places this item. If false, use gridRow/gridColumn. */
  autoPlacement: boolean
  /** 0-based row index for explicit placement. */
  gridRow: number
  /** 0-based column index for explicit placement. */
  gridColumn: number
  /** Number of rows this item spans (>= 1). */
  rowSpan: number
  /** Number of columns this item spans (>= 1). */
  columnSpan: number
  /** Named grid area from templateAreas. Empty string = no area assignment. */
  gridArea: string
  /** Horizontal alignment override within the cell. Auto = inherit from container. */
  justifySelf: GridAlign
  /** Vertical alignment override within the cell. Auto = inherit from container. */
  alignSelf: GridAlign
  /**
   * Optional fit-content pass. When present, the engine calls it once column
   * tracks are sized, with the width the item will render at, and replaces
   * `intrinsicHeight` / `contentMaxHeight` with the answer before sizing rows.
   * Return `null` to keep the measured intrinsics. Text items wrap taller as
   * columns narrow; rigid content omits this.
   */
  heightForWidth?: (width: number) => number | null
}

// ─── Container Input ────────────────────────────────────────────────────

/** Configuration for the grid container, passed to the pure layout engine. */
export interface GridContainerInput {
  /** Container width in cm. -1 = auto (shrink-to-fit content). */
  readonly width: number
  /** Container height in cm. -1 = auto (shrink-to-fit content). */
  readonly height: number
  /** Column track definitions as a string (e.g. `"1fr 2cm auto"`). Engine parses internally. */
  readonly templateColumns: string
  /** Row track definitions as a string (e.g. `"1fr auto"`). Engine parses internally. */
  readonly templateRows: string
  /** Named grid areas. Rows separated by `"/"` (e.g. `"header header / sidebar content"`). */
  readonly templateAreas: string
  /** Sizing for implicitly created row tracks (e.g. `"1fr"`, `"auto"`). */
  readonly autoRows: string
  /** Sizing for implicitly created column tracks (e.g. `"1fr"`, `"auto"`). */
  readonly autoColumns: string
  /** How auto-placed items fill the grid. */
  readonly autoFlow: GridAutoFlow
  /** Gap between columns in cm. */
  readonly columnGap: number
  /** Gap between rows in cm. */
  readonly rowGap: number
  /** Container padding in cm (top, right, bottom, left). */
  readonly padding: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
  /** Default horizontal alignment for all items in their cells. */
  readonly justifyItems: GridAlign
  /** Default vertical alignment for all items in their cells. */
  readonly alignItems: GridAlign
}

// ─── Output ─────────────────────────────────────────────────────────────

/** Computed position and size for a single grid item after layout. */
export interface GridItemOutput {
  /** Original index of this item in the input array. */
  readonly index: number
  /** X position relative to container origin (top-left), in cm. */
  readonly x: number
  /** Y position relative to container origin (top-left), in cm. */
  readonly y: number
  /** Computed width in cm. */
  readonly width: number
  /** Computed height in cm. */
  readonly height: number
}

/** Complete result from the grid layout engine. */
export interface GridLayoutResult {
  /** Computed position and size for each item, indexed by original input order. */
  readonly items: GridItemOutput[]
  /** Resolved container width in cm. */
  readonly containerWidth: number
  /** Resolved container height in cm. */
  readonly containerHeight: number
  /** Resolved size of each column track in cm. */
  readonly columnSizes: number[]
  /** Resolved size of each row track in cm. */
  readonly rowSizes: number[]
}
