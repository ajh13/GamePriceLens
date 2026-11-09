import {BeveledPrismVisualState} from "../Visuals/BeveledPrism/BeveledPrismVisual"
import {RoundedRectangleVisualState} from "../Visuals/RoundedRectangle/RoundedRectangleVisual"

// Style entries can target any Visual whose state extends VisualState. Union
// here so theme files type-check against either Visual's specific extras
// (gradients/borders for RoundedRectangle, prism palette for BeveledPrism).
// At runtime applyStyleProperty just dynamically reads the keys it expects.
export type Style = Partial<Record<string, RoundedRectangleVisualState | BeveledPrismVisualState>>
