// @module System-3.0/Styles/SwitchKnobPrismParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {Style} from "../../Style"
import {
  PRISM_ACTIVE_COLORS,
  PRISM_HOVER_COLORS,
  PRISM_IDLE_COLORS,
  PRISM_SELECTED_COLORS
} from "../Gradients/PrismPalette"
import {SwitchStyle} from "./SwitchParameters"

// Prism-knob variants for the System3 Switch. Palette + extrusion curves
// mirror BeveledPrismButtonParameters so the knob reads the same as a
// Prism Button under hover/press/toggle. Three shapes:
//   - Prism        — pill knob on a capsule track.
//   - PrismWide    — wide-rect knob on a rectangular track (~½ track width).
//   - PrismSquare  — square knob on a rectangular track.
//
// cornerRadius is intentionally omitted from every style — Switch.ts sets
// it to `size.y * cornerRadiusFactor` (matching Slider's track formula) so
// knob and track silhouettes stay in sync at any track size.
//
// shouldPosition/shouldScale are false because Slider drives the knob's
// localPosition every frame; if the visual's state machine also wrote to
// localPosition it would stomp the slide animation.
const SHARED_BEVEL = 0.105

// shouldScale / shouldPosition are false so the visual ignores localScale /
// localPosition — omitting those keeps every state from sharing the same
// vec3 references and removes dead values from the theme data.
const FALSE_TRANSFORM = {
  shouldScale: false,
  shouldPosition: false
}

const PrismKnobStates: Style = {
  default: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    bevelRadius: SHARED_BEVEL,
    ...FALSE_TRANSFORM
  },
  hovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  },
  triggered: {
    prismColors: PRISM_ACTIVE_COLORS,
    extrusion: 0.1,
    matcapRotation: -100,
    ...FALSE_TRANSFORM
  },
  toggledDefault: {
    // Selected palette = same RGB as hover/active, but master1.a = 0 so the
    // blue bevel sections stay off while the switch rests in its on state.
    prismColors: PRISM_SELECTED_COLORS,
    extrusion: 0,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledHovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledTriggered: {
    prismColors: PRISM_ACTIVE_COLORS,
    extrusion: 0.1,
    matcapRotation: -150,
    ...FALSE_TRANSFORM
  },
  inactive: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  }
}

const PrismWideKnobStates: Style = {
  default: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    bevelRadius: SHARED_BEVEL,
    ...FALSE_TRANSFORM
  },
  hovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  },
  triggered: {
    prismColors: PRISM_ACTIVE_COLORS,
    extrusion: 0.1,
    matcapRotation: -100,
    ...FALSE_TRANSFORM
  },
  toggledDefault: {
    // Selected palette = same RGB as hover/active, but master1.a = 0 so the
    // blue bevel sections stay off while the switch rests in its on state.
    prismColors: PRISM_SELECTED_COLORS,
    extrusion: 0,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledHovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledTriggered: {
    prismColors: PRISM_ACTIVE_COLORS,
    extrusion: 0.1,
    matcapRotation: -150,
    ...FALSE_TRANSFORM
  },
  inactive: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  }
}

// PrismSquare shares palette + extrusion with PrismWide; only knob aspect
// differs (handled in Switch.ts via SwitchKnobComponentData.knobAspect).
// Shallow-spread so the two map entries point at distinct top-level objects
// — a future per-state tweak on one won't accidentally bleed into the other.
const PrismSquareKnobStates: Style = {...PrismWideKnobStates}

export const SwitchKnobPrismParameters: Partial<Record<SwitchStyle, Style>> = {
  Prism: PrismKnobStates,
  PrismWide: PrismWideKnobStates,
  PrismSquare: PrismSquareKnobStates
}
