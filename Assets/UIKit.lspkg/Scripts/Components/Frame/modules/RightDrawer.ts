import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import {Timeline} from "Motion.lspkg/Timeline"
import {Intents} from "../../../Motion/SpecIntents"
import {RadioFillGray} from "../../../Themes/System-3.0/Colors"
import {RoundedRectangle} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {Button} from "../../Button/Button"
import {ElementContent} from "../../Content/ElementContent"
import {Frame, FrameAppearance} from "../Frame"
import {FRAME_BUTTON_SETTINGS_BY_APPEARANCE} from "../FrameButtonSettings"

type DrawerItemConfig = {
  icon: Texture
  isToggle?: boolean
  onTriggerUp: () => void
  name?: string
}

type DrawerItem = {
  sceneObject: SceneObject
  button: Button
  content: ElementContent
}

type DrawerLayoutSettings = {
  drawerWidth: number
  paddingX: number
  paddingY: number
  spacing: number
  cornerRadius: number
}

const DRAWER_PADDING = 0.5
const DRAWER_SPACING = 0.5
const DRAWER_CORNER_RADIUS = 0.6
const HIDE_DELAY_SECONDS = 1.0

const DrawerLayoutByAppearance: Record<FrameAppearance, DrawerLayoutSettings> = {
  Large: {
    drawerWidth: FRAME_BUTTON_SETTINGS_BY_APPEARANCE.Large.buttonSize + DRAWER_PADDING * 2,
    paddingX: DRAWER_PADDING,
    paddingY: DRAWER_PADDING,
    spacing: DRAWER_SPACING,
    cornerRadius: DRAWER_CORNER_RADIUS
  },
  Small: {
    drawerWidth: FRAME_BUTTON_SETTINGS_BY_APPEARANCE.Small.buttonSize + DRAWER_PADDING * 2,
    paddingX: DRAWER_PADDING,
    paddingY: DRAWER_PADDING,
    spacing: DRAWER_SPACING,
    cornerRadius: DRAWER_CORNER_RADIUS
  }
}

/**
 * RightDrawer — a vertical stack of buttons that slides out from behind the
 * frame's right edge on show, and slides back in on hide. Hidden state parks
 * the drawer inside the frame body's x range at a z behind the body, so the
 * body occludes it; visible state places the drawer outside the right edge.
 *
 * Top-anchored: the drawer's top edge stays put as items are added or
 * removed, so the first item's position remains stable.
 */
export default class RightDrawer {
  private frame: Frame
  private drawerObject: SceneObject
  private backgroundObject: SceneObject
  private background: RoundedRectangle
  private items: DrawerItem[] = []
  private _renderOrder: number = 0
  private _opacity: number = 1
  private _visible: boolean = false
  private _visibleAnchor: vec3 = vec3.zero()
  private _hiddenAnchor: vec3 = vec3.zero()
  // Retained "drawer.slide" timeline: show plays forward, hide reverses.
  // Rebuilt when the anchors move (resize/appearance change).
  private _slideTimeline: Timeline | null = null
  private _slideGeometryKey = ""
  private _slideCallbacks: (() => void)[] = []
  private _pendingHideToken: CancelToken | null = null
  private _pendingHideCallbacks: Array<() => void> = []

  public constructor(options: {frame: Frame; initialVisible?: boolean}) {
    this.frame = options.frame
    this._visible = options.initialVisible ?? false
    const layout = this.layoutSettings

    this.drawerObject = global.scene.createSceneObject("FrameRightDrawer")
    // Parent to the frame's drawer host — a chrome child ordered BEFORE the
    // body so the canvas's hierarchy sorting occludes the tucked drawer
    // (same transform space as frameObject; see Frame.drawerParent).
    this.drawerObject.setParent(this.frame.drawerParent)
    this.drawerObject.layer = this.frame.drawerParent.layer
    this.drawerObject.enabled = false

    this.backgroundObject = global.scene.createSceneObject("FrameRightDrawerBackground")
    this.backgroundObject.setParent(this.drawerObject)
    this.backgroundObject.layer = this.drawerObject.layer

    this.background = this.backgroundObject.createComponent(RoundedRectangle.getTypeName())
    this.background.initialize()
    this.background.cornerRadius = layout.cornerRadius
    this.background.backgroundColor = RadioFillGray
    this.background.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    this.background.renderMeshVisual.mainPass.twoSided = true
    this.background.size = new vec2(layout.drawerWidth, 0.1)

    this.computeAnchors()
    this.snapToCurrentAnchor()
  }

