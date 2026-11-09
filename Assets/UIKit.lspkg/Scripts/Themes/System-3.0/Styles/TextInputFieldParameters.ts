// @module System-3.0/Styles/TextInputFieldParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {Style} from "../../Style"
import {UIlevel0, UIlevel1, UIlevel2} from "../Colors"

// Background-only, borderless — matches the DS3.0 TextInput_bg material, which
// has no outline/stroke and conveys state purely via the fill level:
//   idle = UV level 1, hover = UV level 2, editing/pressed = UV level 0.
export const TextInputFieldParameters: {style: {default: Style}} = {
  style: {
    // Flush surfaces (no per-state z offsets) with explicit UIlevel fills,
    // rather than the tokenized TEXT_INPUT_VISUAL_STYLE.
    default: {
      default: {
        baseType: "Gradient",
        // Idle background — "UV level 1 Idle".
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {enabled: true, percent: 0, color: UIlevel1},
          stop1: {enabled: true, percent: 0.5, color: UIlevel1}
        },
        hasBorder: false,
        shouldPosition: true
      },
      hovered: {
        // No z offset on state change (DS3.0 text surfaces stay flush).
        localPosition: new vec3(0, 0, 0),
        // Hover background — "UV level 2 Hover".
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {enabled: true, percent: 0, color: UIlevel2},
          stop1: {enabled: true, percent: 0.5, color: UIlevel2}
        }
      },
      triggered: {
        localPosition: new vec3(0, 0, 0),
        // Pressed background — "UV level 0 Editing/Pressed".
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {enabled: true, percent: 0, color: UIlevel0},
          stop1: {enabled: true, percent: 0.5, color: UIlevel0}
        }
      },
      toggledDefault: {
        localPosition: new vec3(0, 0, 0),
        // Editing/focused background — "UV level 0 Editing/Pressed".
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {enabled: true, percent: 0, color: UIlevel0},
          stop1: {enabled: true, percent: 0.5, color: UIlevel0}
        }
      },
      toggledHovered: {
        localPosition: new vec3(0, 0, 0),
        // Editing/focused background — "UV level 0 Editing/Pressed".
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {enabled: true, percent: 0, color: UIlevel0},
          stop1: {enabled: true, percent: 0.5, color: UIlevel0}
        }
      }
    }
  }
}
