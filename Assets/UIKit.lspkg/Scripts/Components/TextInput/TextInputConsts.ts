import {
  InputHoverBackground,
  InputIdleBackground,
  InputInactiveBackground,
  InputInactiveText,
  InputTextWarm,
  InputToggledBackground
} from "../../Themes/System-3.0/Colors"
import {GradientParameters} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import type {RoundedRectangleVisualParameters} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {StateName} from "../Element"

export const PLACEHOLDER_TEXT_COLOR = new vec4(0.6, 0.6, 0.6, 1)
// Uses the warm input-text token and a 0.6 corner radius per DS3.0.
export const DEFAULT_TEXT_COLOR = InputTextWarm
export const CORNER_RADIUS = 0.6
export const DEFAULT_BEHAVIOR = true
export const DEBUG_RENDER = false

export const INSET_FACTOR_SINGLE_LINE = 0.3
export const FONT_SIZE_SCALE = 11
export const DEFAULT_FONT_SIZE = 96
export const HOVER_SCALE_FACTOR = 1.05
export const STATE_ANIMATION_DURATION = 0.333
export const MASK_Z_OFFSET = 0.01
export const RESIZE_THRESHOLD = 0.001
export const KEYBOARD_DELAY_DESELECT = 750
export const KEYBOARD_DELAY_DEFAULT = 16

export enum IconState {
  default,
  alternate
}

export type TextInputStateType = {
  textColor: vec4
  icon: IconState
  size?: () => vec3
}

export enum TextAlignment {
  Left = "left",
  Center = "center",
  Right = "right"
}

export enum OverflowMode {
  Scroll = "scroll",
  Truncate = "truncate",
  AutoSize = "autoSize"
}

export enum AutoSizeAnchor {
  Top = "top",
  Center = "center",
  Bottom = "bottom"
}

const TEXT_INPUT_GRADIENT_START = new vec2(-1, 0)
const TEXT_INPUT_GRADIENT_END = new vec2(1, 0)

function createSolidTextInputGradient(color: vec4): GradientParameters {
  return {
    enabled: true,
    type: "Linear",
    start: TEXT_INPUT_GRADIENT_START,
    end: TEXT_INPUT_GRADIENT_END,
    stop0: {enabled: true, percent: 0, color: color},
    stop1: {enabled: true, percent: 1, color: color}
  }
}

const BACKGROUND_GRADIENT_PARAMETERS: {[key: string]: GradientParameters} = {
  default: createSolidTextInputGradient(InputIdleBackground),
  hovered: createSolidTextInputGradient(InputHoverBackground),
  toggled: createSolidTextInputGradient(InputToggledBackground),
  toggledHovered: createSolidTextInputGradient(InputHoverBackground),
  inactive: createSolidTextInputGradient(InputInactiveBackground)
}

// DS3.0 text surfaces stay flush — state is conveyed by the fill level only,
// so no shouldPosition / per-state localPosition z offsets here.
export const TEXT_INPUT_VISUAL_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.default,
    hasBorder: false,
    borderSize: 0,
    borderType: "Gradient"
  },
  hovered: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.hovered
  },
  triggered: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.toggled
  },
  toggledDefault: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.toggled
  },
  toggledHovered: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.toggledHovered
  },
  toggledTriggered: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.toggled
  },
  inactive: {
    baseGradient: BACKGROUND_GRADIENT_PARAMETERS.inactive
  }
}

export function createTextInputStateMap(
  getOriginalSize: () => vec3,
  calculateHoverScale: () => vec3
): Map<StateName, TextInputStateType> {
  return new Map([
    [StateName.default, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.default, size: getOriginalSize}],
    [StateName.hovered, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.default, size: calculateHoverScale}],
    [StateName.triggered, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.default, size: calculateHoverScale}],
    [StateName.toggledDefault, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.alternate}],
    [StateName.toggledHovered, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.alternate, size: calculateHoverScale}],
    [StateName.error, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.default}],
    [StateName.errorHovered, {textColor: DEFAULT_TEXT_COLOR, icon: IconState.default, size: calculateHoverScale}],
    [StateName.inactive, {textColor: InputInactiveText, icon: IconState.default}]
  ])
}
