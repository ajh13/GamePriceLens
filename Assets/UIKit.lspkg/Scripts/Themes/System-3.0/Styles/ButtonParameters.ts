// @module System-3.0/Styles/ButtonParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {Style} from "../../Style"
import {
  AccentBlue,
  AccentPurple,
  AccentTeal,
  PalmButtonIdle,
  PanelLevel0,
  Transparent,
  UIlevel0,
  UIlevel1,
  UIlevel2
} from "../Colors"
import {GhostGradients} from "../Gradients/GhostGradients"
import {PrimaryGradients} from "../Gradients/PrimaryGradients"
import {SecondaryGradients} from "../Gradients/SecondaryGradients"
import {System3Styles} from "../System3"

// PalmButton center "blur" fill: a transparent purple->blue->teal gradient in the
// accent hues, aligned with the ring direction. Brightness == alpha, so the same
// gradient is built at two levels: a dim one for hover (glow preview) and a
// brighter one for the toggled-on state.
function palmFillGradient(alpha: number) {
  const withAlpha = (base: vec4) => new vec4(base.r, base.g, base.b, alpha)
  return {
    enabled: true,
    type: "Linear" as const,
    start: new vec2(-1, 0.2),
    end: new vec2(1, -0.2),
    stop0: {enabled: true, percent: 0, color: withAlpha(AccentPurple)},
    stop1: {enabled: true, percent: 0.5, color: withAlpha(AccentBlue)},
    stop2: {enabled: true, percent: 1, color: withAlpha(AccentTeal)}
  }
}
const PALM_FILL_HOVER = palmFillGradient(0.28) // dimmer — hover glow preview
const PALM_FILL_TOGGLED = palmFillGradient(0.6) // brighter — toggled on