  private get layoutSettings(): DrawerLayoutSettings {
    return DrawerLayoutByAppearance[this.frame.appearance]
  }

  private get buttonSettings() {
    return FRAME_BUTTON_SETTINGS_BY_APPEARANCE[this.frame.appearance]
  }

  public addItem(config: DrawerItemConfig): Button {
    const buttons = this.buttonSettings

    const itemObject = global.scene.createSceneObject(config.name ?? "DrawerButton")
    itemObject.setParent(this.drawerObject)
    itemObject.layer = this.drawerObject.layer

    const button = itemObject.createComponent(Button.getTypeName()) as Button
    button.setVariant({theme: "System 3.0", shape: "Rectangle", style: "Ghost"})
    button.size = new vec3(buttons.buttonSize, buttons.buttonSize, 1)

    button.onTriggerUp.add(() => {
      config.onTriggerUp()
    })
    if (config.isToggle) button.setIsToggleable?.(true)
    button.initialize()

    const content = itemObject.createComponent(ElementContent.getTypeName()) as ElementContent
    content.leadingIconSize = buttons.iconSize
    content.leadingIcon = config.icon

    const item: DrawerItem = {sceneObject: itemObject, button, content}
    this.items.push(item)

    // Drawer subtree is only enabled when actively shown or animating —
    // keeps the Buttons' Interactables from being hit-tested while parked
    // behind the frame body.
    this.drawerObject.enabled = this._visible
    this.applyRenderOrderToItem(item)
    this.applyOpacityToItem(item)
    this.layout()

    return button
  }

  /**
   * Cancel pending hide timer and any in-flight slide animation. Called by
   * Frame's OnDestroyEvent so the timer doesn't fire on a destroyed
   * SceneObject after the frame is torn down. The drawer's SceneObjects
   * are children of frame.drawerParent (the frame-managed chrome subtree)
   * and get cleaned up with it.
   */
  public destroy(): void {
    this.cancelPendingHide()
    this._slideTimeline?.kill()
    this._slideTimeline = null
  }

  /**
   * Toggle an item's visibility and re-run layout so the drawer collapses
   * around remaining enabled items (no dead vertical gap). Returns true if
   * the item was found.
   */
  public setItemEnabled(button: Button, enabled: boolean): boolean {
    const item = this.items.find((i) => i.button === button)
    if (!item) return false
    item.sceneObject.enabled = enabled
    this.layout()
    return true
  }

  public removeItem(button: Button): void {
    const idx = this.items.findIndex((item) => item.button === button)
    if (idx < 0) return
    const item = this.items[idx]
    this.items.splice(idx, 1)
    item.sceneObject.destroy()
    if (this.items.length === 0) {
      this.drawerObject.enabled = false
      return
    }
    this.layout()
  }

  /**
   * Bounding box of the drawer's visible-state region in frame-local space.
   * Returns null when the drawer has no enabled items (nothing to anchor
   * adjacent UI against). Use this for tooltip/popup placement that needs
   * the drawer's vertical extent as well as its horizontal edge — the
   * bounds reflect the visible-state (slid-out) position, not the current
   * animated frame, so consumers can plan layout against the maximum
   * footprint.
   */
  public getBounds(): {center: vec3; size: vec2} | null {
    const enabledItems = this.items.filter((i) => i.sceneObject.enabled)
    const n = enabledItems.length
    if (n === 0) return null
    const layout = this.layoutSettings
    const buttons = this.buttonSettings
    const drawerHeight = layout.paddingY * 2 + n * buttons.buttonSize + (n - 1) * layout.spacing
    // visibleAnchor is the top-center; bbox center is half-height below.
    const center = new vec3(this._visibleAnchor.x, this._visibleAnchor.y - drawerHeight / 2, this._visibleAnchor.z)
    return {center, size: new vec2(layout.drawerWidth, drawerHeight)}
  }

