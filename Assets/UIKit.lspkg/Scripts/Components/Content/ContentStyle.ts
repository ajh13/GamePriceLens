import {SYSTEM_2_NAME} from "../../Themes/Theme"
import {ThemeService} from "../../Themes/ThemeService"

/** Per-state content color definition for text and icon tinting. */
export type ContentColorState = {
  textColor: vec4
  iconTint: vec4
}

/** Maps interaction state names to content colors. */
export type ContentStyle = Partial<Record<string, ContentColorState>>

/** Resolution key for looking up themed content colors. */
export type ContentStyleKey = {
  visualElementType: string
  style: string
  themeName?: string
}

/** Universal fallback content colors when no theme-specific entry exists. */
export const CONTENT_COLOR_DEFAULTS: ContentStyle = {
  default: {textColor: new vec4(0.85, 0.85, 0.85, 1), iconTint: new vec4(0.85, 0.85, 0.85, 1)},
  hovered: {textColor: new vec4(1, 1, 1, 1), iconTint: new vec4(1, 1, 1, 1)},
  triggered: {textColor: new vec4(0.75, 0.75, 0.75, 1), iconTint: new vec4(0.75, 0.75, 0.75, 1)},
  toggledDefault: {textColor: new vec4(1, 1, 1, 1), iconTint: new vec4(1, 1, 1, 1)},
  toggledHovered: {textColor: new vec4(1, 1, 1, 1), iconTint: new vec4(1, 1, 1, 1)},
  toggledTriggered: {textColor: new vec4(0.75, 0.75, 0.75, 1), iconTint: new vec4(0.75, 0.75, 0.75, 1)},
  inactive: {textColor: new vec4(1, 1, 1, 0.35), iconTint: new vec4(1, 1, 1, 0.35)}
}

/**
 * Resolve content colors for a given element type, style, and state.
 *
 * Resolution chain:
 * 1. Requested theme → component type → style → state
 * 2. Requested theme → component type → default style → state
 * 3. System2 fallback → same lookups
 * 4. Universal defaults
 */
export function resolveContentColors(key: ContentStyleKey, stateName: string): ContentColorState {
  const mgr = ThemeService.getInstance()

  const requestedTheme = key.themeName ? mgr.getTheme(key.themeName) : undefined
  const theme = requestedTheme ?? mgr.currentTheme

  // Try requested theme
  const contentColors = theme.componentData?.["ContentColors"] as
    | Record<string, Record<string, ContentStyle>>
    | undefined
  if (contentColors) {
    const componentColors = contentColors[key.visualElementType]
    if (componentColors) {
      const styleColors = componentColors[key.style]
      if (styleColors?.[stateName]) return styleColors[stateName]!

      const defaultStyleColors = componentColors[theme.defaultStyleName]
      if (defaultStyleColors?.[stateName]) return defaultStyleColors[stateName]!
    }
  }

  // Fallback to System2 if not already System2
  if (theme.name !== SYSTEM_2_NAME) {
    const fallbackTheme = mgr.getTheme("System 2.0")
    if (fallbackTheme) {
      const fallbackColors = fallbackTheme.componentData?.["ContentColors"] as
        | Record<string, Record<string, ContentStyle>>
        | undefined
      if (fallbackColors) {
        const componentColors = fallbackColors[key.visualElementType]
        if (componentColors) {
          const styleColors = componentColors[key.style]
          if (styleColors?.[stateName]) return styleColors[stateName]!

          const defaultStyleColors = componentColors[fallbackTheme.defaultStyleName]
          if (defaultStyleColors?.[stateName]) return defaultStyleColors[stateName]!
        }
      }
    }
  }

  return CONTENT_COLOR_DEFAULTS[stateName] ?? CONTENT_COLOR_DEFAULTS["default"]!
}
