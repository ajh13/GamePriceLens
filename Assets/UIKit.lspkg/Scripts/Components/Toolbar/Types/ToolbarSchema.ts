import {TextInputType} from "../../TextInputField/TextInputField"
import {Ranking} from "../../TextStylePresets/TextStylePresets"
import {ToolbarItem} from "../Items/ToolbarItem"

/** How an item gets its size: fill available space or manual (explicit size). Use when building config or setting ToolbarItemInput size mode. */
export const ToolbarItemSizeMode = {
  FILL: "fill" as const,
  MANUAL: "manual" as const
}
export type ToolbarItemSizeMode = (typeof ToolbarItemSizeMode)[keyof typeof ToolbarItemSizeMode]

export type AxisSizeMode = typeof ToolbarItemSizeMode.FILL | number

/**
 * @example
 * ```ts
 * size: new vec2(10, 5)                           // Manual: explicit size
 * size: { x: ToolbarItemSizeMode.FILL, y: 5 }     // Per-axis: fill width, fixed height
 * ```
 */
export type ToolbarItemSize = vec2 | {x: AxisSizeMode; y: AxisSizeMode}

/**
 * A label size: either a raw Text size, or a ranking from the TextStylePresets
 * ramp, which resolves to a design size and a font weight.
 * @example
 * ```ts
 * textSize: 42                 // raw size
 * textSize: Ranking.Caption    // preset size + weight
 * ```
 */
export type ToolbarTextSize = number | Ranking

/** Item type for toolbar items (use in config.type and ToolbarItemInput). */
export const ToolbarItemType = {
  BUTTON: "button" as const,
  TEXTFIELD: "textfield" as const,
  SLIDER: "slider" as const,
  TOGGLE: "toggle" as const,
  SEPARATOR: "separator" as const,
  CUSTOM: "custom" as const
}
export type ToolbarItemType = (typeof ToolbarItemType)[keyof typeof ToolbarItemType]

/** Button shape for button items (ToolbarButtonConfig.buttonType). */
export const ToolbarButtonType = {
  RECTANGLE: "rectangle" as const,
  CAPSULE: "capsule" as const
}
export type ToolbarButtonType = (typeof ToolbarButtonType)[keyof typeof ToolbarButtonType]

/**
 * What pressing a button item does (ToolbarButtonConfig.behavior). `tap` is the
 * plain Button; the others build a different Button subclass on the same item.
 */
export const ToolbarButtonBehavior = {
  /** Fires onTriggerUp on release. The default. */
  TAP: "tap" as const,
  /** Latches on and off through Button's toggle mode: `isOn`, `onToggled`. */
  TOGGLE: "toggle" as const,
  /** A LongPressButton: fills while held and completes after `holdSeconds`. */
  HOLD: "hold" as const,
  /** A VoiceInputButton: listens while on and reports transcripts. */
  VOICE: "voice" as const
}
export type ToolbarButtonBehavior = (typeof ToolbarButtonBehavior)[keyof typeof ToolbarButtonBehavior]
const BUTTON_BEHAVIOR_VALUES: ReadonlySet<string> = new Set<string>(Object.values(ToolbarButtonBehavior))

/** Transcription format of a voice button (VoiceInputButton.format). */
export type ToolbarVoiceFormat = "default" | "search" | "url"

/** How icon size is determined on button/textfield (fixed size vs fill). */
export const ToolbarIconSizeMode = {
  FIXED: "fixed" as const,
  FILL: "fill" as const
}
export type ToolbarIconSizeMode = (typeof ToolbarIconSizeMode)[keyof typeof ToolbarIconSizeMode]

export interface ToolbarItemConfig {
  type: ToolbarItemType
  alignment: ToolbarAlignment
  id?: string
  size?: ToolbarItemSize
  minSize?: vec2
  maxSize?: vec2
  inactive?: boolean
  alpha?: number
  /**
   * Hover tooltip text. When set, a themed UIKit Tooltip fades in above the item
   * on hover (hidden while the item is inactive). Read {@link ToolbarItem.tooltip}
   * to change the text at runtime.
   */
  tooltip?: string
  /**
   * Explicit draw order for this item's renderables, applied verbatim. Unset
   * (the default) the item takes the toolbar's flat `renderOrder`, so the
   * toolbar's Hierarchy Canvas orders it by tree order and z: items sit ahead
   * of the background plate, and an attached item 0.1 cm ahead of its target.
   * A non-zero value outranks the Canvas — the escape hatch for an attached
   * item that must draw over content outside the toolbar's subtree, which
   * hierarchy sorting cannot lift it above. Nothing in the toolbar sets it.
   */
  renderOrder?: number
  attachTo?: string
  attachmentPosition?: ToolbarAttachmentPosition
  attachmentOffset?: vec2
  onTriggerUp?: () => void
  onTriggerDown?: () => void
  onHoverEnter?: () => void
  onHoverExit?: () => void
  onCreated?: (item: ToolbarItem) => void
}

