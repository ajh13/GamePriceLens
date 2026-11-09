// ═══════════════════════════════════════════════════════════════════════════
// LayoutTypes.ts — Shared vocabulary for the Layout2D system.
// Zero Lens Studio imports. Used by both Flex and Grid orchestrators.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Content Alignment (shared by Flex and Grid orchestrators) ──────────

/** Horizontal alignment of layout content relative to the SceneObject origin. */
/**
 * Fit-content retry budget: how many LateUpdate frames, after the frame on
 * which a pass first came back pending, a container keeps re-running layout
 * waiting for a rate-limited `measureHeightForWidth` answer. Counted on
 * distinct frames — nested probes and `forceLayout()` inside one frame spend
 * one opportunity. On exhaustion the container memoizes the result it has
 * (measured heights where available, intrinsic fallback where not) and goes
 * idle until the next external `markDirty()`.
 *
 * A starting policy: a fresh wrapped Text needs three host measurements and
 * the host allows roughly one per frame, so ordinary content settles in two
 * to three frames. Not an inspector setting; revisit if a consumer shows a
 * real need.
 */
export const FIT_CONTENT_RETRY_FRAMES = 8

export enum ContentHorizontalAlignment {
  Left = "left",
  Center = "center",
  Right = "right"
}

/** Vertical alignment of layout content relative to the SceneObject origin. */
export enum ContentVerticalAlignment {
  Top = "top",
  Center = "center",
  Bottom = "bottom"
}

// ─── Shared Output Interface ────────────────────────────────────────────

/** Computed position and size for a single layout item, as returned by the layout engine. */
export interface LayoutItemOutput {
  /** Original index of this item in the input array. */
  readonly index: number
  /** X position relative to the container origin (top-left). */
  readonly x: number
  /** Y position relative to the container origin (top-left). */
  readonly y: number
  /** Computed width after layout. */
  readonly width: number
  /** Computed height after layout. */
  readonly height: number
}
