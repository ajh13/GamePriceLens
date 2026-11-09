import {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {lerp} from "InteractionKit.lspkg/Utils/mathUtils"
import {UNIT_PLANE_MESH_ASSET} from "../../../../Utility/Assets"
import {LINE_CENTER_OFFSET_RATIO} from "../../../../Utility/TextManipulationUtils"

const CARET_MATERIAL_ASSET: Material = requireAsset("../../../../../Materials/CaretMat.mat") as Material
export const CARET_DEFAULT_COLOR = new vec4(0.317006, 0.450004, 0.4, 1)

// Constants
const CARET_WIDTH = 0.07
const CARET_BLINK_INTERVAL = 500 // milliseconds
const CARET_SIZE_MULTIPLIER_DRAG = 1.2
const CARET_SIZE_MULTIPLIER_DEFAULT = 1.0
// Cosmetic: keeps the Z numbers agreeing with the order the visuals are drawn
// in (highlight layer 0.005 -> caret -> handles 0.01). Draw order itself comes
// from the Hierarchy Canvas tree order (or the +1/+2 no-Canvas fallback), and
// none of the three writes depth, so their relative Z never decides anything.
const CARET_Z_OFFSET = 0.008

/**
 * Rectangle in the caret's parent (Text) local space that the caret can morph toward, e.g. the
 * highlight bounds of the word under it while a long press is held.
 */
export type CaretMorphTarget = {
  centerX: number
  centerY: number
  width: number
  height: number
}

/**
 * Handles all caret visual rendering including position, scale, blinking animation, drag state, and
 * morphing toward a target rectangle.
 */
export class CaretRenderer {
  private readonly caretObject: SceneObject
  private readonly caretTransform: Transform
  private readonly textScreenTransform: ScreenTransform | null
  private readonly caretRMV: RenderMeshVisual
  private readonly caretMaterial: Material
  private caretVisible: boolean = false
  private caretBlinkTimer: number = 0
  private caretBlinkState: boolean = true
  private caretScaleMultiplier: number = CARET_SIZE_MULTIPLIER_DEFAULT

  private readonly _caretScale: vec3 = vec3.one()
  private readonly _caretPosition: vec3 = vec3.zero()
  // What the transform and material actually receive: the plain caret blended toward the morph
  // target. Scratch values, so a morph that updates every frame allocates nothing.
  private readonly _appliedScale: vec3 = vec3.one()
  private readonly _appliedPosition: vec3 = vec3.zero()
  private readonly _appliedColor: vec4 = new vec4(0, 0, 0, 0)

  // `color` reports baseColor; the material shows it blended toward morphColor by morphProgress.
  private baseColor: vec4 = CARET_DEFAULT_COLOR
  private morphProgress: number = 0
  private morphTarget: CaretMorphTarget | null = null
  private morphColor: vec4 = CARET_DEFAULT_COLOR

  private cursorPositions: CursorPosition[] | null = null
  private cursorHeight: number = 0
  private caretIndex: number = 0

  private unsubscribes: (() => void)[] = []

  public constructor(
    private readonly textComponent: Text,
    private readonly caretUpdateEvent: UpdateEvent,
    private readonly onCursorPositionsUpdated: PublicApi<CursorPosition[]>,
    private readonly onCursorHeightUpdated: PublicApi<number>,
    color: vec4 = CARET_DEFAULT_COLOR
  ) {
    this.textScreenTransform = textComponent.sceneObject.getComponent("ScreenTransform")

    this.caretObject = global.scene.createSceneObject("Caret")
    // A new SceneObject starts on the default layer regardless of its parent;
    // copy the Text's so the same Camera renders both (see HighlightRenderer).
    this.caretObject.layer = textComponent.getSceneObject().layer
    this.caretObject.setParent(textComponent.getSceneObject())
    this.caretTransform = this.caretObject.getTransform()
    this.caretRMV = this.caretObject.createComponent("RenderMeshVisual")
    this.caretRMV.mesh = UNIT_PLANE_MESH_ASSET
    this.caretMaterial = CARET_MATERIAL_ASSET.clone()
    this.caretRMV.mainMaterial = this.caretMaterial
    this.setColor(color)
    // Transparent chrome over the text: depth-test so real geometry still
    // occludes it, never depth-write — a translucent quad that wrote depth would
    // occlude whatever is drawn behind it afterwards. CaretMat.mat already ships
    // these flags; set here so the invariant does not depend on the asset.
    this.caretMaterial.mainPass.depthTest = true
    this.caretMaterial.mainPass.depthWrite = false
    // Flat by default; TextManipulationModule.applyRenderOrders owns the
    // no-Canvas fallback bump.
    this.caretRMV.setRenderOrder(textComponent.getRenderOrder())
    // Mirror the RMV's enabled flag to the caret object's at every toggle site, so a hidden or
    // blinked-off caret doesn't leave an alpha-0 RenderMeshVisual enabled in the render pipeline.
    this.caretObject.enabled = false
    this.caretRMV.enabled = false

    this.caretUpdateEvent.bind(() => this.onCaretUpdate())
    this.caretUpdateEvent.enabled = false

    this.unsubscribes.push(
      this.onCursorPositionsUpdated.add((cursorPositions: CursorPosition[]) => {
        this.cursorPositions = cursorPositions
        this.updatePosition(this.caretIndex)
      }),
      this.onCursorHeightUpdated.add((cursorHeight: number) => {
        this.cursorHeight = cursorHeight
        this.updateScale()
        this.updatePosition(this.caretIndex)
      })
    )
  }

  public get color(): vec4 {
    return this.baseColor
  }

  public set color(color: vec4) {
    if (color === undefined) return

    this.setColor(color)
  }

  /** Keeps the caret in the text input's shared hierarchy-sorted render-order band. */
  public set renderOrder(renderOrder: number) {
    this.caretRMV.setRenderOrder(renderOrder)
  }

  /**
   * Shows the caret.
   */
  public show(): void {
    this.caretVisible = true
    this.updateScale()
    this.resetBlink()
    if (this.caretUpdateEvent) {
      this.caretUpdateEvent.enabled = true
    }
  }

  /**
   * Hides the caret.
   */
  public hide(): void {
    this.caretVisible = false
    if (!isNull(this.caretObject)) {
      this.caretObject.enabled = false
      this.caretRMV.enabled = false
    }
    if (this.caretUpdateEvent) {
      this.caretUpdateEvent.enabled = false
    }
  }

  /**
   * Morphs the caret toward a target rectangle and color. Position, size, and color are each
   * interpolated linearly from the plain caret to the target; the morph survives later position and
   * scale updates until {@link clearMorph}.
   * @param progress - 0 for the plain caret, 1 for the target; clamped to that range
   * @param target - Rectangle to morph toward, or null to stay a plain caret until it is known
   * @param color - Color to morph toward
   */
  public setMorph(progress: number, target: CaretMorphTarget | null, color: vec4): void {
    this.morphProgress = target ? Math.max(0, Math.min(1, progress)) : 0
    this.morphTarget = target
    this.morphColor = color
    this.applyTransform()
    this.applyColor()
  }

  /**
   * Returns the caret to its plain shape and color.
   */
  public clearMorph(): void {
    this.setMorph(0, null, this.baseColor)
  }

  /**
   * Updates the visual position of the caret based on the current caret index.
   *
   * @param index - The text caret index to position the visual caret at
   */
  public updatePosition(index: number): void {
    if (!this.caretObject || !this.textComponent) return

    this.caretIndex = index

    const hasValidCursorPosition =
      this.cursorPositions && this.cursorPositions.length > 0 && index < this.cursorPositions.length
    const cursorPos = hasValidCursorPosition ? this.cursorPositions[index] : null

    if (hasValidCursorPosition) {
      const pos = cursorPos.position
      const screenOffsets = this.textScreenTransform?.offsets
      const offsetX = screenOffsets ? (screenOffsets.left + screenOffsets.right) / 2 : 0
      const offsetY = screenOffsets ? (screenOffsets.top + screenOffsets.bottom) / 2 : 0
      this._caretPosition.x = pos.x - offsetX
      this._caretPosition.y = pos.y - offsetY + this._caretScale.y * LINE_CENTER_OFFSET_RATIO
      this._caretPosition.z = CARET_Z_OFFSET
    }

    this.applyTransform()
  }

  /**
   * Updates the local scale of the caret to match the cursor height.
   */
  private updateScale(): void {
    if (!this.caretObject || !this.textComponent) return

    this._caretScale.x = CARET_WIDTH * this.caretScaleMultiplier
    this._caretScale.y = this.cursorHeight
    this._caretScale.z = 1
    this.applyTransform()
  }

  /**
   * Applies the caret's position and scale to its transform, blended toward the morph target.
   */
  private applyTransform(): void {
    if (!this.caretTransform || isNull(this.caretObject)) return

    const t = this.morphProgress
    const target = this.morphTarget
    if (target && t > 0) {
      this._appliedPosition.x = lerp(this._caretPosition.x, target.centerX, t)
      this._appliedPosition.y = lerp(this._caretPosition.y, target.centerY, t)
      this._appliedPosition.z = this._caretPosition.z
      this._appliedScale.x = lerp(this._caretScale.x, target.width, t)
      this._appliedScale.y = lerp(this._caretScale.y, target.height, t)
      this._appliedScale.z = 1
      this.caretTransform.setLocalPosition(this._appliedPosition)
      this.caretTransform.setLocalScale(this._appliedScale)
    } else {
      this.caretTransform.setLocalPosition(this._caretPosition)
      this.caretTransform.setLocalScale(this._caretScale)
    }
  }

  private applyColor(): void {
    const t = this.morphProgress
    if (t > 0) {
      this._appliedColor.x = lerp(this.baseColor.x, this.morphColor.x, t)
      this._appliedColor.y = lerp(this.baseColor.y, this.morphColor.y, t)
      this._appliedColor.z = lerp(this.baseColor.z, this.morphColor.z, t)
      this._appliedColor.w = lerp(this.baseColor.w, this.morphColor.w, t)
      this.caretMaterial.mainPass.baseColor = this._appliedColor
    } else {
      this.caretMaterial.mainPass.baseColor = this.baseColor
    }
  }

  /**
   * Sets the drag state, which changes the caret appearance.
   * @param isDragging - Whether caret is being dragged
   */
  public setDragState(isDragging: boolean): void {
    if (!this.caretObject || !this.caretRMV) return

    if (isDragging) {
      this.caretScaleMultiplier = CARET_SIZE_MULTIPLIER_DRAG
    } else {
      this.caretScaleMultiplier = CARET_SIZE_MULTIPLIER_DEFAULT
    }
    this.updateScale()
  }

  /**
   * Resumes the caret blink animation.
   */
  public resumeBlink(): void {
    this.caretUpdateEvent.enabled = true
  }

  /**
   * Pauses the caret blink animation.
   */
  public pauseBlink(): void {
    this.caretUpdateEvent.enabled = false
  }

  /**
   * Resets the caret blink animation.
   */
  public resetBlink(): void {
    this.caretBlinkTimer = 0
    this.caretBlinkState = true
    if (!isNull(this.caretObject)) {
      this.caretObject.enabled = this.caretVisible
      this.caretRMV.enabled = this.caretVisible
    }
  }

  /**
   * Update callback for caret blinking animation.
   */
  private onCaretUpdate(): void {
    if (!this.caretVisible) {
      if (!isNull(this.caretObject) && this.caretObject.enabled) {
        this.caretObject.enabled = false
        this.caretRMV.enabled = false
      }
      return
    }

    this.caretBlinkTimer += getDeltaTime() * 1000
    this.caretBlinkTimer %= CARET_BLINK_INTERVAL * 2
    const phase = Math.floor(this.caretBlinkTimer / CARET_BLINK_INTERVAL)
    const newBlinkState = phase === 0
    if (this.caretBlinkState !== newBlinkState) {
      this.caretBlinkState = newBlinkState
      if (!isNull(this.caretObject)) {
        this.caretObject.enabled = this.caretBlinkState
        this.caretRMV.enabled = this.caretBlinkState
      }
    }
  }

  /**
   * Destroys the caret renderer and cleans up resources.
   */
  public destroy(): void {
    this.unsubscribes.forEach((unsub) => unsub())
    this.unsubscribes = []
    if (this.caretUpdateEvent) {
      this.caretUpdateEvent.enabled = false
    }
    this.hide()
    if (!isNull(this.caretObject)) {
      this.caretObject.destroy()
    }
  }

  private setColor(color: vec4): void {
    this.baseColor = color
    this.applyColor()
  }
}
