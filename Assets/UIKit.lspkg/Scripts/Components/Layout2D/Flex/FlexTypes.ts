// ═══════════════════════════════════════════════════════════════════════════
// FlexTypes.ts — Pure enums + data interfaces. Zero imports.
// Shared vocabulary for the standalone 2D Flex layout module.
// ═══════════════════════════════════════════════════════════════════════════

// Re-export shared types under flex-specific aliases for convenience
export {
  ContentHorizontalAlignment as FlexContentHorizontalAlignment,
  ContentVerticalAlignment as FlexContentVerticalAlignment
} from "../LayoutTypes"

// ─── Enums ───────────────────────────────────────────────────────────────

// CSS spells these values `flex-start` / `flex-end`, and every other flexbox port
// (React Native, Yoga, Unity UI Toolkit) exposes them as FlexStart / FlexEnd. The
// short `Start` / `End` members are canonical in UIKit; the `Flex*` members are
// accepted aliases with identical string values, so code written against the CSS
// names compiles and lays out identically. UIKit source should keep using the
// short names; `switch` cases on `Start` / `End` already match the aliases.
// The duplicate values are deliberate, so the lint rule is off for this section.
/* eslint-disable @typescript-eslint/no-duplicate-enum-values */

/** Main axis direction for flex layout. Maps to CSS `flex-direction`. */
export enum FlexDirection {
  /** Items flow left-to-right (default). */
  Row = "row",
  /** Items flow right-to-left. */
  RowReverse = "rowReverse",
  /** Items flow top-to-bottom. */
  Column = "column",
  /** Items flow bottom-to-top. */
  ColumnReverse = "columnReverse"
}

/** Controls whether flex items wrap onto multiple lines. Maps to CSS `flex-wrap`. */
export enum FlexWrap {
  /** All items stay on a single line (may overflow). */
  NoWrap = "nowrap",
  /** Items wrap onto additional lines as needed. */
  Wrap = "wrap",
  /** Items wrap, but new lines are added above/before instead of below/after. */
  WrapReverse = "wrapReverse"
}

/** Distribution of items along the main axis. Maps to CSS `justify-content`. */
export enum FlexJustify {
  /** Items packed toward the start. */
  Start = "start",
  /** Alias of `Start` (CSS `flex-start`). Items packed toward the start. */
  FlexStart = "start",
  /** Items centered along the main axis. */
  Center = "center",
  /** Items packed toward the end. */
  End = "end",
  /** Alias of `End` (CSS `flex-end`). Items packed toward the end. */
  FlexEnd = "end",
  /** Equal space between items, no space at edges. */
  SpaceBetween = "spaceBetween",
  /** Equal space around each item (half-size spaces at edges). */
  SpaceAround = "spaceAround",
  /** Equal space between and around items. */
  SpaceEvenly = "spaceEvenly"
}

/** Cross-axis alignment for all items in a container. Maps to CSS `align-items`. */
export enum FlexAlign {
  /** Items aligned to the cross-axis start. */
  Start = "start",
  /** Alias of `Start` (CSS `flex-start`). Items aligned to the cross-axis start. */
  FlexStart = "start",
  /** Items centered on the cross axis. */
  Center = "center",
  /** Items aligned to the cross-axis end. */
  End = "end",
  /** Alias of `End` (CSS `flex-end`). Items aligned to the cross-axis end. */
  FlexEnd = "end",
  /** Items stretched to fill the cross-axis extent. */
  Stretch = "stretch"
}

/** Per-item cross-axis alignment override. Maps to CSS `align-self`. */
export enum FlexAlignSelf {
  /** Inherit alignment from the container's `alignItems`. */
  Auto = "auto",
  /** Align to the cross-axis start. */
  Start = "start",
  /** Alias of `Start` (CSS `flex-start`). Align to the cross-axis start. */
  FlexStart = "start",
  /** Center on the cross axis. */
  Center = "center",
  /** Align to the cross-axis end. */
  End = "end",
  /** Alias of `End` (CSS `flex-end`). Align to the cross-axis end. */
  FlexEnd = "end",
  /** Stretch to fill the cross-axis extent. */
  Stretch = "stretch"
}

/** Distribution of wrapped lines along the cross axis. Maps to CSS `align-content`. */
export enum FlexAlignContent {
  /** Lines packed toward the start. */
  Start = "start",
  /** Alias of `Start` (CSS `flex-start`). Lines packed toward the start. */
  FlexStart = "start",
  /** Lines centered on the cross axis. */
  Center = "center",
  /** Lines packed toward the end. */
  End = "end",
  /** Alias of `End` (CSS `flex-end`). Lines packed toward the end. */
  FlexEnd = "end",
  /** Equal space between lines, no space at edges. */
  SpaceBetween = "spaceBetween",
  /** Equal space around each line. */
  SpaceAround = "spaceAround",
  /** Equal space between and around lines. */
  SpaceEvenly = "spaceEvenly",
  /** Lines stretched to fill remaining cross-axis space. */
  Stretch = "stretch"
}
/* eslint-enable @typescript-eslint/no-duplicate-enum-values */

// ─── Data Interfaces ─────────────────────────────────────────────────────

/**
 * Engine-side flexBasis sentinels.
 *
 * The public `FlexItem.flexBasis` setter accepts a tagged union
 * (`number | "auto" | "min-content" | "max-content"`) and normalizes it
 * to one of these values before reaching the pure engine.
 */