  /** Re-anchor the drawer after a frame size or appearance change. */
  public resize(): void {
    this.computeAnchors()
    this.snapToCurrentAnchor()
    this.layout()
  }

  /** Slide the drawer out from behind the frame. Cancels any pending hide. */
  public show(endCallback?: () => void): void {
    this.cancelPendingHide()
    // Only enable the drawer subtree if there's actually something to show —
    // an all-disabled drawer would slide out as an empty gray box otherwise.
    if (this.items.some((i) => i.sceneObject.enabled)) {
      this.drawerObject.enabled = true
    }
    if (this._visible) {
      endCallback?.()
      return
    }
    this._visible = true
    this.playSlide(true, endCallback)
  }

  /**
   * Schedule the drawer to slide back behind the frame after a short delay.
   * Calling `show()` during the delay cancels the pending hide. The drawer
   * subtree is disabled at the end of the slide so hidden buttons don't
   * receive interactor hits.
   *
   * Multiple `hide()` calls during the pending window queue their
   * callbacks; all fire when the slide-back animation completes. Calling
   * `hide()` when already hidden fires the callback synchronously.
   */
  public hide(endCallback?: () => void): void {
    if (!this._visible) {
      endCallback?.()
      return
    }
    if (endCallback) this._pendingHideCallbacks.push(endCallback)
    if (this._pendingHideToken !== null) return
    this._pendingHideToken = setTimeout(() => {
      this._pendingHideToken = null
      this._visible = false
      const callbacks = this._pendingHideCallbacks
      this._pendingHideCallbacks = []
      this.playSlide(false, () => {
        this.drawerObject.enabled = false
        for (const cb of callbacks) cb()
      })
    }, HIDE_DELAY_SECONDS * 1000)
  }

  private cancelPendingHide(): void {
    if (this._pendingHideToken !== null) {
      clearTimeout(this._pendingHideToken)
      this._pendingHideToken = null
    }
    // Drop dangling callbacks — show() means we're not hiding anymore, so
    // _onHideVisualEvent listeners shouldn't fire.
    this._pendingHideCallbacks = []
  }

  public get isVisible(): boolean {
    return this._visible
  }

  private computeAnchors(): void {
    const layout = this.layoutSettings
    const buttons = this.buttonSettings
    const visible = this.frame.frameVisual.getRightDrawerAnchor(
      this.frame.totalSize,
      layout.drawerWidth,
      buttons.offset
    )
    this._visibleAnchor = visible
    // Hidden: drawer shifted left by its full width so its right edge meets
    // the frame's right edge — fully inside the body's x range, occluded by
    // the body's opaque render.
    this._hiddenAnchor = new vec3(visible.x - layout.drawerWidth, visible.y, visible.z)
  }

  private snapToCurrentAnchor(): void {
    this._slideTimeline?.pause()
    // Anchors moved: the retained timeline was built against the old ones.
    this._slideGeometryKey = ""
    const target = this._visible ? this._visibleAnchor : this._hiddenAnchor
    this.drawerObject.getTransform().setLocalPosition(target)
    // Snap aborts any in-flight slide; the slide's completion would otherwise
    // finish the state transition (e.g. drawerObject.enabled = false on a
    // hide). Fire the pending callbacks so resize() during a hide doesn't
    // strand the drawer in an interactable-but-invisible state.
    const pending = this._slideCallbacks
    this._slideCallbacks = []
    for (const cb of pending) cb()
  }

