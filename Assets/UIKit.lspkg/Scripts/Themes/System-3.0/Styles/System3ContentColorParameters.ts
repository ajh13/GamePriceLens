// @module System-3.0/Styles/System3ContentColorParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {ContentStyle} from "../../../Components/Content/ContentStyle"
import {
  ButtonContentHovered,
  ButtonContentIdle,
  ButtonContentPressed,
  ContentAccentBlue,
  ContentAccentBlueDim,
  ContentIdleGray,
  ContentInactiveWhite,
  ContentLinkDefault,
  ContentLinkDisabled,
  ContentLinkHovered,
  ContentLinkTriggered,
  ContentPressedGray,
  ContentWhite
} from "../Colors"
import {System3Styles} from "../System3"

const standardLight: ContentStyle = {
  default: {textColor: ContentIdleGray, iconTint: ContentIdleGray},
  hovered: {textColor: ContentWhite, iconTint: ContentWhite},
  triggered: {textColor: ContentPressedGray, iconTint: ContentPressedGray},
  toggledDefault: {textColor: ContentWhite, iconTint: ContentWhite},
  toggledHovered: {textColor: ContentWhite, iconTint: ContentWhite},
  toggledTriggered: {textColor: ContentPressedGray, iconTint: ContentPressedGray},
  inactive: {textColor: ContentInactiveWhite, iconTint: ContentInactiveWhite}
}

const transparentStyle: ContentStyle = {
  default: {textColor: ContentAccentBlue, iconTint: ContentAccentBlue},
  hovered: {textColor: ContentWhite, iconTint: ContentWhite},
  triggered: {textColor: ContentPressedGray, iconTint: ContentPressedGray},
  toggledDefault: {textColor: ContentAccentBlue, iconTint: ContentAccentBlue},
  toggledHovered: {textColor: ContentWhite, iconTint: ContentWhite},
  toggledTriggered: {textColor: ContentPressedGray, iconTint: ContentPressedGray},
  inactive: {textColor: ContentAccentBlueDim, iconTint: ContentAccentBlueDim}
}

// Button text/icons (Figma "Button/Icon+Text/*"). Hovered and pressed use the
// Figma styles whether or not the button is toggled. Figma has no toggled-idle
// or inactive style: those two keep the CONTENT_COLOR_DEFAULTS values.
const buttonContentStyle: ContentStyle = {
  default: {textColor: ButtonContentIdle, iconTint: ButtonContentIdle},
  hovered: {textColor: ButtonContentHovered, iconTint: ButtonContentHovered},
  triggered: {textColor: ButtonContentPressed, iconTint: ButtonContentPressed},
  toggledDefault: {textColor: ContentWhite, iconTint: ContentWhite},
  toggledHovered: {textColor: ButtonContentHovered, iconTint: ButtonContentHovered},
  toggledTriggered: {textColor: ButtonContentPressed, iconTint: ButtonContentPressed},
  inactive: {textColor: ContentInactiveWhite, iconTint: ContentInactiveWhite}
}

// Every System3 button variant uses the same Button/Icon+Text palette on
// purpose: Prism, PrismGhost, Primary, Secondary, Ghost, Tag, Chip and Palm.
// This also covers PrismGhost buttons in Calendar, the TextInputField action
// slot, and standalone ElementContent (which resolveThemeColors treats as
// "Button"). Listed explicitly so a new System3Styles value won't silently
// inherit through the resolver's fallback.
const buttonContent: Partial<Record<System3Styles, ContentStyle>> = {
  Prism: buttonContentStyle,
  PrismGhost: buttonContentStyle,
  Primary: buttonContentStyle,
  Secondary: buttonContentStyle,
  Ghost: buttonContentStyle,
  Tag: buttonContentStyle,
  Chip: buttonContentStyle,
  Palm: buttonContentStyle
}

// Hyperlink-style text: brightens on hover, dims when pressed, darker still when
// disabled. Underline (ElementContent) tracks these colors per state.
const linkStyle: ContentStyle = {
  default: {textColor: ContentLinkDefault, iconTint: ContentLinkDefault},
  hovered: {textColor: ContentLinkHovered, iconTint: ContentLinkHovered},
  triggered: {textColor: ContentLinkTriggered, iconTint: ContentLinkTriggered},
  inactive: {textColor: ContentLinkDisabled, iconTint: ContentLinkDisabled}
}

export const System3ContentColorParameters: Record<string, Partial<Record<System3Styles, ContentStyle>>> = {
  Button: {
    Prism: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Ghost: transparentStyle
  },
  RectangleButton: {
    Prism: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Ghost: transparentStyle
  },
  RoundButton: {
    Prism: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Ghost: transparentStyle
  },
  CapsuleButton: {
    Prism: standardLight,
    Primary: standardLight,
    Secondary: standardLight,
    Ghost: transparentStyle
  },
  Checkbox: {
    Primary: standardLight
  },
  RadioButton: {
    Primary: standardLight
  },
  Slider: {
    Primary: standardLight
  },
  Switch: {
    Primary: standardLight
  },
  Frame: {
    Primary: standardLight
  }
}

// Wired into System3 `componentData["ContentColors"]` (see System3.ts). Scoped
// to Link and the buttons ONLY on purpose: System3ContentColorParameters above
// is not wired in, so every other component still falls back to
// CONTENT_COLOR_DEFAULTS. Wiring the whole map would repaint those components.
// Keys are class names (ElementContent resolves by `typeString`), so a Button
// subclass needs its own entry.
export const System3ContentColors: Record<string, Partial<Record<System3Styles, ContentStyle>>> = {
  Link: {
    Primary: linkStyle
  },
  Button: buttonContent,
  LongPressButton: buttonContent,
  VoiceInputButton: buttonContent,
  RectangleButton: buttonContent,
  RoundButton: buttonContent,
  CapsuleButton: buttonContent
}
