import {ContentStyle} from "../../../Components/Content/ContentStyle"
import {System2Styles} from "../System2"

// Color values matched to System 2.0 button state reference
const IDLE = new vec4(0.85, 0.85, 0.85, 1)
const HOVERED = new vec4(1, 1, 1, 1)
const PRESSED = new vec4(0.75, 0.75, 0.75, 1)
const SELECTED = new vec4(1, 1, 1, 1)
const INACTIVE = new vec4(1, 1, 1, 0.35)
const YELLOW_ACCENT = new vec4(0.84, 0.75, 0.22, 1)
const YELLOW_ACCENT_DIM = new vec4(0.84, 0.75, 0.22, 0.35)

const standardLight: ContentStyle = {
  default: {textColor: IDLE, iconTint: IDLE},
  hovered: {textColor: HOVERED, iconTint: HOVERED},
  triggered: {textColor: PRESSED, iconTint: PRESSED},
  toggledDefault: {textColor: SELECTED, iconTint: SELECTED},
  toggledHovered: {textColor: HOVERED, iconTint: HOVERED},
  toggledTriggered: {textColor: PRESSED, iconTint: PRESSED},
  inactive: {textColor: INACTIVE, iconTint: INACTIVE}
}

const ghostStyle: ContentStyle = {
  default: {textColor: YELLOW_ACCENT, iconTint: YELLOW_ACCENT},
  hovered: {textColor: HOVERED, iconTint: HOVERED},
  triggered: {textColor: PRESSED, iconTint: PRESSED},
  toggledDefault: {textColor: YELLOW_ACCENT, iconTint: YELLOW_ACCENT},
  toggledHovered: {textColor: HOVERED, iconTint: HOVERED},
  toggledTriggered: {textColor: PRESSED, iconTint: PRESSED},
  inactive: {textColor: YELLOW_ACCENT_DIM, iconTint: YELLOW_ACCENT_DIM}
}

export const ContentColorParameters: Record<string, Partial<Record<System2Styles, ContentStyle>>> = {
  Button: {
    PrimaryNeutral: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Special: standardLight,
    Ghost: ghostStyle
  },
  RectangleButton: {
    PrimaryNeutral: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Special: standardLight,
    Ghost: ghostStyle
  },
  RoundButton: {
    PrimaryNeutral: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Special: standardLight,
    Ghost: ghostStyle
  },
  CapsuleButton: {
    PrimaryNeutral: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Special: standardLight,
    Ghost: ghostStyle
  },
  Checkbox: {
    PrimaryNeutral: standardLight
  },
  RadioButton: {
    PrimaryNeutral: standardLight
  },
  Slider: {
    PrimaryNeutral: standardLight
  },
  Switch: {
    PrimaryNeutral: standardLight
  },
  Frame: {
    PrimaryNeutral: standardLight
  }
}