export const FLEX_BASIS_AUTO = -1
export const FLEX_BASIS_MIN_CONTENT = -2
export const FLEX_BASIS_MAX_CONTENT = -3

/** Input data for a single flex item, passed to the pure layout engine. */
export interface FlexItemInput {
  /** Measured intrinsic width in cm (the content's preferred width). */
  intrinsicWidth: number
  /** Measured intrinsic height in cm (the content's preferred height). */
  intrinsicHeight: number
  /**
   * Content min-content width in cm — widest unbreakable run for text,
   * preferred for rigid content. Used for CSS `min-width: auto` and for
   * `flexBasis: "min-content"`. Default 0 = no intrinsic minimum.
   */
  contentMinWidth: number
  /** Content min-content height in cm. Symmetric to contentMinWidth. */
  contentMinHeight: number
  /**
   * Content max-content width in cm — no-wrap text width, preferred for
   * rigid content. Used for `flexBasis: "max-content"`. Default Infinity
   * = unbounded content.
   */
  contentMaxWidth: number
  /** Content max-content height in cm. Symmetric to contentMaxWidth. */
  contentMaxHeight: number
  /** Flex grow factor. 0 = don't grow. */
  flexGrow: number
  /** Flex shrink factor. 0 = don't shrink. */
  flexShrink: number
  /**
   * Initial main-axis size in cm.
   * - `>= 0` → explicit cm value
   * - `FLEX_BASIS_AUTO` (-1) → use intrinsic main-axis preferred size
   * - `FLEX_BASIS_MIN_CONTENT` (-2) → use content min-content along main axis
   * - `FLEX_BASIS_MAX_CONTENT` (-3) → use content max-content along main axis
   */
  flexBasis: number
  /** Visual ordering (lower values appear first). */
  order: number
  /** Per-item cross-axis alignment override. */
  alignSelf: FlexAlignSelf
  /** Minimum width in cm (0 = no minimum from user; CSS min-width: auto may still apply). */
  minWidth: number
  /** Maximum width in cm (0 = no maximum). */
  maxWidth: number
  /** Minimum height in cm (0 = no minimum from user). */
  minHeight: number
  /** Maximum height in cm (0 = no maximum). */
  maxHeight: number
  /** Top margin in cm (>= 0). */
  marginTop: number
  /** Right margin in cm (>= 0). */
  marginRight: number
  /** Bottom margin in cm (>= 0). */
  marginBottom: number
  /** Left margin in cm (>= 0). */
  marginLeft: number
  /**
   * Intrinsic aspect ratio (`width / height`). When `> 0` and the main axis
   * is `auto` (flexBasis auto, with neither grow nor shrink), the engine
   * derives the main size from the resolved cross size at this ratio
   * (CSS `aspect-ratio`), clamping bidirectionally so a min/max on either
   * axis shrinks the other to preserve the ratio rather than distorting it.
   * Omit / `undefined` / `<= 0` → the two axes are sized independently.
   */
  aspectRatio?: number
  /**
   * Optional fit-content pass. In a row container the engine calls it after
   * main-axis (width) resolution with the item's resolved width and uses the
   * answer as the item's cross (height) intrinsic. In a column container it is
   * called before flex-basis resolution with the width the item will get from
   * the container's cross axis (stretch → inner width, else its intrinsic
   * width). Return `null` to keep the measured intrinsics.
   */
  heightForWidth?: (width: number) => number | null
}

/**
 * Public-facing flex basis. Mirrors CSS `flex-basis`.
 *
 * - `number` — explicit cm value
 * - `"auto"` — use the item's natural preferred main-axis size
 * - `"min-content"` — use the item's min-content size along the main axis
 * - `"max-content"` — use the item's max-content size along the main axis
 */
export type FlexBasis = number | "auto" | "min-content" | "max-content"

/** Configuration for the flex container, passed to the pure layout engine. */
export interface FlexContainerInput {
  /** Container width in cm. -1 = auto (shrink-to-fit content). */
  readonly width: number
  /** Container height in cm. -1 = auto (shrink-to-fit content). */
  readonly height: number
  /** Main axis direction. */
  readonly direction: FlexDirection
  /** Whether items wrap onto multiple lines. */
  readonly wrap: FlexWrap
  /** Distribution of items along the main axis. */
  readonly justifyContent: FlexJustify
  /** Default cross-axis alignment for items. */
  readonly alignItems: FlexAlign
  /** Distribution of wrapped lines along the cross axis. */
  readonly alignContent: FlexAlignContent
  /** Container padding in cm (top, right, bottom, left). */
  readonly padding: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
  /** Gap between rows in cm. */
  readonly rowGap: number
  /** Gap between columns in cm. */
  readonly columnGap: number
}

/** Computed position and size for a single flex item after layout. */
export interface FlexItemOutput {
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

/** Complete result from the flex layout engine. */
export interface FlexLayoutResult {
  /** Computed position and size for each item, indexed by original input order. */
  readonly items: FlexItemOutput[]
  /** Resolved container width in cm (may differ from input when auto). */
  readonly containerWidth: number
  /** Resolved container height in cm (may differ from input when auto). */
  readonly containerHeight: number
}
