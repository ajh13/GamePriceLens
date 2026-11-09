import {UpdateDispatcher} from "Leaf.lspkg/Utils/common/UpdateDispatcher"

/** Full screen width, sits flush below the Logger top strip — Logger's background extends from anchor 0.88 down to ~0.83 in world units. */
const PANEL_ANCHORS = Rect.create(-1.0, 1.0, -1.0, 0.83)
/** Dark fill for legibility against arbitrary scenes; matches Logger style. */
const PANEL_FILL = new vec4(0.04, 0.0, 0.12, 0.78)
/** Inset applied to the text rect on the sides + bottom. */
const PANEL_PADDING = 0.5
const TEXT_SIZE = 22
const TEXT_OUTLINE_SIZE = 0.1
const RENDER_ORDER = 10000
const TEXT_COLOR = new vec4(1.0, 1.0, 1.0, 1.0)
/** Rough fraction of panel height filled by one line at TEXT_SIZE; used to decide when to scroll. */
const LINE_FRACTION = 0.035
/** Wait this long before scrolling so the top is readable. */
const SCROLL_START_DELAY_MS = 1500
/** Scroll speed in anchor-units per second once scrolling kicks in. */
const SCROLL_SPEED_PER_SEC = 0.05

/** Live references to the overlay's text + transform once the scene is built. */
type TextLayout = {text: Text; textTransform: ScreenTransform}

/**
 * Full-height in-world panel that renders the end-of-scenario diagnostic
 * report. Auto-scrolls upward when content overflows. Singleton — call
 * {@link show} to render the latest report; the previous overlay is reused.
 */
export class DiagnosticReportOverlay {
  private static instance?: DiagnosticReportOverlay

  private root?: SceneObject
  private textLayout?: TextLayout
  private startTimeMs: number = 0
  private maxScrollAnchor: number = 0
  private unsubscribeUpdate?: () => void
  private cancelHide?: () => void

  private constructor() {}

  /**
   * Render `report` in the in-world panel. Creates the overlay scene
   * objects on first call. If `durationMs` is provided the overlay hides
   * after that many milliseconds; `0` means it never appears, `undefined`
   * leaves it shown until {@link hide} is called.
   */
  static show(report: string, durationMs?: number): void {
    if (!DiagnosticReportOverlay.instance) {
      DiagnosticReportOverlay.instance = new DiagnosticReportOverlay()
    }
    DiagnosticReportOverlay.instance.render(report, durationMs)
  }

  /** Destroy the overlay. Idempotent. */
  static hide(): void {
    DiagnosticReportOverlay.instance?.destroy()
  }

  private render(report: string, durationMs?: number): void {
    const {text, textTransform} = this.ensureScene()
    text.text = report
    this.startTimeMs = Date.now()
    this.cancelHide?.()
    this.cancelHide = undefined

    /** Estimate vertical overflow in anchor units (panel spans 2.0 vertically). */
    const lineCount = report.split("\n").length
    const textHeightAnchor = lineCount * LINE_FRACTION * 2.0
    this.maxScrollAnchor = Math.max(0, textHeightAnchor - 2.0)

    this.applyScrollOffsets(textTransform, 0)

    this.unsubscribeUpdate?.()
    this.unsubscribeUpdate = undefined
    if (this.maxScrollAnchor > 0) {
      this.unsubscribeUpdate = UpdateDispatcher.getInstance().onUpdate.add(
        () => this.updateScroll(textTransform),
      )
    }

    if (durationMs === undefined) return
    if (durationMs <= 0) {
      this.destroy()
      return
    }
    /* The hide timer must survive Scenario cleanup; LEAF's setTimeout is scope-owned. */
    this.cancelHide = UpdateDispatcher.getInstance().createDelayedEvent(
      () => this.destroy(), durationMs / 1000,
    )
  }

  private applyScrollOffsets(
    textTransform: ScreenTransform,
    scrollAnchor: number,
  ): void {
    /** Shift both top and bottom anchor offsets up by `scrollAnchor` so the whole text moves up while the panel stays fixed. Top padding stays at 0 so the first line touches the banner edge. */
    textTransform.offsets = Rect.create(
      PANEL_PADDING,
      -PANEL_PADDING,
      PANEL_PADDING + scrollAnchor,
      scrollAnchor,
    )
  }

