import {UpdateDispatcher} from "./UpdateDispatcher"

export enum LogLevel {
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

const STRIP_ANCHORS = Rect.create(-1, 1, 0.88, 1.0)
/** Dark purple rather than pure black — AR displays are additive; true black emits no light. */
const BACKGROUND_FILL = new vec4(0.18, 0.08, 0.32, 0.55)

const PADDING_HORIZONTAL = 0.5
const PADDING_TOP = 0.25
const PADDING_BOTTOM = 0.5

const TEXT_SIZE = 24
/** Outline stroke width (0..1) — fakes a bolder font without shipping a bold font asset. */
const TEXT_OUTLINE_SIZE = 0.1

const OVERLAY_RENDER_ORDER = 9999

/** How long a scenario result stays on screen before fading. LEAF sessions in different lenses can't signal each other, so the overlay of a finished lens would otherwise cover the next lens's overlay. */
const RESULT_HOLD_MS = 5000
const RESULT_FADE_MS = 500

type Overlay = {root: SceneObject; text: Text; background: Material}

function colorForLevel(level: LogLevel): vec4 {
  switch (level) {
    case LogLevel.DEBUG:
      return new vec4(0.75, 0.85, 1.0, 1.0)
    case LogLevel.INFO:
      return new vec4(0.6, 0.95, 0.6, 1.0)
    case LogLevel.WARN:
      return new vec4(1.0, 0.85, 0.3, 1.0)
    case LogLevel.ERROR:
      return new vec4(1.0, 0.4, 0.4, 1.0)
  }
}

export class Logger {
  private static overlay?: Overlay
  private static textColor: vec4 = colorForLevel(LogLevel.INFO)
  private static cancelFadeOut?: () => void
  private static startTimeMs: number = Date.now()
  static logLevel: LogLevel = LogLevel.INFO

  constructor(private tag: string) {}

  /** Reset the elapsed-time clock used in log prefixes. Call at scenario start. */
  static reset(): void {
    Logger.startTimeMs = Date.now()
  }

  /**
   * Hide the on-screen log after holding it for {@link RESULT_HOLD_MS} and
   * fading it out. The next on-screen log cancels the fade and shows it again.
   */
  static fadeOutOverlay(): void {
    const overlay = Logger.overlay
    if (overlay === undefined) return
    Logger.cancelFadeOut?.()

    const dispatcher = UpdateDispatcher.getInstance()
    let unsubscribeFade: (() => void) | undefined
    /** Event.invoke iterates a snapshot, so an unsubscribed handler can still run once in the frame it was cancelled. */
    let cancelled = false
    const cancelHold = dispatcher.createDelayedEvent(() => {
      const fadeStartMs = Date.now()
      unsubscribeFade = dispatcher.onUpdate.add(() => {
        if (cancelled) return
        const t = Math.min(1, (Date.now() - fadeStartMs) / RESULT_FADE_MS)
        Logger.setOverlayOpacity(overlay, 1 - t)
        if (t < 1) return
        unsubscribeFade?.()
        Logger.cancelFadeOut = undefined
        overlay.root.enabled = false
      })
    }, RESULT_HOLD_MS / 1000)
    Logger.cancelFadeOut = () => {
      cancelled = true
      cancelHold()
      unsubscribeFade?.()
    }
  }

  private static setOverlayOpacity(overlay: Overlay, opacity: number): void {
    const c = Logger.textColor
    const color = new vec4(c.x, c.y, c.z, c.w * opacity)
    overlay.text.textFill.color = color
    overlay.text.outlineSettings.fill.color = color
    overlay.background.mainPass.baseColor = backgroundColor(opacity)
  }

  private static ensureOverlay(): Overlay {
    if (Logger.overlay !== undefined) return Logger.overlay

    const overlayLayer = LayerSet.makeUnique()
    const cameraObject = global.scene.createSceneObject("LeafDebugUICamera")
    cameraObject.layer = overlayLayer

    const camera = cameraObject.createComponent("Component.Camera") as Camera
    camera.type = Camera.Type.Orthographic
    camera.renderTarget = global.scene.liveTarget
    camera.renderOrder = OVERLAY_RENDER_ORDER
    camera.renderLayer = overlayLayer
    if (camera.colorRenderTargets.length > 0) {
      camera.colorRenderTargets[0].clearColorOption = ClearColorOption.None
    }

    const background = createBackgroundStrip(
      cameraObject,
      STRIP_ANCHORS,
      overlayLayer,
    )
    const text = createDebugLine(cameraObject, STRIP_ANCHORS, overlayLayer)
    Logger.overlay = {root: cameraObject, text, background}
    return Logger.overlay
  }