const ID_RADIX = 36
const ID_SUFFIX_START = 2
const ID_SUFFIX_LENGTH = 9

/**
 * Generates a unique id for a toolbar item (e.g. for use in addItem config).
 * @param baseName - Prefix for the id (default "item").
 */
export function generateToolbarItemId(baseName: string = "item"): string {
  const s = Math.random().toString(ID_RADIX)
  const suffix = s.slice(ID_SUFFIX_START, ID_SUFFIX_START + ID_SUFFIX_LENGTH)
  return `${baseName}_${suffix}`
}

export interface ToolbarButtonConfig extends ToolbarItemConfig {
  type: "button"
  buttonType?: ToolbarButtonType
  icon?: Texture
  iconSizeMode?: ToolbarIconSizeMode
  text?: string
  iconAlignment?: ToolbarHorizontalAlignment
  textAlignment?: ToolbarAlignment
  hideTextWhenTooSmall?: boolean
  /**
   * Label size, as a raw size or a TextStylePresets ranking. Defaults to 30, the
   * size every toolbar button used before this was configurable.
   */
  textSize?: ToolbarTextSize
  /** Theme override for the button visual ("System 2.0" | "System 3.0"). Defaults to the inherited theme. */
  theme?: string
  /** Style name within the theme (e.g. "Primary", "Secondary", "Ghost"). Defaults to the theme's default style. */
  style?: string
  /**
   * What a press does; see {@link ToolbarButtonBehavior}. Defaults to `tap`.
   * `voice` keeps VoiceInputButton's own System 3.0 look and mic icon, so
   * `buttonType`, `theme`, `style`, `icon` and `text` are ignored for it.
   */
  behavior?: ToolbarButtonBehavior
  /** `toggle`: start in the on state. */
  isOn?: boolean
  /** `toggle` and `voice`: the on state changed (for voice, listening started or stopped). */
  onToggled?: (isOn: boolean) => void
  /** `hold`: seconds of continuous hold to complete. Unset or 0 uses the theme's (1 s). */
  holdSeconds?: number
  /** `hold`: seconds for the fill to drain after an early release. Unset or 0 uses the theme's (0.25 s). */
  drainSeconds?: number
  /**
   * `hold`: re-arm when the trigger ends. Off (the default) the button stays
   * complete until `reset()` is called on {@link ToolbarButton.longPressButton}.
   */
  repeatable?: boolean
  /** `hold`: a hold began. */
  onHoldStart?: () => void
  /** `hold`: the hold completed. `onTriggerUp` still fires on a short tap, so listen here for the action. */
  onHoldComplete?: () => void
  /** `hold`: the hold ended early, with the progress it had reached (0-1). */
  onHoldCanceled?: (progress: number) => void
  /** `voice`: the transcription format. Defaults to "default". */
  voiceFormat?: ToolbarVoiceFormat
  /** `voice`: a partial or final transcript. */
  onListeningUpdate?: (text: string, isFinal: boolean) => void
  /** `voice`: recognition failed; the button turns itself off. */
  onListeningError?: (error: AsrModule.AsrStatusCode) => void
}

export interface ToolbarTextFieldConfig extends ToolbarItemConfig {
  type: "textfield"
  /**
   * Theme override for the field ("System 2.0" | "System 3.0"). Defaults to the inherited theme.
   * Unlike a button there is no style choice: TextInputField has a single visual per theme.
   */
  theme?: string
  placeholder?: string
  initialText?: string
  textAlignment?: ToolbarAlignment
  /**
   * Icon shown in the field's action slot. The slot's SIDE is not configurable
   * here: it follows `textAlignment`, sitting at the left edge unless the text is
   * right-aligned, with the clear button taking the opposite edge.
   */
  icon?: Texture
  /**
   * @deprecated Has no effect. It placed the icon until TextInputField dropped
   * `setIconSide`; the slot's side now follows `textAlignment` (see {@link icon}).
   * Kept so configs that set it still compile; setting it logs a warning. It will
   * be removed in a later major version.
   */
  iconSide?: ToolbarHorizontalAlignment
  /**
   * Keyboard type for the field ("url", "email", "numeric", …). The field
   * snapshots this at init, so it can only be set through config.
   */
  inputType?: TextInputType
  onSubmit?: (text: string) => void
  onTextChanged?: (text: string) => void
  onFocusGained?: () => void
  onFocusLost?: () => void
  /**
   * Fires with the final transcript when a voice-input session ends. Separate
   * from `onSubmit`: a consumer that treats dictation as a submit forwards it.
   */
  onVoiceFinalize?: (text: string) => void
  /** Fires true when a voice-input session starts and false when it ends, by any cause. */
  onVoiceStateChanged?: (isActive: boolean) => void
}

