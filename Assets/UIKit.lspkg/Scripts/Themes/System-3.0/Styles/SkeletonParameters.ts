// @module System-3.0/Styles/SkeletonParameters — DO NOT REMOVE: prevents Lens Studio module collision

import {DSColorHierarchyPanelLevel1} from "../DesignSystemColors"

/**
 * Themeable knobs for the Skeleton (group pulses) loader. Registered under
 * `componentData["Skeleton"]` (no `styles` entry — no interaction states).
 * Motion numbers (wave duration/angle/width, pulse breathing, boost) live
 * in the Motion recipe (`recipes.skeletonPulse`) — this is the LOOK.
 *
 * Rest fill is Figma Panel/Level 1. The wave band and ember are still
 * brightness boosts on that base (waveBoost / emberBoost). Skeleton colors
 * need tiered color level logic instead of those boosts.
 */
export type SkeletonComponentDataType = {
  /** Placeholder block fill color. */
  baseColor: vec4
  /** Default block corner radius, centimeters. */
  cornerRadius: number
  /** Text placeholders render this fraction of the text's measured height,
   * centered on the line — a full text bounding box reads as a slab, not a
   * line of text. */
  textHeightFactor: number
  /** Corner radius for text placeholders, centimeters — a gentle rounding,
   * deliberately NOT a capsule. */
  textCornerRadius: number
  /** Local Z lift of generated blocks above the measured content, cm. */
  zLift: number
}

export const SkeletonComponentData: SkeletonComponentDataType = {
  baseColor: DSColorHierarchyPanelLevel1,
  cornerRadius: 0.6,
  textHeightFactor: 0.5,
  textCornerRadius: 0.2,
  zLift: 0.02
}
