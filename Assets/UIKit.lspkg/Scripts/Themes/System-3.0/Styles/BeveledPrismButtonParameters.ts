// @module System-3.0/Styles/BeveledPrismButtonParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {Style} from "../../Style"
import {
  PRISM_ACTIVE_COLORS,
  PRISM_HOVER_COLORS,
  PRISM_IDLE_COLORS,
  PRISM_ON_HOVERED_COLORS,
  PRISM_SELECTED_COLORS
} from "../Gradients/PrismPalette"
import {System3Styles} from "../System3"

// State → palette mapping for the iridescent prism button.
// Idle / hover / active palettes come from shared PrismPalette constants
// (which were derived from FloatingMain.ss_graph's V45 / V88+V12 / N92+V78).
// toggledDefault ("Selected") is a faded hover (hover palette at lower opacity);
// toggledHovered ("On Hovered") is a brighter hover (PRISM_ON_HOVERED_COLORS at
// full opacity). toggledTriggered still mirrors the pressed/active state.
// Inactive reuses idle since the shader is already low-contrast at idle.
//
// `extrusion` is forward-only Z displacement (cm) applied per-state by the
// vertex shader. Hovered pops forward; triggered settles slightly back as
// a depress affordance. Back face stays anchored — collider/AABB unchanged.
export const BeveledPrismButtonParameters: Partial<Record<System3Styles, Style>> = {
  Prism: {
    default: {
      prismColors: PRISM_IDLE_COLORS,
      extrusion: 0,
      matcapRotation: 0,
      bevelRadius: 0.105,
      cornerRadius: 0.44,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      prismColors: PRISM_HOVER_COLORS,
      extrusion: 0.3,
      matcapRotation: 0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      prismColors: PRISM_ACTIVE_COLORS,
      extrusion: 0.1,
      matcapRotation: -100,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      prismColors: PRISM_SELECTED_COLORS,
      extrusion: 0,
      opacity: 0.65,
      matcapRotation: -60,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      prismColors: PRISM_ON_HOVERED_COLORS,
      extrusion: 0.3,
      opacity: 1,
      matcapRotation: -60,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      prismColors: PRISM_ACTIVE_COLORS,
      extrusion: 0.1,
      matcapRotation: -150,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      prismColors: PRISM_IDLE_COLORS,
      extrusion: 0,
      matcapRotation: 0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  // Same palette / extrusion curve as Prism, but the body collapses to a
  // flat plane and goes fully transparent at idle (and inactive). Hover
  // restores natural depth and full opacity together — opacity uses a
  // snappier asymmetric curve (see BeveledPrismVisual.updateOpacity),
  // bodyDepthScale uses the neutral state tween so the body grows back
  // smoothly alongside extrusion.
  PrismGhost: {
    default: {
      prismColors: PRISM_IDLE_COLORS,
      extrusion: 0,
      bodyDepthScale: 0,
      opacity: 0,
      matcapRotation: 0,
      bevelRadius: 0.105,
      cornerRadius: 0.44,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      prismColors: PRISM_HOVER_COLORS,
      extrusion: 0.3,
      bodyDepthScale: 1,
      opacity: 1,
      matcapRotation: 0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      prismColors: PRISM_ACTIVE_COLORS,
      extrusion: 0.1,
      bodyDepthScale: 1,
      opacity: 1,
      matcapRotation: -100,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      prismColors: PRISM_SELECTED_COLORS,
      extrusion: 0,
      bodyDepthScale: 1,
      opacity: 0.65,
      matcapRotation: -60,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      prismColors: PRISM_ON_HOVERED_COLORS,
      extrusion: 0.3,
      bodyDepthScale: 1,
      opacity: 1,
      matcapRotation: -60,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      prismColors: PRISM_ACTIVE_COLORS,
      extrusion: 0.1,
      bodyDepthScale: 1,
      opacity: 1,
      matcapRotation: -150,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      prismColors: PRISM_IDLE_COLORS,
      extrusion: 0,
      bodyDepthScale: 0,
      opacity: 0,
      matcapRotation: 0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  }
}