export interface ToolbarSliderConfig extends ToolbarItemConfig {
  type: "slider"
  min: number
  max: number
  value?: number
  step?: number
  segmented?: boolean
  numberOfSegments?: number
  onValueChanged?: (value: number) => void
}

export interface ToolbarToggleConfig extends ToolbarItemConfig {
  type: "toggle"
  isOn?: boolean
  onToggled?: (isOn: boolean) => void
}

export interface ToolbarSeparatorConfig extends ToolbarItemConfig {
  type: "separator"
  thickness?: number
  height?: number
  color?: vec4
}

export interface ToolbarCustomItemConfig extends ToolbarItemConfig {
  type: "custom"
  customObject?: SceneObject
  /**
   * Optional callback invoked instead of the default fade when alpha changes. By default the item fades its
   * custom subtree through a `VisibilityGroup` (each renderable's authored alpha multiplied by the item's
   * effective alpha; renderables disabled at 0). Use this when the custom object contains components that
   * manage their own visual state, or already sits under a `VisibilityGroup` of its own (two groups over one
   * root fight).
   */
  onSetAlpha?: (alpha: number) => void
  /** Optional callback invoked instead of the default disabled visuals update. Use this when the custom object contains components that manage their own disabled state. */
  onUpdateDisabledVisuals?: (inactive: boolean) => void
  /** Optional callback invoked after layout with the computed cell size (cm). Use this to fit the custom object to its cell through its own size channel; the toolbar never scales custom content itself. */
  onResize?: (size: vec2) => void
}

export type AnyToolbarItemConfig =
  | ToolbarButtonConfig
  | ToolbarTextFieldConfig
  | ToolbarSliderConfig
  | ToolbarToggleConfig
  | ToolbarSeparatorConfig
  | ToolbarCustomItemConfig

export type ToolbarSizingMode = "fixed" | "frame-fit"
export type ToolbarFramePosition = "top" | "bottom" | "left" | "right"
export type ToolbarDirection = "horizontal" | "vertical"

/** Toolbar layout direction (Toolbar.direction, ToolbarConfig.direction). */
export const ToolbarDirections = {
  HORIZONTAL: "horizontal" as const,
  VERTICAL: "vertical" as const
}

/** Position of an attached item relative to its attachTo item (attachmentPosition). */
export const ToolbarAttachmentPosition = {
  LEFT: "left" as const,
  RIGHT: "right" as const,
  TOP: "top" as const,
  BOTTOM: "bottom" as const,
  CENTER: "center" as const
} as const

export type ToolbarAttachmentPosition = (typeof ToolbarAttachmentPosition)[keyof typeof ToolbarAttachmentPosition]

/** Toolbar position relative to Frame (Toolbar.framePosition when frame is set). */
export const ToolbarFramePositionEnum = {
  TOP: "top" as const,
  BOTTOM: "bottom" as const,
  LEFT: "left" as const,
  RIGHT: "right" as const
} as const

export type ToolbarFramePositionEnum = (typeof ToolbarFramePositionEnum)[keyof typeof ToolbarFramePositionEnum]

/** Vertical or horizontal alignment of item content (e.g. alignment, textAlignment). */
export const ToolbarAlignment = {
  LEFT: "left" as const,
  CENTER: "center" as const,
  RIGHT: "right" as const
} as const

export type ToolbarAlignment = (typeof ToolbarAlignment)[keyof typeof ToolbarAlignment]

/** Left/right/center alignment (e.g. iconAlignment). */
export const ToolbarHorizontalAlignment = {
  LEFT: "left" as const,
  CENTER: "center" as const,
  RIGHT: "right" as const
} as const

export type ToolbarHorizontalAlignment = (typeof ToolbarHorizontalAlignment)[keyof typeof ToolbarHorizontalAlignment]

export interface ToolbarPadding {
  left?: number
  right?: number
  top?: number
  bottom?: number
}

export interface ToolbarBackgroundConfig {
  cornerRadius?: number
  /** Background color (RGBA). When alpha is also set, alpha overrides color.w in the visual. */
  color?: vec4
  /** Opacity 0–1. When set, overrides the alpha channel of color. */
  alpha?: number
  enabled?: boolean
}

export interface ToolbarConfig {
  sizingMode: ToolbarSizingMode
  size?: vec2
  direction: ToolbarDirection
  padding?: ToolbarPadding
  spacing?: number
  background?: ToolbarBackgroundConfig
  framePosition?: ToolbarFramePosition
  frameGap?: number
  isToolbarInsideFrame?: boolean
}