  private log(
    level: LogLevel,
    prefix: string,
    msg: string,
    printToScreen = true,
  ): void {
    if (level < Logger.logLevel) return

    const elapsedSeconds = (Date.now() - Logger.startTimeMs) / 1000
    /** Right-pad to a fixed width so the message body starts at the same column every line. */
    const timeStr = elapsedSeconds.toFixed(3).padStart(7, " ")
    const prefixed = `[${timeStr}s]${msg}`

    if (printToScreen) {
      const overlay = Logger.ensureOverlay()
      Logger.cancelFadeOut?.()
      Logger.cancelFadeOut = undefined
      overlay.root.enabled = true
      overlay.text.text = prefixed
      Logger.textColor = colorForLevel(level)
      Logger.setOverlayOpacity(overlay, 1)
    }

    /** Newlines wrap the in-world overlay; flatten for the console so each event stays grep-able. */
    print(`${prefix} [${this.tag}] ${prefixed.replace(/\n/g, " ")}`)
  }

  /**
   * Prints message, with debug prefix
   * @param msg - message to print
   * @param printToScreen - true if the message should be displayed on screen, false otherwise. True by default.
   */
  debug(msg: string, printToScreen = true): void {
    this.log(LogLevel.DEBUG, "D", msg, printToScreen)
  }

  /**
   * Prints message, with info prefix
   * @param msg - message to print
   * @param printToScreen - true if the message should be displayed on screen, false otherwise. True by default.
   */
  info(msg: string, printToScreen = true): void {
    this.log(LogLevel.INFO, "I", msg, printToScreen)
  }

  /**
   * Prints message, with warn prefix
   * @param msg - message to print
   * @param printToScreen - true if the message should be displayed on screen, false otherwise. True by default.
   */
  warn(msg: string, printToScreen = true): void {
    this.log(LogLevel.WARN, "W", msg, printToScreen)
  }

  /**
   * Prints message, with error prefix
   * @param msg - message to print
   * @param printToScreen - true if the message should be displayed on screen, false otherwise. True by default.
   */
  error(msg: string, printToScreen = true): void {
    this.log(LogLevel.ERROR, "E", msg, printToScreen)
  }
}

/** SolidColor.mat's shader has `ENABLE_BASE_TEX` so it must sample a texture; a 1x1 white pixel makes the baseColor tint the visible color. */
function createWhitePixelTexture(): Texture {
  const texture = ProceduralTextureProvider.createWithFormat(
    1,
    1,
    TextureFormat.RGBA8Unorm,
  )
  const provider = texture.control as ProceduralTextureProvider
  provider.setPixels(0, 0, 1, 1, new Uint8Array([255, 255, 255, 255]))
  return texture
}

/** SolidColor.mat's BlendMode is PremultipliedAlphaAuto; RGB needs pre-multiplied alpha. */
function backgroundColor(opacity: number): vec4 {
  const a = BACKGROUND_FILL.w * opacity
  return new vec4(
    BACKGROUND_FILL.x * a,
    BACKGROUND_FILL.y * a,
    BACKGROUND_FILL.z * a,
    a,
  )
}

function createBackgroundStrip(
  parent: SceneObject,
  anchors: Rect,
  layer: LayerSet,
): Material {
  const obj = global.scene.createSceneObject("LeafDebugLogBackground")
  obj.setParent(parent)
  obj.layer = layer

  const transform = obj.createComponent("ScreenTransform") as ScreenTransform
  transform.anchors = anchors
  /** Inverse-sign offsets extend the background past the strip vertically so the inset text lands inside it. */
  transform.offsets = Rect.create(0, 0, -PADDING_BOTTOM, PADDING_TOP)

  const material = (requireAsset("../debug/SolidColor.mat") as Material).clone()
  material.mainPass.baseColor = backgroundColor(1)
  material.mainPass.baseTex = createWhitePixelTexture()

  const image = obj.createComponent("Component.Image") as Image
  image.clearMaterials()
  image.addMaterial(material)
  image.renderOrder = OVERLAY_RENDER_ORDER
  return material
}

function createDebugLine(
  parent: SceneObject,
  anchors: Rect,
  layer: LayerSet,
): Text {
  const obj = global.scene.createSceneObject("LeafDebugLogLine")
  obj.setParent(parent)
  obj.layer = layer

  const transform = obj.createComponent("ScreenTransform") as ScreenTransform
  transform.anchors = anchors
  transform.offsets = Rect.create(
    PADDING_HORIZONTAL,
    -PADDING_HORIZONTAL,
    PADDING_BOTTOM,
    -PADDING_TOP,
  )

  const text = obj.createComponent("Text") as Text
  text.size = TEXT_SIZE
  text.horizontalOverflow = HorizontalOverflow.Wrap
  text.verticalOverflow = VerticalOverflow.Overflow
  text.horizontalAlignment = HorizontalAlignment.Left
  text.verticalAlignment = VerticalAlignment.Top
  text.renderOrder = OVERLAY_RENDER_ORDER + 1
  text.outlineSettings.enabled = true
  text.outlineSettings.fill.mode = TextFillMode.Solid
  text.outlineSettings.size = TEXT_OUTLINE_SIZE

  return text
}
