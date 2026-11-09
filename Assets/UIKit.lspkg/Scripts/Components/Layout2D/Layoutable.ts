import {PublicApi} from "InteractionKit.lspkg/Utils/Event"

/**
 * Interface for layouts that can be nested within a LayoutItem.
 * Allows LayoutItem to interact with different layout types (DirectionalLayout, GridLayout)
 * in a generic way to handle size synchronization and nesting.
 */
export interface Layoutable {
  /**
   * The SceneObject this layout component is attached to.
   */
  readonly sceneObject: SceneObject

  /**
   * Width of the layout in local space centimeters.
   */
  width: number

  /**
   * Height of the layout in local space centimeters.
   */
  height: number

  /**
   * Depth of the layout in local space centimeters.
   */
  depth: number

  /**
   * The current size of the layout as a vec3 (width, height, depth).
   */
  readonly layoutSize: vec3

  /**
   * Whether the layout has been initialized.
   */
  readonly initialized: boolean

  /**
   * Event fired when the layout has finished initialization.
   */
  readonly onInitialized: PublicApi<void>

  /**
   * Event fired when the layout size changes.
   * The event payload is the new size as a vec3.
   */
  readonly onSizeChanged: PublicApi<vec3>
}