  /**
   * Plays the retained "drawer.slide" timeline in the given direction.
   * Interruption is a direction change from the current playhead; a new play
   * supersedes the previous completion callback (matching the old cancel
   * semantics). The timeline rebuilds when the anchors have moved.
   */
  private playSlide(show: boolean, endCallback?: () => void): void {
    this._slideCallbacks = endCallback ? [endCallback] : []
    const v = this._visibleAnchor
    const h = this._hiddenAnchor
    const geometryKey = `${v.x}|${v.y}|${v.z}|${h.x}`
    if (this._slideTimeline === null || geometryKey !== this._slideGeometryKey) {
      this._slideTimeline?.kill()
      this._slideGeometryKey = geometryKey
      this._slideTimeline = Intents.drawerSlide(
        {
          target: this.drawerObject,
          hidden: h,
          visible: v,
          onComplete: () => {
            const callbacks = this._slideCallbacks
            this._slideCallbacks = []
            for (const cb of callbacks) cb()
          }
        },
        {direction: show ? "forward" : "reverse"}
      )
    } else {
      this._slideTimeline.play(show)
    }
  }

  private layout(): void {
    const layout = this.layoutSettings
    const buttons = this.buttonSettings
    // Disabled items don't take a slot — the drawer collapses around the
    // remaining enabled ones so toggling visibility doesn't leave dead gaps.
    const enabledItems = this.items.filter((i) => i.sceneObject.enabled)
    const n = enabledItems.length
    if (n === 0) {
      // No content to lay out — disable the drawer subtree so a stale
      // background doesn't slide out on the next show.
      this.drawerObject.enabled = false
      return
    }
    // Going from 0 → n enabled items (e.g. re-enabling follow at runtime)
    // needs to re-enable the drawer subtree if we're already visible.
    // Gated on opacity so a fade-out in progress isn't reverted here.
    if (this._visible && this._opacity > 0) {
      this.drawerObject.enabled = true
    }

    const drawerHeight = layout.paddingY * 2 + n * buttons.buttonSize + (n - 1) * layout.spacing

    // Extend the background left by cornerRadius so the left rounded corners
    // sit behind the frame body and get occluded — the visible portion (right
    // of the frame edge) shows a straight left edge with rounded right corners.
    const bgWidth = layout.drawerWidth + layout.cornerRadius
    this.background.size = new vec2(bgWidth, drawerHeight)
    this.backgroundObject.getTransform().setLocalPosition(new vec3(-layout.cornerRadius * 0.5, -drawerHeight * 0.5, 0))

    for (let i = 0; i < n; i++) {
      const cy = -layout.paddingY - buttons.buttonSize * 0.5 - i * (buttons.buttonSize + layout.spacing)
      enabledItems[i].sceneObject.getTransform().setLocalPosition(new vec3(0, cy, 0.1))
    }
  }

  public set opacity(alpha: number) {
    if (alpha === undefined) return
    this._opacity = alpha
    this.background.opacity = alpha
    for (const item of this.items) {
      this.applyOpacityToItem(item)
    }
    // When the drawer is logically visible but fully faded out (autoShowHide
    // body-fade hit 0 ahead of the slide), disable the subtree so the
    // invisible buttons can't be hit-tested. Without this there's a ~1.1s
    // window between body-fade-end and slide-end where ghost clicks land.
    if (this._visible && this.items.some((i) => i.sceneObject.enabled)) {
      this.drawerObject.enabled = alpha > 0
    }
  }

  private applyOpacityToItem(item: DrawerItem): void {
    item.button.opacity = this._opacity
    item.content.opacity = this._opacity
    item.content.setRenderingEnabled(this._opacity > 0)
  }

  public set renderOrder(order: number) {
    if (order === undefined) return
    this._renderOrder = order
    this.background.renderMeshVisual.setRenderOrder(order)
    for (const item of this.items) {
      this.applyRenderOrderToItem(item)
    }
  }

  private applyRenderOrderToItem(item: DrawerItem): void {
    // Flat renderOrder: under the frame's canvas, layering comes from
    // hierarchy order (items are children of the drawer, icon containers are
    // children of their buttons) plus ElementContent's z gap.
    item.button.renderOrder = this._renderOrder
    item.content.renderOrder = this._renderOrder
  }
}