export function isVec2Size(size: ToolbarItemSize): size is vec2 {
  return size instanceof vec2
}

export function isPerAxisSize(size: ToolbarItemSize): size is {x: AxisSizeMode; y: AxisSizeMode} {
  return typeof size === "object" && size !== null && !(size instanceof vec2) && "x" in size && "y" in size
}

export function isNumericAxisSize(size: AxisSizeMode): size is number {
  return typeof size === "number"
}

export function getSizeModeFromSize(size?: ToolbarItemSize): ToolbarItemSizeMode {
  if (!size) return ToolbarItemSizeMode.FILL
  if (size instanceof vec2) return ToolbarItemSizeMode.MANUAL
  if (size.x === ToolbarItemSizeMode.FILL || size.y === ToolbarItemSizeMode.FILL) return ToolbarItemSizeMode.FILL
  return ToolbarItemSizeMode.MANUAL
}

export function getToolbarDirectionFromSceneObject(sceneObject: SceneObject): ToolbarDirection {
  let parent = sceneObject.getParent()
  while (parent) {
    const scripts = parent.getComponents("ScriptComponent")
    for (let i = 0; i < scripts.length; i++) {
      const direction = (scripts[i] as {direction?: string}).direction
      if (direction === ToolbarDirections.HORIZONTAL || direction === ToolbarDirections.VERTICAL) {
        return direction as ToolbarDirection
      }
    }
    parent = parent.getParent()
  }
  return ToolbarDirections.HORIZONTAL
}

export function getDefaultPadding(): Required<ToolbarPadding> {
  return {left: 1, right: 1, top: 0.5, bottom: 0.5}
}

export function mergePadding(padding?: ToolbarPadding): Required<ToolbarPadding> {
  const defaults = getDefaultPadding()
  if (!padding) return defaults

  return {
    left: padding.left ?? defaults.left,
    right: padding.right ?? defaults.right,
    top: padding.top ?? defaults.top,
    bottom: padding.bottom ?? defaults.bottom
  }
}

export function getDefaultBackgroundConfig(): Required<ToolbarBackgroundConfig> {
  const alpha = 0.9
  return {
    cornerRadius: 1.25,
    color: new vec4(0.173, 0.173, 0.173, alpha),
    alpha,
    enabled: true
  }
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function validateToolbarConfig(config: ToolbarConfig): void {
  if (config.sizingMode === "fixed" && !config.size) {
    throw new Error("Toolbar: 'size' is required when sizingMode is 'fixed'")
  }

  if (config.size && (!isFinitePositive(config.size.x) || !isFinitePositive(config.size.y))) {
    throw new Error("Toolbar: 'size' must have finite positive dimensions")
  }

  if (config.spacing !== undefined && !isFiniteNonNegative(config.spacing)) {
    throw new Error("Toolbar: 'spacing' must be a finite non-negative number")
  }

  if (config.frameGap !== undefined && !isFiniteNonNegative(config.frameGap)) {
    throw new Error("Toolbar: 'frameGap' must be a finite non-negative number")
  }
}

export function validateItemConfig(config: AnyToolbarItemConfig): void {
  if (!config.id || config.id.trim() === "") {
    config.id = generateToolbarItemId("item")
  }

  if (config.type === ToolbarItemType.BUTTON) {
    const button = config as ToolbarButtonConfig
    if (button.behavior !== undefined && !BUTTON_BEHAVIOR_VALUES.has(button.behavior)) {
      throw new Error(`Toolbar item '${config.id}': unknown button behavior '${button.behavior}'`)
    }
    for (const key of ["holdSeconds", "drainSeconds"] as const) {
      const seconds = button[key]
      if (seconds !== undefined && !isFiniteNonNegative(seconds)) {
        throw new Error(`Toolbar item '${config.id}': '${key}' must be finite and non-negative`)
      }
    }
  }

  if (config.minSize) {
    if (!isFiniteNonNegative(config.minSize.x) || !isFiniteNonNegative(config.minSize.y)) {
      throw new Error(`Toolbar item '${config.id}': 'minSize' must be finite and non-negative`)
    }
  }

  if (config.maxSize) {
    if (!isFiniteNonNegative(config.maxSize.x) || !isFiniteNonNegative(config.maxSize.y)) {
      throw new Error(`Toolbar item '${config.id}': 'maxSize' must be finite and non-negative`)
    }
  }

  if (config.minSize && config.maxSize) {
    if (config.minSize.x > config.maxSize.x || config.minSize.y > config.maxSize.y) {
      throw new Error(`Toolbar item '${config.id}': 'minSize' cannot be greater than 'maxSize'`)
    }
  }
}
