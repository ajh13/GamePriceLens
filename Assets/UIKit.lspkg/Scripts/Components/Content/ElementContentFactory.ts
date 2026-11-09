import {ElementContent, TextAlignment, TextSizing} from "./ElementContent"

/**
 * Convenience factory for programmatically adding content to a VisualElement's SceneObject.
 *
 * @param sceneObject - The SceneObject that has (or will have) a VisualElement component.
 * @param config - Content configuration options. The `config` keys below are the
 *   ONLY factory options. Icon SIZE is the most common mistake: `leadingIconSize`/
 *   `trailingIconSize` (a single cm number, uniform — not a vec2) are NOT factory
 *   options; set them on the RETURNED ElementContent. Likewise `ranking`, `padding`,
 *   `opacity`, `renderOrder`, and text color (`useTextColorOverride = true` +
 *   `textColorOverride` — there is no `textColor`) are live properties on the return
 *   value, not config keys.
 * @returns The created ElementContent component.
 */
export function addContentToElement(
  sceneObject: SceneObject,
  config: {
    text?: string
    leadingIcon?: Texture
    trailingIcon?: Texture
    iconLayout?: string
    textAlignment?: TextAlignment
    textSizing?: TextSizing
    textSize?: number
    spacing?: number
    autoResize?: boolean
    sizeOverride?: vec2
    underline?: boolean
  }
): ElementContent {
  const content = sceneObject.createComponent(ElementContent.getTypeName()) as ElementContent

  if (config.underline !== undefined) content.underline = config.underline
  if (config.text !== undefined) content.text = config.text
  if (config.leadingIcon !== undefined) content.leadingIcon = config.leadingIcon
  if (config.trailingIcon !== undefined) content.trailingIcon = config.trailingIcon
  if (config.iconLayout !== undefined) content.iconLayout = config.iconLayout
  if (config.textAlignment !== undefined) content.textAlignment = config.textAlignment
  if (config.textSizing !== undefined) content.textSizing = config.textSizing
  if (config.textSize !== undefined) content.textSize = config.textSize
  if (config.spacing !== undefined) content.spacing = config.spacing
  if (config.autoResize !== undefined) content.autoResize = config.autoResize
  if (config.sizeOverride !== undefined) content.sizeOverride = config.sizeOverride

  return content
}