export const ButtonParameters: Partial<Record<System3Styles, Style>> = {
  Primary: {
    default: {
      baseType: "Gradient",
      baseGradient: PrimaryGradients.idleBackground,
      borderSize: 0.175,
      borderSoftness: 0.07,
      hasBorder: true,
      borderType: "Gradient",
      borderGradient: PrimaryGradients.idleBorder,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      baseGradient: PrimaryGradients.hoverBackground,
      borderGradient: PrimaryGradients.hoverBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      baseGradient: PrimaryGradients.pressedBackground,
      borderGradient: PrimaryGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseGradient: PrimaryGradients.selectedBackground,
      borderGradient: PrimaryGradients.selectedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseGradient: PrimaryGradients.onHoveredBackground,
      borderGradient: PrimaryGradients.onHoveredBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseGradient: PrimaryGradients.pressedBackground,
      borderGradient: PrimaryGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseGradient: PrimaryGradients.inactiveBackground,
      borderGradient: PrimaryGradients.inactiveBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  Secondary: {
    default: {
      baseType: "Color",
      baseColor: Transparent,
      borderSize: 0.175,
      borderSoftness: 0.07,
      hasBorder: true,
      borderType: "Gradient",
      borderGradient: SecondaryGradients.idleBorder,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      borderSize: 0.2,
      borderGradient: SecondaryGradients.hoverBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      borderGradient: SecondaryGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseType: "Color",
      baseColor: UIlevel0,
      borderGradient: SecondaryGradients.selectedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseType: "Color",
      baseColor: UIlevel0,
      borderSize: 0.2,
      borderGradient: SecondaryGradients.onHoveredBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseType: "Color",
      baseColor: UIlevel0,
      borderGradient: SecondaryGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      borderGradient: SecondaryGradients.inactiveBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  Ghost: {
    default: {
      baseType: "Gradient",
      baseGradient: GhostGradients.idleBackground,
      hasBorder: true,
      borderSize: 0.1,
      borderType: "Gradient",
      borderGradient: GhostGradients.idleBorder,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      baseGradient: GhostGradients.hoverBackground,
      borderGradient: GhostGradients.hoverBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      baseGradient: GhostGradients.pressedBackground,
      borderGradient: GhostGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseGradient: GhostGradients.selectedBackground,
      borderGradient: GhostGradients.selectedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseGradient: GhostGradients.onHoveredBackground,
      borderGradient: GhostGradients.onHoveredBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseGradient: GhostGradients.pressedBackground,
      borderGradient: GhostGradients.pressedBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseGradient: GhostGradients.inactiveBackground,
      borderGradient: GhostGradients.inactiveBorder,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  // Flat rounded-rect chip: near-black idle, lifts on hover, settles darker on press.
  // Solid per-state fill, no border (DS3.0 reference). Radius = the shape's default.
  Chip: {
    default: {
      baseType: "Color",
      baseColor: PanelLevel0,
      hasBorder: false,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      baseType: "Color",
      baseColor: UIlevel2,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      baseType: "Color",
      baseColor: UIlevel0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseType: "Color",
      baseColor: UIlevel0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseType: "Color",
      baseColor: UIlevel2,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseType: "Color",
      baseColor: UIlevel0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseType: "Color",
      baseColor: PanelLevel0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  // Flat rounded-rect tag: UI-surface tones, slightly lighter than Chip; no border.
  Tag: {
    default: {
      baseType: "Color",
      baseColor: UIlevel0,
      hasBorder: false,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      baseType: "Color",
      baseColor: UIlevel1,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      baseType: "Color",
      baseColor: UIlevel2,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseType: "Color",
      baseColor: UIlevel1,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseType: "Color",
      baseColor: UIlevel1,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseType: "Color",
      baseColor: UIlevel2,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseType: "Color",
      baseColor: UIlevel0,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  },
  // PalmButton look (consumed via the PalmButton component in _Internal/PalmButton.ts):
  // round, transparent center, gradient ring. Idle/inactive use a flat #BDBDBD ring.
  // Hover takes the lit center fill (dim) + accent border (the glow "preview");
  // press has no fill and feeds back with a slight overall scale-down (no border
  // thickening); toggled-on shows the brightest fill. `shouldScale` is set on every
  // state so the press scale-down applies on transition in AND resets on release.
  Palm: {
    default: {
      baseType: "Color",
      baseColor: Transparent,
      borderSize: 0.175,
      borderSoftness: 0.07,
      hasBorder: true,
      borderType: "Gradient",
      borderGradient: {
        enabled: true,
        type: "Linear",
        start: new vec2(-1, 0.2),
        end: new vec2(1, -0.2),
        stop0: {enabled: true, percent: 0, color: PalmButtonIdle},
        stop1: {enabled: true, percent: 0.5, color: PalmButtonIdle},
        stop2: {enabled: true, percent: 1, color: PalmButtonIdle}
      },
      shouldScale: true,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Hover ← old "triggered" look: dim lit center fill + accent pressed-border.
    hovered: {
      baseType: "Gradient",
      baseGradient: PALM_FILL_HOVER,
      borderSize: 0.2,
      borderGradient: SecondaryGradients.pressedBorder,
      shouldScale: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Trigger ← old "hover" look: no fill + hover border at the default border
    // size (no thickening); press feedback is a slight overall scale-down.
    triggered: {
      baseType: "Color",
      baseColor: Transparent,
      borderSize: 0.175,
      borderGradient: SecondaryGradients.hoverBorder,
      shouldScale: true,
      localScale: new vec3(0.9, 0.9, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Toggled on: brightest fill.
    toggledDefault: {
      baseType: "Gradient",
      baseGradient: PALM_FILL_TOGGLED,
      borderSize: 0.2,
      borderGradient: SecondaryGradients.selectedBorder,
      shouldScale: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseType: "Gradient",
      baseGradient: PALM_FILL_TOGGLED,
      borderSize: 0.2,
      borderGradient: SecondaryGradients.onHoveredBorder,
      shouldScale: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Toggled press: keep the bright fill (still on) + the scale-down feedback.
    toggledTriggered: {
      baseType: "Gradient",
      baseGradient: PALM_FILL_TOGGLED,
      borderSize: 0.175,
      borderGradient: SecondaryGradients.hoverBorder,
      shouldScale: true,
      localScale: new vec3(0.9, 0.9, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseType: "Color",
      baseColor: Transparent,
      borderSize: 0.175,
      borderGradient: {
        enabled: true,
        type: "Linear",
        start: new vec2(-1, 0.2),
        end: new vec2(1, -0.2),
        stop0: {enabled: true, percent: 0, color: PalmButtonIdle},
        stop1: {enabled: true, percent: 0.5, color: PalmButtonIdle},
        stop2: {enabled: true, percent: 1, color: PalmButtonIdle}
      },
      shouldScale: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  }
}
