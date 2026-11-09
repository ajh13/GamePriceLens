// ═══════════════════════════════════════════════════════════════════════════
// UIKitBrands.ts — Type-brand constants for the UIKit item-handler finders.
//
// Used as a non-colliding alternative to duck-typing on private property
// names. Each UIKit base class exposes a `public readonly __uikitBrand: ...`
// field set to one of these constants, and the finders in
// `UIKitItemHandlers.ts` check that field instead of probing for
// `_text`/`_size`/`onSizeChanged`/etc.
//
// Subclasses inherit the brand from their parent constructor without having
// to redeclare it. A downstream lens authoring its own UIKit-flavored
// subclass will inherit the same brand and resolve to the correct handler
// automatically.
// ═══════════════════════════════════════════════════════════════════════════

export const UIKitBrands = {
  /** Element base class — Frame, ScrollWindow, Button, Slider, Switch, etc. */
  Element: "UIKit:Element",
  /** Shape base class — RoundedRectangle, Capsule, Round, etc. */
  Shape: "UIKit:Shape",
  /** Layout containers — FlexLayout, GridLayout. */
  LayoutContainer: "UIKit:LayoutContainer",
  /** ElementContent (companion or standalone mode). */
  ElementContent: "UIKit:ElementContent"
} as const

export type UIKitBrand = (typeof UIKitBrands)[keyof typeof UIKitBrands]