  /**
   * Advance the scroll offset based on elapsed time. Stops at the bottom of
   * the report so the last line stays on-screen rather than looping back.
   */
  private updateScroll(textTransform: ScreenTransform): void {
    const elapsedMs = Date.now() - this.startTimeMs - SCROLL_START_DELAY_MS
    if (elapsedMs < 0) return
    const scrollAnchor = Math.min(
      this.maxScrollAnchor,
      (elapsedMs / 1000) * SCROLL_SPEED_PER_SEC,
    )
    this.applyScrollOffsets(textTransform, scrollAnchor)
    if (scrollAnchor >= this.maxScrollAnchor) {
      this.unsubscribeUpdate?.()
      this.unsubscribeUpdate = undefined
    }
  }

  private ensureScene(): TextLayout {
    if (this.root && !isNull(this.root) && this.textLayout) return this.textLayout

    const overlayLayer = LayerSet.makeUnique()
    const cameraObject = global.scene.createSceneObject(
      "LeafDiagnosticReportCamera",
    )
    cameraObject.layer = overlayLayer

    const camera = cameraObject.createComponent("Component.Camera") as Camera
    camera.type = Camera.Type.Orthographic
    camera.renderTarget = global.scene.liveTarget
    camera.renderOrder = RENDER_ORDER
    camera.renderLayer = overlayLayer
    if (camera.colorRenderTargets.length > 0) {
      camera.colorRenderTargets[0].clearColorOption = ClearColorOption.None
    }

    this.createBackground(cameraObject, overlayLayer)
    const textLayout = this.createTextElement(cameraObject, overlayLayer)
    this.root = cameraObject
    this.textLayout = textLayout
    return textLayout
  }

  private createBackground(parent: SceneObject, layer: LayerSet): void {
    const backgroundObject = global.scene.createSceneObject(
      "LeafDiagnosticReportBackground",
    )
    backgroundObject.setParent(parent)
    backgroundObject.layer = layer

    const transform = backgroundObject.createComponent(
      "ScreenTransform",
    ) as ScreenTransform
    transform.anchors = PANEL_ANCHORS

    const material = (
      requireAsset("../Utils/debug/SolidColor.mat") as Material
    ).clone()
    /** SolidColor.mat's BlendMode is PremultipliedAlphaAuto; RGB needs pre-multiplied alpha. */
    const alpha = PANEL_FILL.w
    material.mainPass.baseColor = new vec4(
      PANEL_FILL.x * alpha,
      PANEL_FILL.y * alpha,
      PANEL_FILL.z * alpha,
      alpha,
    )
    material.mainPass.baseTex = whitePixelTexture()

    const image = backgroundObject.createComponent("Component.Image") as Image
    image.clearMaterials()
    image.addMaterial(material)
    image.renderOrder = RENDER_ORDER
  }

  private createTextElement(parent: SceneObject, layer: LayerSet): TextLayout {
    const textObject = global.scene.createSceneObject("LeafDiagnosticReportText")
    textObject.setParent(parent)
    textObject.layer = layer

    const textTransform = textObject.createComponent(
      "ScreenTransform",
    ) as ScreenTransform
    textTransform.anchors = PANEL_ANCHORS
    textTransform.offsets = Rect.create(
      PANEL_PADDING,
      -PANEL_PADDING,
      PANEL_PADDING,
      0,
    )

    const text = textObject.createComponent("Text") as Text
    text.size = TEXT_SIZE
    text.horizontalOverflow = HorizontalOverflow.Wrap
    text.verticalOverflow = VerticalOverflow.Overflow
    text.horizontalAlignment = HorizontalAlignment.Left
    text.verticalAlignment = VerticalAlignment.Top
    text.renderOrder = RENDER_ORDER + 1
    text.outlineSettings.enabled = true
    text.outlineSettings.fill.mode = TextFillMode.Solid
    text.outlineSettings.size = TEXT_OUTLINE_SIZE
    text.textFill.color = TEXT_COLOR
    text.outlineSettings.fill.color = TEXT_COLOR

    return {text, textTransform}
  }

  private destroy(): void {
    this.cancelHide?.()
    this.cancelHide = undefined
    this.unsubscribeUpdate?.()
    this.unsubscribeUpdate = undefined
    if (this.root && !isNull(this.root)) this.root.destroy()
    this.root = undefined
    this.textLayout = undefined
  }
}

/** A 1×1 white texture; lets the SolidColor shader render as a pure tint. */
function whitePixelTexture(): Texture {
  const width = 1
  const height = 1
  const white = new Uint8Array([255, 255, 255, 255])
  const texture = ProceduralTextureProvider.createWithFormat(
    width,
    height,
    TextureFormat.RGBA8Unorm,
  )
  const provider = texture.control as ProceduralTextureProvider
  provider.setPixels(0, 0, width, height, white)
  return texture
}
