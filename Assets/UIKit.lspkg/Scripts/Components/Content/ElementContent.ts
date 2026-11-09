import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {ThemeService} from "../../Themes/ThemeService"
import {IMAGE_MATERIAL_ASSET} from "../../Utility/Assets"
import {findGoverningCanvas} from "../../Utility/CanvasController"
import {drawWorldBox} from "../../Utility/DebugDraw"
import {isEqual, localizeOr, setTextRect} from "../../Utility/UIKitUtilities"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
// Side-effect import — register UIKit Layout2D handlers. ElementContent
// doesn't extend Element, so it needs its own bootstrap reference.
import "../../UIKitBootstrap"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"
import {FlexAlign, FlexAlignSelf, FlexDirection, FlexJustify} from "../Layout2D/Flex/FlexTypes"
import {LayoutItem2D, LayoutOwner, PresentationRequest} from "../Layout2D/LayoutItem2D"
import {FIT_CONTENT_RETRY_FRAMES} from "../Layout2D/LayoutTypes"
import {
  canAttemptThisFrame,
  getCachedNaturalSize,
  getFrameToken,
  measureNaturalSize,
  refreshNaturalSize
} from "../Layout2D/TextMeasurement"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {elementContentSizes} from "../Layout2D/UIKitItemHandlers"
import {TextInputField} from "../TextInputField/TextInputField"
import {Ranking, TextStylePresets} from "../TextStylePresets/TextStylePresets"
import {ContentColorState, ContentStyleKey, resolveContentColors} from "./ContentStyle"

const log = new NativeLogger("ElementContent")

type unsubscribe = () => void

// ─── Localization ─────────────────────────────────────────────────────
// A Text component whose value starts with "@" auto-resolves in-engine, and
// — measured, not assumed — that
// resolution happens BEFORE Text.getBoundingBox(), so every measurement path
// here (autoResize, TextSizing.Fit, verifyFitMeasurement, the underline
// geometry) sizes against the translated glyphs. Pass-through is therefore
// safe on a HIT and needs nothing special.
//
// A MISS is the problem. localize() fails soft by echoing the key back, and a
// key is far longer than the text it stands for: a missed key measured 2.57x
// the width of its English value. Under autoResize that grows the host element to
// fit the key; under Fit it truncates mid-key.
//
// The most likely cause of a miss is not a typo — it is a MISSING BUNDLE
// ANCHOR. localize() creates no build-time asset reference, so a lens that
// never names its table in a literal-path requireAsset() ships without it and
// EVERY key misses at once, turning a whole UI into oversized raw keys. See
// setLocalizedText.
const LOCALIZATION_KEY_PREFIX = "@"

export type ElementContentPadding = {
  top: number
  right: number
  bottom: number
  left: number
}

// ─── Content Enums ────────────────────────────────────────────────────

export enum IconLayout {
  Left = "left",
  Right = "right",
  Top = "top",
  Bottom = "bottom"
}

export enum TextAlignment {
  Left = "left",
  Center = "center",
  Right = "right"
}

export enum TextSizing {
  Hug = "hug",
  Fit = "fit"
}

// ─── Layout Mappings ──────────────────────────────────────────────────

const DIRECTION_MAP: Record<string, FlexDirection> = {
  [IconLayout.Right]: FlexDirection.RowReverse,
  [IconLayout.Top]: FlexDirection.Column,
  [IconLayout.Bottom]: FlexDirection.ColumnReverse
}

const JUSTIFY_MAP: Record<string, FlexJustify> = {
  [TextAlignment.Left]: FlexJustify.Start,
  [TextAlignment.Right]: FlexJustify.End
}

const TEXT_HALIGN_MAP: Record<string, number> = {
  [TextAlignment.Left]: HorizontalAlignment.Left,
  [TextAlignment.Right]: HorizontalAlignment.Right
}

// Fit-mode text sizing: padding added to the pinned width so the allocated
// rect is never a rounding error narrower than the measured glyphs (an
// exact-width rect with Wrap can wrap the last word, and verticalOverflow
// Truncate then cuts it), and the drift threshold beyond which a post-layout
// re-measure re-pins the width (covers zero first-frame measures and async
// font/preset metric changes).
const FIT_WIDTH_EPSILON = 0.02
const FIT_REMEASURE_TOLERANCE = 0.005
// Font / TextStylePresets metrics can finish resolving after construction and
// after a style change, under the same content/size key the caches use, so a
// positive first measurement can be stale. There is no readiness notification
// to hook, so the retry event re-measures the natural size this many times,
// one frame apart, after a build or style change, and re-lays out only when
// the width drifted past FIT_REMEASURE_TOLERANCE. Not per layout completion:
// that would recreate the measurement churn this module exists to remove.
const STYLE_REVALIDATION_FRAMES = 2

// Text.getBoundingBox().height returns the font line box (includes ascent +
// descent + leading), so half of it sits well below the visible glyph bottom —
// especially for text with no descenders. Anchor the underline at this
// fraction of the measured height below center to sit just under the baseline.
const UNDERLINE_BASELINE_FRACTION = 0.32

// ─── Typed Interface for Sibling Discovery ────────────────────────────

/**
 * What a sibling must implement to host ElementContent in companion mode.
 *
 * Required: the lifecycle core (`size`, `onSizeChanged`, `onInitialized`,
 * `registerManagedChild`) — enough to size and parent the content. Optional:
 * the theme/state surface, so a minimal custom widget can host text + icons
 * without the full UIKit state machine.
 */
interface ContentHost {
  // ─── Required core ──────────────────────────────────────
  size: vec3
  onSizeChanged: {add: (cb: (s: vec3) => void) => unsubscribe}
  onInitialized: {add: (cb: () => void) => unsubscribe}
  registerManagedChild(sceneObject: SceneObject): void

  // ─── Optional theme + state surface ─────────────────────
  onStateChanged?: {add: (cb: (s: string) => void) => unsubscribe}
  onContentZOffsetChanged?: {add: (cb: (z: number) => void) => unsubscribe}
  contentZOffset?: number
  contentRenderOrderOffset?: number
  typeString?: string
  style?: string
  normalizedThemeOverride?: string
}

/**
 * Type guard for ContentHost. Only the required core members are checked;
 * optional theme/state fields are not required to host ElementContent.
 */
function isContentHost(comp: unknown): comp is ContentHost {
  if (!comp || typeof comp !== "object") return false
  const candidate = comp as Record<string, unknown>
  return (
    "size" in candidate &&
    "onSizeChanged" in candidate &&
    "onInitialized" in candidate &&
    "registerManagedChild" in candidate
  )
}

/**
 * Companion component that adds text and icon content to any VisualElement.
 *
 * Attach to the same SceneObject as a Button, Checkbox, Slider, Frame, or any
 * VisualElement. Uses a real FlexLayout component for positioning and resolves
 * content colors from the active theme.
 *
 * Can also operate in standalone mode (without a sibling VisualElement) when
 * sizeOverride is set.
 *
 * ## Localized labels
 *
 * Use {@link setLocalizedText} rather than assigning an `@key` to
 * {@link text}. Both display the translation when the key resolves — the engine
 * resolves `@`-prefixed Text values itself, and — measured — it does so before
 * `getBoundingBox()`, so autoResize / Fit / underline measurements are honest.
 * They differ on a miss: the key path leaves the raw key on screen sized to its
 * own length, while `setLocalizedText` substitutes your fallback.
 *
 * The lens using this owns the bundle anchor. `localize()` creates no
 * build-time asset reference, so without a literal-path
 * `requireAsset(".../strings")` somewhere in the lens, the string table never
 * ships and every key misses at once.
 */
@component
export class ElementContent extends BaseScriptComponent {
  /**
   * Type brand consumed by the Layout2D `StandaloneContentHandler` finder.
   * See `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.ElementContent

  // ─── Content (always visible) ────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Content</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Primary text, icons, and layout direction</span>')
  @input
  @label("Text")
  @hint("Text label to display.")
  private _text: string = ""
  private _wrapText: boolean = true

  @input
  @label("Use Leading Icon")
  @hint("Enable to attach an icon before the text.")
  private _useLeadingIcon: boolean = false

  @input
  @showIf("_useLeadingIcon", true)
  @allowUndefined
  @label("Leading Icon")
  @hint("Icon displayed before the text.")
  private _leadingIcon: Texture | null = null

  @input
  @label("Use Trailing Icon")
  @hint("Enable to attach an icon after the text.")
  private _useTrailingIcon: boolean = false

  @input
  @showIf("_useTrailingIcon", true)
  @allowUndefined
  @label("Trailing Icon")
  @hint("Icon displayed after the text.")
  private _trailingIcon: Texture | null = null

  @input
  @showIf("_useLeadingIcon", true)
  @label("Icon Layout")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Left", "left"),
      new ComboBoxItem("Right", "right"),
      new ComboBoxItem("Top", "top"),
      new ComboBoxItem("Bottom", "bottom")
    ])
  )
  @hint("Controls layout direction relative to text.")
  private _iconLayout: string = IconLayout.Left

  @input("string")
  @label("Text Alignment")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Left", "left"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Right", "right")
    ])
  )
  @hint("Horizontal alignment of text within the container.")
  private _textAlignment: TextAlignment = TextAlignment.Center

  @input("string", "hug")
  @label("Text Sizing")
  @widget(new ComboBoxWidget([new ComboBoxItem("Hug", "hug"), new ComboBoxItem("Fit", "fit")]))
  @hint("Hug: text expands to fill remaining space. Fit: text uses its natural width.")
  private _textSizing: TextSizing = TextSizing.Hug

  // ─── Styling ─────────────────────────────────────────────────────────

  @ui.separator
  @ui.group_start("Styling")
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Font, text size, and icon dimensions</span>')
  @input
  @allowUndefined
  @label("Font")
  @hint("Custom font. Leave empty for system default.")
  private _font: Font

  @input
  @label("Text Size")
  @hint("Font size in Lens Studio units.")
  private _textSize: number = 48

  @input
  @showIf("_useLeadingIcon", true)
  @label("Leading Icon Size")
  @hint("Leading icon width and height in cm.")
  private _leadingIconSize: number = 1.25

  @input
  @showIf("_useTrailingIcon", true)
  @label("Trailing Icon Size")
  @hint("Trailing icon width and height in cm.")
  private _trailingIconSize: number = 1.25

  @input
  @label("Underline")
  @hint("Draw a bar under the text that tracks the text width and recolors with the text per state (e.g. Link).")
  private _underline: boolean = false

  @input
  @showIf("_underline", true)
  @label("Underline Thickness")
  @hint("Underline bar thickness in cm.")
  private _underlineThickness: number = 0.12

  @input
  @showIf("_underline", true)
  @label("Underline Offset")
  @hint("Gap in cm between the bottom of the glyphs and the underline bar.")
  private _underlineOffset: number = 0.04

  @ui.group_end

  // ─── Spacing ────────────────────────────────────────────────────────
  @ui.separator
  @ui.group_start("Spacing")
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Gaps between items and padding within the container</span>')
  @input
  @label("Custom Spacing")
  @hint("Enable to override default spacing and padding values.")
  private _customSpacing: boolean = false

  @input
  @showIf("_customSpacing", true)
  @label("Item Spacing")
  @hint("Gap between items in cm.")
  private _spacing: number = 0.5

  @input
  @showIf("_customSpacing", true)
  @label("Padding Top")
  private _paddingTop: number = 0.5

  @input
  @showIf("_customSpacing", true)
  @label("Padding Right")
  private _paddingRight: number = 0.8

  @input
  @showIf("_customSpacing", true)
  @label("Padding Bottom")
  private _paddingBottom: number = 0.5

  @input
  @showIf("_customSpacing", true)
  @label("Padding Left")
  private _paddingLeft: number = 0.8

  @ui.group_end

  // ─── Sizing ─────────────────────────────────────────────────────────
  @ui.separator
  @ui.group_start("Sizing")
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Standalone mode, auto-resize, and size constraints</span>')
  @input
  @label("Auto-Resize Parent")
  @hint("When true, the parent element auto-sizes to fit content.")
  private _autoResizeParent: boolean = false

  @input
  @showIf("_autoResizeParent", true)
  @label("Min Width")
  @hint("Minimum content width in cm (0 = no minimum).")
  private _minWidth: number = 0

  @input
  @showIf("_autoResizeParent", true)
  @label("Min Height")
  @hint("Minimum content height in cm (0 = no minimum).")
  private _minHeight: number = 0

  @input
  @label("Size Override")
  @hint("Width and height in cm. Used when no sibling VisualElement provides a size.")
  private _sizeOverride: vec2 = new vec2(10, 3)

  @ui.group_end

  // ─── Rendering (programmatic only) ──────────────────────────────────
  // 0.05 cm minimum: with renderOrder flat, this Z gap is what layers content
  // above its background; smaller gaps risk z-fighting at panel distance.
  private _zOffset: number = 0.05
  // Natural (unwrapped) text width pinned by the current Fit measurement, or
  // null outside Fit / before a usable measurement. Drives the conditional
  // overflow in fixTextAfterLayout and the post-layout re-measure check.
  private fitNaturalWidth: number | null = null
  // Natural text width the autoResize pass last sized the container from, or
  // null outside autoResize / before a usable measurement. Same role as
  // fitNaturalWidth, for the Hug + autoResize path. See fixTextAfterLayout.
  private autoResizeNaturalWidth: number | null = null

  // ─── Colors ─────────────────────────────────────────────────────────

  @ui.separator
  @ui.group_start("Colors")
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Theme integration, manual per-state colors, and per-instance overrides</span>'
  )
  @input
  @label("Use Theme Colors")
  @hint("When true, content colors are resolved from the active theme.")
  private _useThemeColors: boolean = true

  // Theme resolution overrides — accessible programmatically
  private _themeOverride: string = ""
  private _visualElementType: string = ""
  private _styleName: string = ""

  @input
  @showIf("_useThemeColors", false)
  @label("Default Text Color")
  private _defaultTextColor: vec4 = new vec4(1, 1, 1, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Hovered Text Color")
  private _hoveredTextColor: vec4 = new vec4(1, 1, 1, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Triggered Text Color")
  private _triggeredTextColor: vec4 = new vec4(0.08, 0.08, 0.08, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Inactive Text Color")
  private _inactiveTextColor: vec4 = new vec4(1, 1, 1, 0.4)

  @input
  @showIf("_useThemeColors", false)
  @label("Default Icon Tint")
  private _defaultIconTint: vec4 = new vec4(1, 1, 1, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Hovered Icon Tint")
  private _hoveredIconTint: vec4 = new vec4(1, 1, 1, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Triggered Icon Tint")
  private _triggeredIconTint: vec4 = new vec4(0.08, 0.08, 0.08, 1)

  @input
  @showIf("_useThemeColors", false)
  @label("Inactive Icon Tint")
  private _inactiveIconTint: vec4 = new vec4(1, 1, 1, 0.4)

  @input
  @label("Use Text Color Override")
  @hint("When enabled, uses the color below instead of theme-resolved text color.")
  private _useTextColorOverride: boolean = false

  @input
  @showIf("_useTextColorOverride", true)
  @label("Text Color Override")
  @hint("Per-instance text color. State opacity still applies.")
  private _textColorOverride: vec4 = new vec4(1, 1, 1, 1)

  @ui.group_end

  // ─── Debug ──────────────────────────────────────────────────────────
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Visual debugging tools for content inspection</span>')
  @input
  @label("Debug Visualization")
  @hint("Enable debug visualization (container and item bounds).")
  private _debug: boolean = false

  // ─── Internal State ─────────────────────────────────────────────────
  private siblingElement: ContentHost | null = null
  private standaloneMode: boolean = false
  private contentContainer: SceneObject | null = null
  private flexLayout: FlexLayout | null = null

  private textSceneObject: SceneObject | null = null
  private _textComponent: Text | null = null
  private textFlexItem: FlexItem | null = null

  // Underline bar (optional). Parented under the text SceneObject so it tracks
  // the text's position; sized/positioned in fixTextAfterLayout and recolored
  // with the text in applyResolvedColors.
  private underlineSceneObject: SceneObject | null = null
  private underlineVisual: RoundedRectangleVisual | null = null
  private textStylePresets: TextStylePresets | null = null
  private ownsTextStylePresets: boolean = false
  private _ranking: Ranking | null = null
  // A ranking writes font weight as well as size, so the pre-ranking weight has
  // to be remembered to make clearing the ranking a true restore.
  private weightBeforeRanking: number | null = null

  private leadingIconSceneObject: SceneObject | null = null
  private leadingIconImage: Image | null = null
  private leadingIconFlexItem: FlexItem | null = null

  private trailingIconSceneObject: SceneObject | null = null
  private trailingIconImage: Image | null = null
  private trailingIconFlexItem: FlexItem | null = null

  private unsubscribes: unsubscribe[] = []
  private _skipNextSizeUpdate: boolean = false
  private _initialized: boolean = false
  // Persistent rendering-off state. `setRenderingEnabled(false)` disables the existing
  // renderables; this flag re-applies that to any text/icon created afterwards (buildContent
  // and the icon/text setters create renderables enabled), so content built while released
  // stays hidden instead of resurrecting.
  private _renderingEnabled: boolean = true
  private _opacityFactor: number = 1
  private _explicitRenderOrder: number | null = null
  // Set by setLocalizedText; also suppresses the raw-key warning, since that
  // path assigns an already-resolved string through the text setter.
  private _localizationKey: string | null = null
  private _warnedRawLocalizationKey: boolean = false
  // True only while setLocalizedText is driving the text setter, so that setter
  // can tell a localized assignment from a plain one. See setLocalizedText.
  private _applyingLocalizedText: boolean = false
  // Tri-state cache for the content render-order fallback: null = not yet
  // resolved. See getContentRenderOrderOffset / invalidateCanvasBinding.
  private _governedByCanvas: boolean | null = null
  private _hostRenderOrderOffset: number = 0
  private _lastStateName: string | null = null
  // Cached resolved colors. ContentColorState references theme-owned
  // literals — read-only, never mutate. Re-resolved on state change;
  // opacity ticks re-apply with the new multiplier without re-running
  // the theme lookup pipeline. Future runtime mutators (theme switch,
  // style override toggle) should call markColorsDirty() to flush.
  private _cachedColors: ContentColorState | null = null
  private _colorsDirty: boolean = true
  private debugUpdateEvent!: SceneEvent

  // ─── Events ─────────────────────────────────────────────────────────

  private readonly onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()
  public readonly onInitialized: PublicApi<void> = this.onInitializedEvent.publicApi()

  /**
   * Gets the underlying Lens `Text` component for the label, or null before the
   * content is built (see {@link onInitialized}) or when there is no text. The
   * instance is recreated only when the text toggles to/from empty, so callers
   * holding a reference should refresh it across such transitions.
   */
  public get textComponent(): Text | null {
    return this._textComponent
  }

  /**
   * Gets the leading icon's SceneObject, or null before the content is built or when
   * there is no leading icon. The instance is recreated when the icon toggles to/from
   * null, so callers holding a reference should refresh it across such transitions.
   */
  public get leadingIconObject(): SceneObject | null {
    return this.leadingIconSceneObject
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  public onAwake(): void {
    // Debug visualization event — starts disabled
    this.debugUpdateEvent = this.createEvent("UpdateEvent")
    this.debugUpdateEvent.enabled = this._debug
    this.debugUpdateEvent.bind(() => {
      this.renderDebug()
    })

    // Continuation for pending text measurement; starts disabled and is only
    // armed while natural-size work is outstanding or a revalidation is owed.
    this.retryEvent = this.createEvent("LateUpdateEvent")
    this.retryEvent.enabled = false
    this.retryEvent.bind(() => this.onRetryFrame())

    this.createEvent("OnStartEvent").bind(() => this.init())
    // Re-resolve the governing Canvas on enable: reparenting between a
    // Canvas-governed hierarchy and a bare one flips whether the content
    // render-order fallback applies. Matches the invalidateCanvasBinding
    // pattern on Calendar / NumberPicker / BaseTextInputComponent.
    // Re-enable also re-arms pending measurement work that a disable paused.
    this.createEvent("OnEnableEvent").bind(() => {
      this.invalidateCanvasBinding()
      if (this._initialized && this.hasContinuationWork()) this.scheduleRetry()
    })
    // Lifecycle methods other than onAwake are not auto-invoked — onDestroy
    // must be wired explicitly, or teardown (unsubscribes, pending flush
    // cancellation, standalone container cleanup) never runs.
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private init(): void {
    this.discoverSiblingElement()

    if (this.siblingElement) {
      this.unsubscribes.push(this.siblingElement.onInitialized.add(() => this.buildContent()))
    } else if (this.standaloneMode) {
      this.buildContent()
    }
  }

  private onDestroy(): void {
    // Flip _initialized first so any in-flight applyResolvedColors / opacity
    // setter calls early-return instead of touching natives being torn down.
    this._initialized = false
    if (this.siblingElement && elementContentSizes.delete(this.siblingElement)) {
      this.findLayoutItem()?.invalidateMeasure()
    }
    // Cancel any pending deferred layout flush. The global setTimeout is
    // engine-level and would otherwise fire after teardown and run
    // flushLayout() against destroyed natives.
    if (this._flushCancelToken !== null) {
      clearTimeout(this._flushCancelToken)
      this._flushCancelToken = null
      this._layoutDirty = false
    }
    if (this.retryEvent) {
      this.retryEvent.enabled = false
      this.retryEvent = null
    }
    this._stagedText = null
    this._stagedTextSize = null
    this.unsubscribes.forEach((u) => u())
    this.unsubscribes = []
    this.releaseExternalTextStylePreset()
    // The underline visual owns off-graph resources (cloned material, cancel
    // sets) that outlive the SceneObject teardown — release them explicitly.
    this.destroyUnderline()
    // Content container is owned by the sibling's managedSceneObjects (via
    // registerManagedChild) in companion mode. In standalone mode, we own it.
    if (this.standaloneMode && this.contentContainer && !isNull(this.contentContainer)) {
      this.contentContainer.destroy()
    }
  }

  // ─── Discovery ──────────────────────────────────────────────────────

  private discoverSiblingElement(): void {
    const others = this.sceneObject.getComponents(ElementContent.getTypeName()) as ElementContent[]
    for (const other of others) {
      if (other !== this && other._initialized === true) {
        log.w("ElementContent: Another instance already active on " + this.sceneObject.name)
        return
      }
    }

    const textInputField = this.sceneObject.getComponent(TextInputField.getTypeName())
    if (textInputField) {
      log.w("ElementContent: TextInputField detected on " + this.sceneObject.name + " — disabling.")
      return
    }

    for (const component of this.sceneObject.getComponents("ScriptComponent")) {
      if (component === this) continue
      if (isContentHost(component)) {
        this.siblingElement = component
        return
      }
    }

    this.standaloneMode = true
    if (this._sizeOverride.x <= 0 || this._sizeOverride.y <= 0) {
      log.w("ElementContent: No VisualElement found and sizeOverride is zero on " + this.sceneObject.name)
    }
  }

  // ─── Content Building ───────────────────────────────────────────────

  private buildContent(): void {
    if (this._initialized || this.contentContainer) return

    // Catch an Inspector-authored localization key. Lens Studio deserializes the
    // Text @input straight into _text without going through the setter, so the
    // setter's own check never sees it — and authoring in the Inspector is the
    // common route for exactly this. Warn-once is shared with the setter, so a
    // programmatic set that already warned pre-init won't warn twice.
    this.warnOnRawLocalizationKey(this._text)

    // Create content container with FlexLayout
    const container = global.scene.createSceneObject(this.sceneObject.name + " Content")
    container.layer = this.sceneObject.layer
    container.setParent(this.sceneObject)
    this.contentContainer = container
    this.applyContainerLocalZ()

    const flex = container.createComponent(FlexLayout.getTypeName()) as FlexLayout
    flex.autoDiscoverItemsOnStart = false
    this.flexLayout = flex

    this.applyLayoutConfig()

    // Create content children and register with layout
    this.createContentItems()
    const items: FlexItem[] = []
    if (this.leadingIconFlexItem) items.push(this.leadingIconFlexItem)
    if (this.textFlexItem) items.push(this.textFlexItem)
    if (this.trailingIconFlexItem) items.push(this.trailingIconFlexItem)
    if (items.length > 0) flex.addItems(items)

    // Set initial size
    if (this.siblingElement) {
      this.siblingElement.registerManagedChild(container)
      const size = this.siblingElement.size
      if (size) {
        flex.width = Math.max(size.x, 0)
        flex.height = Math.max(size.y, 0)
      }
    } else if (this.standaloneMode && this._sizeOverride) {
      flex.width = Math.max(this._sizeOverride.x, 0)
      flex.height = Math.max(this._sizeOverride.y, 0)
    }

    if (this._autoResizeParent && this.siblingElement) {
      this.updateAutoSize()
    }

    this.applyCompactTextSizing()

    // Force initial layout, then fix text sizing
    flex.forceLayout()
    this.fixTextAfterLayout()

    // Subscribe AFTER layout so the ReplayEvent color set happens on properly sized text
    if (this.siblingElement) {
      this.subscribeToSiblingEvents()
    }

    // Fix text on future passes. Outstanding measurement (our natural size or
    // the layout's own fit-content probes) arms the LateUpdate continuation —
    // never a synchronous re-layout from inside a layout callback, and never a
    // markLayoutDirty(), which would start a new generation every pass.
    this.unsubscribes.push(
      flex.onLayoutComplete.add(() => {
        this.fixTextAfterLayout()
        this.verifyFitMeasurement()
        if (this.hasContinuationWork()) this.scheduleRetry()
      })
    )
    // Font / preset metrics may land after this build: re-check the natural
    // size a bounded number of frames from now.
    this.beginRevalidation()

    // Standalone mode never gets a state callback — apply default colors now
    if (this.standaloneMode) {
      this.onElementStateChanged("default")
    }

    this._initialized = true
    this.applyResolvedColors()
    this.onInitializedEvent.invoke()
    this.announcePresentationIfReady()
    if (this.hasContinuationWork()) this.scheduleRetry()
  }

  private createContentItems(): void {
    const showText = this._text !== ""

    if (this._useLeadingIcon && this._leadingIcon) this.createLeadingIcon()
    if (showText) this.createTextItem()
    if (this._useTrailingIcon && this._trailingIcon) this.createTrailingIcon()
  }

  private createLeadingIcon(): void {
    const result = this.createIconSceneObject(this._leadingIcon, this._leadingIconSize, "LeadingIcon")
    this.leadingIconSceneObject = result.sceneObject
    this.leadingIconImage = result.image
    this.leadingIconFlexItem = result.flexItem
    result.flexItem.order = 0
  }

  private createTrailingIcon(): void {
    const result = this.createIconSceneObject(this._trailingIcon, this._trailingIconSize, "TrailingIcon")
    this.trailingIconSceneObject = result.sceneObject
    this.trailingIconImage = result.image
    this.trailingIconFlexItem = result.flexItem
    result.flexItem.order = 2
  }

  private createIconSceneObject(
    texture: Texture,
    size: number,
    name: string
  ): {sceneObject: SceneObject; image: Image; flexItem: FlexItem} {
    const iconObject = global.scene.createSceneObject(name)
    iconObject.layer = this.contentContainer!.layer
    iconObject.setParent(this.contentContainer!)

    const image = iconObject.createComponent("Component.Image") as Image
    image.mainMaterial = IMAGE_MATERIAL_ASSET.clone()
    image.mainPass.baseTex = texture
    image.stretchMode = StretchMode.Stretch
    image.verticalAlignment = VerticalAlignment.Center
    image.horizontalAlignment = HorizontalAlignment.Center
    image.renderOrder = this.getBaseRenderOrder()
    // Inherit any persistent rendering-off state so icons built while released stay hidden.
    image.enabled = this._renderingEnabled

    iconObject.getTransform().setLocalScale(new vec3(size, size, 1))

    const flexItem = iconObject.createComponent(FlexItem.getTypeName()) as FlexItem
    flexItem.flexGrow = 0
    flexItem.flexShrink = 0
    flexItem.overrideWidth = size
    flexItem.overrideHeight = size

    return {sceneObject: iconObject, image, flexItem}
  }

  private createTextItem(): void {
    this._textRevealPending = this.isContentSized()
    const textObject = global.scene.createSceneObject("Text")
    textObject.layer = this.contentContainer!.layer
    textObject.setParent(this.contentContainer!)

    const textComponent = textObject.createComponent("Component.Text") as Text
    textComponent.size = this._textSize
    textComponent.text = this._text
    textComponent.verticalAlignment = VerticalAlignment.Center
    textComponent.horizontalAlignment = TEXT_HALIGN_MAP[this._textAlignment] ?? HorizontalAlignment.Center
    textComponent.verticalOverflow = VerticalOverflow.Truncate
    textComponent.renderOrder = this.getBaseRenderOrder()
    textComponent.textFill.color = new vec4(0.85, 0.85, 0.85, 1)
    textComponent.depthTest = true

    if (this._font) textComponent.font = this._font

    textComponent.horizontalOverflow = this._wrapText ? HorizontalOverflow.Wrap : HorizontalOverflow.Overflow
    // Placeholder rect (replaced once FlexLayout allocates space). Routed through
    // the layoutRect-aware helper instead of writing the deprecated worldSpaceRect.
    setTextRect(textComponent, textObject, 1, 1)

    // Text fills remaining space
    const flexItem = textObject.createComponent(FlexItem.getTypeName()) as FlexItem
    flexItem.flexGrow = 1
    flexItem.flexShrink = 1
    flexItem.flexBasis = 0
    flexItem.order = 1
    flexItem.alignSelf = FlexAlignSelf.Stretch

    this.textSceneObject = textObject
    this._textComponent = textComponent
    this.textFlexItem = flexItem
    // Inherit any persistent rendering-off state so text built while released stays hidden.
    textComponent.enabled = this._renderingEnabled && !this._textRevealPending

    const siblingPreset = this.sceneObject.getComponent(TextStylePresets.getTypeName()) as TextStylePresets | null
    if (siblingPreset && !isNull(siblingPreset)) {
      this.textStylePresets = siblingPreset
      this.ownsTextStylePresets = false
      this._ranking = siblingPreset.ranking
      siblingPreset.bindTextComponent(textComponent)
    } else if (this._ranking !== null) {
      this.applyRanking()
    }

    // Underline is a child of the text SceneObject, so it is created here (and
    // recreated whenever the text is) and torn down with the text.
    if (this._underline) this.createUnderline()
  }

  // ─── Underline ──────────────────────────────────────────────────────

  private createUnderline(): void {
    if (!this.textSceneObject || this.underlineVisual) return
    const obj = global.scene.createSceneObject("Underline")
    obj.layer = this.textSceneObject.layer
    obj.setParent(this.textSceneObject)

    const visual = new RoundedRectangleVisual({sceneObject: obj, transparent: true})
    visual.cornerRadius = 0
    // Overlay depth settings: don't write depth from a transparent overlay.
    visual.depthTest = true
    visual.depthWrite = false
    visual.renderMeshVisual.renderOrder = this.getBaseRenderOrder()
    visual.renderMeshVisual.enabled = this._renderingEnabled && !this._textRevealPending

    this.underlineSceneObject = obj
    this.underlineVisual = visual
    this.updateUnderline()
    this.applyResolvedColors()
  }

  private destroyUnderline(): void {
    // The visual owns off-graph resources (cloned material, animation cancel
    // sets) — destroying the SceneObject alone leaks them.
    if (this.underlineVisual) {
      this.underlineVisual.destroy()
    }
    if (this.underlineSceneObject && !isNull(this.underlineSceneObject)) {
      this.underlineSceneObject.destroy()
    }
    this.underlineSceneObject = null
    this.underlineVisual = null
  }

  /**
   * Size + position the underline bar under the glyphs. Width matches the
   * text's natural (unwrapped) extent, clamped to the allocated cell so a
   * wrapped/flex-shrunk label can't push the bar past the component bounds;
   * horizontal offset accounts for the text alignment inside its allocated
   * cell; vertical offset drops it just below the glyph baseline. Parented
   * under the (scale-reset) text SceneObject, so these are local-cm values.
   */
  private updateUnderline(): void {
    if (!this.underlineVisual || !this.underlineSceneObject || !this.textFlexItem) return
    const natural = this.measureNaturalTextSize()
    if (!natural) return

    const allocated = this.textFlexItem.allocatedSize()
    const barWidth = allocated.width > 0 ? Math.min(natural.width, allocated.width) : natural.width
    this.underlineVisual.size = new vec3(barWidth, this._underlineThickness, 0)

    let cx = 0
    if (this._textAlignment === TextAlignment.Left) {
      cx = -allocated.width / 2 + barWidth / 2
    } else if (this._textAlignment === TextAlignment.Right) {
      cx = allocated.width / 2 - barWidth / 2
    }
    const cy = -(natural.height * UNDERLINE_BASELINE_FRACTION) - this._underlineOffset - this._underlineThickness / 2
    this.underlineSceneObject.getTransform().setLocalPosition(new vec3(cx, cy, 0))
  }

  /**
   * After FlexLayout positions items, fix the text SceneObject.
   * FlexItem's fallback handler scales SceneObjects, which doesn't work for Text
   * (Text needs its layout rect set, not scale). Reset the scale and set the rect
   * based on the FlexItem's allocated size.
   */
  private fixTextAfterLayout(): void {
    if (!this.textSceneObject || !this._textComponent || !this.textFlexItem) return

    // Read the allocated size from the FlexItem
    const allocated = this.textFlexItem.allocatedSize()

    // Undo any scaling the fallback handler applied
    this.textSceneObject.getTransform().setLocalScale(vec3.one())

    // Set the text's layout rect to match the allocated area
    setTextRect(this._textComponent, this.textSceneObject, allocated.width, allocated.height)
    this._textComponent.horizontalAlignment = TEXT_HALIGN_MAP[this._textAlignment] ?? HorizontalAlignment.Center
    // When the allocation fits the measured glyphs, render with Overflow so an
    // exact-width rect can never wrap-and-truncate the last word; when the
    // container is genuinely too small (flexShrink pushed the item below natural
    // width), fall back to Wrap so glyphs stay contained instead of spilling
    // over the icon.
    //
    // This applies to any mode that sized the container FROM the text, not just
    // Fit. autoResize does exactly that — and because it pins the width at
    // natural + FIT_WIDTH_EPSILON (0.02cm), it lands in the exact-width hazard
    // every time. Gating this on Fit alone meant a Hug + autoResize label (the
    // default sizing) silently lost its last word: "Select Date" rendered
    // "Select", "SUN" rendered "SU".
    // Assigned unconditionally, NOT only when a natural width is known. A text
    // change nulls the stored width, and skipping the write in that state left
    // the component on the PREVIOUS pass's Overflow — so a longer new string
    // spilled outside its container until the next measurement caught up. With
    // no known width, fitsExactly is false and this correctly falls back to Wrap
    // (matching what createTextItem sets), so the fixed-size path is unchanged.
    const knownNaturalWidth = this._textSizing === TextSizing.Fit ? this.fitNaturalWidth : this.autoResizeNaturalWidth
    const fitsExactly = knownNaturalWidth !== null && allocated.width >= knownNaturalWidth
    this._textComponent.horizontalOverflow =
      !this._wrapText || fitsExactly ? HorizontalOverflow.Overflow : HorizontalOverflow.Wrap

    this.updateUnderline()
  }

  // ─── Layout Helpers ─────────────────────────────────────────────────

  private setContainerSize(width: number, height: number): void {
    if (!this.flexLayout) return
    this.flexLayout.width = Math.max(width, 0)
    this.flexLayout.height = Math.max(height, 0)
  }

  private applyLayoutConfig(): void {
    if (!this.flexLayout) return

    const isRow = this._iconLayout === IconLayout.Left || this._iconLayout === IconLayout.Right
    this.flexLayout.direction = DIRECTION_MAP[this._iconLayout] ?? FlexDirection.Row
    this.flexLayout.justifyContent = JUSTIFY_MAP[this._textAlignment] ?? FlexJustify.Center
    this.flexLayout.alignItems = FlexAlign.Center
    this.flexLayout.columnGap = isRow ? this._spacing : 0
    this.flexLayout.rowGap = isRow ? 0 : this._spacing
    this.flexLayout.paddingTop = this._paddingTop
    this.flexLayout.paddingRight = this._paddingRight
    this.flexLayout.paddingBottom = this._paddingBottom
    this.flexLayout.paddingLeft = this._paddingLeft
  }

  private forceLayoutPass(): void {
    if (!this.flexLayout) return
    this.flexLayout.forceLayout()
    this.fixTextAfterLayout()
  }

  private applyIconSize(sceneObject: SceneObject | null, flexItem: FlexItem | null, size: number): void {
    if (sceneObject && !isNull(sceneObject)) {
      sceneObject.getTransform().setLocalScale(new vec3(size, size, 1))
    }
    if (flexItem && !isNull(flexItem)) {
      flexItem.overrideWidth = size
      flexItem.overrideHeight = size
    }
  }

  private computeContainerLocalZ(): number {
    return this._zOffset + (this.siblingElement?.contentZOffset ?? 0)
  }

  private applyContainerLocalZ(): void {
    if (!this.contentContainer) return
    this.contentContainer.getTransform().setLocalPosition(new vec3(0, 0, this.computeContainerLocalZ()))
  }

  /**
   * Sync text FlexItem sizing with the current compact-layout toggle.
   * Hug: text fills remaining space (flexGrow 1).
   * Compact: text uses its measured intrinsic width (flexGrow 0) so
   * justifyContent can position the icon+text group as a unit.
   */
  private applyCompactTextSizing(): void {
    if (!this.textFlexItem || !this.textComponent) return
    if (this._textSizing !== TextSizing.Fit) {
      this.textFlexItem.flexGrow = 1
      this.textFlexItem.flexShrink = 1
      this.textFlexItem.flexBasis = 0
      // clearOverride*, NOT `= 0` — a programmatic 0 PINS the item to zero
      // (see LayoutItem2D.overrideWidth); Hug was only rescued by flexGrow.
      this.textFlexItem.clearOverrideWidth()
      this.textFlexItem.clearOverrideHeight()
      if (this.fitNaturalWidth !== null) {
        this.fitNaturalWidth = null
        this.textComponent.horizontalOverflow = this._wrapText ? HorizontalOverflow.Wrap : HorizontalOverflow.Overflow
      }
      return
    }
    const natural = this.measureNaturalTextWidth()
    if (natural === null) {
      // Degenerate measure (text handler not resolved on the first pass, or
      // getBoundingBox rate-limited): pinning it would lock the text to zero
      // width. Keep the previous sizing — the post-layout re-measure
      // (verifyFitMeasurement) re-pins once a real measurement is available.
      return
    }
    this.fitNaturalWidth = natural
    this.textFlexItem.flexGrow = 0
    this.textFlexItem.flexShrink = 1
    this.textFlexItem.flexBasis = "auto"
    this.textFlexItem.overrideWidth = natural + FIT_WIDTH_EPSILON
    // Height stays handler-driven: pinning 0 collapses column icon layouts,
    // where height is the main axis (row layouts were rescued by alignSelf
    // Stretch).
    this.textFlexItem.clearOverrideHeight()
  }

  /**
   * The text's natural (unwrapped) extent, measured with overflow forced to
   * Overflow, or null when the measurement is unusable (component missing,
   * getBoundingBox throwing under rate-limiting, or a zero/non-finite read).
   * The overflow restore lives in a finally so a throwing measure can never
   * leave the text stuck in Overflow mode.
   */
  private measureNaturalTextSize(): {width: number; height: number} | null {
    if (!this.textComponent) {
      this._naturalPending = false
      return null
    }
    // Through the shared coordinator: one native attempt per Text per frame
    // across UIKit, shared with the FlexLayout / TextHandler measuring this
    // same Text. A cache hit costs nothing; a pending answer arms the retry.
    const natural = measureNaturalSize(this.textComponent)
    if (natural.status !== "ready") {
      this._naturalPending = true
      this.scheduleRetry()
      return null
    }
    this._naturalPending = false
    const {width, height} = natural.value
    if (width <= 0 || height <= 0) return null // genuinely empty content sizes normally
    return {width, height}
  }

  /**
   * True while sizing is UNRESOLVED: this component's natural size, or the
   * layout's own fit-content probes, are outstanding. This is the work that
   * needs another `flushLayout()`.
   */
  private hasPendingMeasurementWork(): boolean {
    return (
      this._naturalPending ||
      this._geometryPending ||
      this._stagedText !== null ||
      (this.flexLayout !== null && this.flexLayout.fitContentPending)
    )
  }

  /**
   * True while ANY continuation work is owed: unresolved sizing, or font
   * revalidation samples still to be taken. Decides whether the LateUpdate
   * continuation stays armed; a settled layout with a revalidation window open
   * still needs its frames.
   */
  private hasContinuationWork(): boolean {
    return this.hasPendingMeasurementWork() || this._revalidationsLeft > 0
  }

  /**
   * True while natural-size work for the label is outstanding (rate-limited
   * this frame) and the continuation is retrying. Diagnostic.
   */
  public get measurementPending(): boolean {
    return this._naturalPending || this._stagedText !== null
  }

  /**
   * The label currently rendered. Equals {@link text} except while a
   * replacement is staged on a content-sized control: then {@link text} is the
   * requested label and this is the last committed one. Empty until the first
   * content-sized label has resolved its geometry.
   */
  public get displayedText(): string {
    if (this._textRevealPending) return ""
    if (this._textComponent && !isNull(this._textComponent)) return this._textComponent.text
    return this._text
  }

  /** Content-sized controls stage label changes; fixed-size ones write immediately. */
  private isContentSized(): boolean {
    return (this._autoResizeParent && this.siblingElement !== null) || this._textSizing === TextSizing.Fit
  }

  /**
   * Every accepted label request — staged, immediate, clearing, or creating the
   * first Text — supersedes whatever request came before it: the revision
   * advances and any staged target is dropped, so an in-flight preparation for
   * an older request can never commit over a newer one. Native attempt
   * accounting is untouched (it belongs to the Text, not to the request).
   */
  private supersedeLabelRequest(): void {
    this._presentationRevision++
    this._stagedText = null
  }

  /**
   * After a sizing-mode change (autoResize / textSizing): a request staged
   * because the control WAS content-sized must follow the new mode. If staging
   * is no longer required, the latest requested label is written immediately,
   * the way a fixed-size control writes it. If it is still required, the staged
   * request simply continues under its revision.
   */
  private reconcileStagedRequestForMode(): void {
    if (this._stagedText === null) return
    if (this.isContentSized()) return
    const target = this._stagedText
    this.supersedeLabelRequest()
    if (this._textComponent && !isNull(this._textComponent)) {
      this.commitStagedLabel(target)
    }
  }

  /**
   * The label's Text is gone (cleared or destroyed): nothing about it is owed
   * any more — no staged request, no natural-size pending state, no font
   * revalidation samples. Pending layout work for icons or the container is
   * untouched (it lives on the FlexLayout).
   */
  private cancelTextWork(): void {
    this.supersedeLabelRequest()
    this._textRevealPending = false
    this._stagedTextSize = null
    this._naturalPending = false
    this._revalidationsLeft = 0
  }

  /**
   * Measures the staged label and optional font size without exposing them:
   * both are swapped for the coordinator's single probe and restored before
   * returning, on every path. The coordinator keeps the displayed label's and
   * the staged label's results side by side, so the displayed label's ordinary
   * layout queries do not evict the staged result while it waits. A ready
   * result commits at once; a pending one leaves the old presentation intact
   * and the continuation armed. Reports whether it committed, queued, or waits
   * for measurement. Icon-only geometry uses the same transaction without
   * a text probe.
   */
  private presentContent(): "committed" | "pending" | "queued" {
    const target = this._stagedText
    const text = this.hasLiveTextComponent() ? this._textComponent : null
    if (text ? target === null : !this._geometryPending) return "pending"
    const revision = this._presentationRevision
    const targetSize = this._stagedTextSize
    let preparedSize = {width: 0, height: 0}
    if (text && target !== null) {
      const committed = text.text
      const committedSize = text.size
      let natural: ReturnType<typeof measureNaturalSize>
      try {
        text.text = target
        if (targetSize !== null) text.size = targetSize
        natural = measureNaturalSize(text)
      } finally {
        if (targetSize !== null) text.size = committedSize
        text.text = committed
      }
      if (natural.status !== "ready") {
        this.scheduleRetry()
        return "pending"
      }
      preparedSize = natural.value
    }
    // Only the latest request may commit; a result for an older revision
    // (A → B → A collapses to the current staged value) is simply superseded.
    if (revision !== this._presentationRevision || this._stagedText !== target) return "pending"

    // The whole presentation as one operation: label, fitting knowledge, local
    // allocation, element size, and the local re-allocation for that size.
    const owner = this.findLayoutOwner()
    const request: PresentationRequest = {
      prepare: (preparation) => {
        const item = this.findLayoutItem()
        if (!item || !this._autoResizeParent || !this.siblingElement) return
        const size = this.naturalContentSize(preparedSize)
        const current = this.siblingElement.size
        const width = Math.max(size.width, this._minWidth)
        const height = Math.max(size.height, this._minHeight)
        if (width <= 0 || height <= 0 || !isFinite(width) || !isFinite(height)) return
        const changes = Math.abs(current.x - width) > 0.001 || Math.abs(current.y - height) > 0.001
        const proposed = changes ? new vec3(width, height, current.z) : current
        preparation.measurements.set(item, {
          min: {width: 0, height: 0},
          preferred: {width: proposed.x, height: proposed.y},
          max: {width: Infinity, height: Infinity}
        })
      },
      isCurrent: () => {
        if (
          !this._initialized ||
          this._stagedText !== target ||
          this._presentationRevision !== revision ||
          this._stagedTextSize !== targetSize ||
          (text
            ? this._textComponent !== text || !this.hasLiveTextComponent()
            : this.hasLiveTextComponent() || !this._geometryPending || !this._autoResizeParent) ||
          this.findLayoutOwner() !== owner
        )
          return false
        // A queue wait can change metrics or invalidate the prepared cache.
        // Validate without spending a native attempt; rejected work remains
        // staged for the component's existing bounded continuation.
        if (!text || target === null) return true
        const displayed = text.text
        const displayedSize = text.size
        try {
          text.text = target
          if (targetSize !== null) text.size = targetSize
          return text.text === "" || getCachedNaturalSize(text) === preparedSize
        } finally {
          if (targetSize !== null) text.size = displayedSize
          text.text = displayed
        }
      },
      commit: () => {
        this._geometryPending = false
        if (target !== null) this.commitStagedLabel(target)
        // Supply fitting knowledge before layout, even if Auto-Resize leaves
        // the host size unchanged and no second layout pass is needed.
        if (this._autoResizeParent && this.siblingElement) this.autoResizeNaturalWidth = preparedSize.width
        this.applyCompactTextSizing()
        this.applyLayoutConfig()
        this.forceLayoutPass()
        if (this._autoResizeParent && this.siblingElement && this.updateAutoSize()) {
          this.forceLayoutPass()
        }
      },
      complete: () => this.announcePresentationIfReady()
    }
    // Through the owning layout when there is one, so its geometry (and its
    // owners') settles in the same operation; otherwise locally.
    if (owner && typeof owner.presentSynchronously === "function") {
      const outcome = owner.presentSynchronously(request)
      if (outcome === "queued") {
        // The owner is mid-pass: the old presentation stays until it drains
        // this request right after. Stay armed in case that never happens.
        this.scheduleRetry()
        return "queued"
      }
      // Drained requests may have been superseded meanwhile; report by state.
      return this._stagedText === null && !this._geometryPending ? "committed" : "pending"
    }
    if (!request.isCurrent()) return "pending"
    request.commit()
    request.complete?.()
    return "committed"
  }

  /**
   * The layout that owns this control's host Element: the LayoutItem2D sitting
   * beside us on the same SceneObject, and whatever container registered it.
   * Resolved at commit time, not cached — reparenting or removal between
   * request and commit must not target a stale owner.
   */
  private findLayoutOwner(): LayoutOwner | null {
    return this.findLayoutItem()?.parentLayout ?? null
  }

  /** The LayoutItem2D beside us on the host Element's SceneObject, if a layout owns this control. */
  private findLayoutItem(): LayoutItem2D | null {
    if (!this.sceneObject || isNull(this.sceneObject)) return null
    for (const component of this.sceneObject.getComponents("ScriptComponent")) {
      if (component instanceof LayoutItem2D) return component
    }
    return null
  }

  /**
   * Presents the staged label: writes the rendered Text and drops the OLD
   * label's fitting knowledge (a longer label must not inherit "fits exactly").
   * The caller (flushLayout) immediately re-pins, re-lays out, and re-sizes
   * the parent from the now-cached natural size, so the new text never renders
   * in the old geometry.
   */
  private commitStagedLabel(target: string): void {
    if (!this._textComponent) return
    if (this._stagedTextSize !== null) this._textComponent.size = this._stagedTextSize
    this._stagedTextSize = null
    this._textComponent.text = target
    this._stagedText = null
    this.autoResizeNaturalWidth = null
    this.fitNaturalWidth = null
  }

  /**
   * True when the continuation budget ran out for the current generation with
   * work still unresolved (natural sizing, layout probes, or owed font
   * revalidation samples): the component keeps its last coherent presentation
   * and stops retrying until a setter starts a new generation. Diagnostic;
   * unresolved work is never reported as completed.
   */
  public get measurementExhausted(): boolean {
    return this._retryExhausted
  }

  // ─── Pending measurement continuation ─────────────────────────────────

  /**
   * Arms the LateUpdate continuation unless this generation's budget is spent.
   * Not gated on `_initialized`: the build itself routinely leaves natural-size
   * work pending (the first measure lands before `_initialized` flips), and
   * that work must still get its next frame.
   */
  private scheduleRetry(): void {
    if (this._retryExhausted || !this.retryEvent) return
    this.retryEvent.enabled = true
  }

  /** New external state: fresh retry budget and a fresh revalidation window. */
  private resetRetryBudget(): void {
    this._retryFramesUsed = 0
    this._lastRetryToken = Number.NaN
    this._retryExhausted = false
  }

  /**
   * Opens a font-revalidation window: STYLE_REVALIDATION_FRAMES successful
   * natural-size samples are owed, one per frame, starting on a frame after
   * this one. Arms the continuation, since a settled layout would otherwise
   * never run them. Does not touch the coordinator's frame allowance.
   */
  private beginRevalidation(): void {
    // Font samples exist to catch late glyph metrics of a rendered label. With
    // no live Text there is nothing to sample: leave no work owed, and do not
    // arm the continuation for it. (Icon-only and empty controls hit this.)
    if (!this.hasLiveTextComponent()) {
      this._revalidationsLeft = 0
      return
    }
    this._revalidationsLeft = STYLE_REVALIDATION_FRAMES
    this._lastRevalidationToken = getFrameToken()
    this.scheduleRetry()
  }

  private hasLiveTextComponent(): boolean {
    return this._textComponent !== null && !isNull(this._textComponent)
  }

  /**
   * The Text may have been cleared or destroyed after work was owed for it.
   * A disabled-but-live Text is NOT this case: its work is merely paused.
   */
  private normalizeTextWork(): void {
    if (this.hasLiveTextComponent()) return
    if (this._revalidationsLeft !== 0 || this._naturalPending || this._stagedText !== null) {
      this.cancelTextWork()
    }
  }

  /**
   * The LateUpdate continuation. One bounded budget per generation covers
   * everything it does: each distinct frame it runs with work owed is charged
   * once, whether that frame made progress, was refused by the host, or was
   * blocked by a competing query on the same Text. After
   * FIT_CONTENT_RETRY_FRAMES such frames the generation is exhausted: the last
   * coherent presentation stays, `measurementExhausted` reports the unresolved
   * work, and nothing runs until a setter starts a new generation.
   *
   * `_revalidationsLeft` counts successful verification samples still owed,
   * not attempts: a refused refresh leaves the sample owed and the event armed.
   */
  private onRetryFrame(): void {
    if (!this._initialized || !this.flexLayout || !this.retryEvent) return
    // Owed text work for a Text that no longer exists is not work; drop it
    // before it can charge a frame or exhaust the generation.
    this.normalizeTextWork()
    // The owner may have resolved the initial allocation after our last flush.
    this.announcePresentationIfReady()
    if (!this.hasContinuationWork()) {
      this.retryEvent.enabled = false
      return
    }
    const token = getFrameToken()
    if (this._lastRetryToken !== token) {
      this._lastRetryToken = token
      this._retryFramesUsed++
    }
    if (this._retryFramesUsed > FIT_CONTENT_RETRY_FRAMES) {
      this._retryExhausted = true
      this.retryEvent.enabled = false
      log.w(
        `ElementContent: text measurement stayed unresolved for ${FIT_CONTENT_RETRY_FRAMES} frames on ` +
          `${this.sceneObject.name}; keeping the last valid presentation until the label or style changes.`
      )
      return
    }

    if (this.hasPendingMeasurementWork()) {
      // Unresolved sizing first: it is what the user sees.
      this.flushLayout()
      // The flush re-measures the natural size only for a content-sized label
      // (Fit, Auto-Resize) or an underline. A pending answer to an OUTSIDE
      // query — a host control calling measureNaturalTextWidth() on a frame
      // whose one attempt was already spent or refused — was re-asked by
      // nothing else, so on a Hug label the flag blocked the announce until the
      // budget ran out. Re-ask after the flush, not before it: its layout pass
      // has just measured the label, so this is a cache hit whenever anything
      // is available, and host controls that re-check on that pass still get it.
      if (this._naturalPending) {
        this.measureNaturalTextSize()
        this.announcePresentationIfReady()
      }
    } else if (this._revalidationsLeft > 0 && this.textComponent) {
      // Settled layout, samples owed. One frame-spaced re-measure of the
      // natural size under the current key, looking for metrics that landed
      // after the first (positive) measurement. Only on a frame after the one
      // the window opened on, and only when this frame's attempt is still
      // available — a frame a competing query already spent does not count
      // as a sample, the sample stays owed. A refused refresh likewise stays
      // owed; the existing natural size remains the provisional display state.
      // Unchanged metrics keep every cache and cause no layout; changed metrics
      // drop the dependent caches (coordinator) and re-lay out.
      if (this._lastRevalidationToken !== token && canAttemptThisFrame(this.textComponent)) {
        this._lastRevalidationToken = token
        const refreshed = refreshNaturalSize(this.textComponent, FIT_REMEASURE_TOLERANCE)
        if (refreshed.status === "ready") {
          this._revalidationsLeft--
          if (refreshed.changed) {
            // Re-present the current label through the owner transaction: its
            // new metrics can change every sibling's allocation this frame.
            if (this.isContentSized()) this._stagedText = this.textComponent.text
            this.flushLayout()
          }
        }
      }
    }

    if (!this.hasContinuationWork()) this.retryEvent.enabled = false
  }

  /**
   * Measures the label's natural (unwrapped) width in cm, or null when there is
   * no text or the measurement is degenerate (e.g. the text handler has not
   * resolved yet). Safe to call every frame; see {@link measureNaturalTextSize}.
   * A pending answer leaves the natural size owed, and the continuation re-asks
   * it on the following frames while the generation's retry budget lasts. If it
   * is still pending when the budget runs out, the presentation stays
   * unannounced ({@link measurementExhausted}) until a setter starts a new
   * generation.
   */
  public measureNaturalTextWidth(): number | null {
    return this.measureNaturalTextSize()?.width ?? null
  }

  /**
   * Fit-mode self-heal, run after every layout pass: the build-time
   * measurement can be zero (text handler unresolved on the first pass) or
   * stale (async font / TextStylePresets metrics landing after the measure).
   * Re-measure and schedule a re-pin when the natural width drifted.
   */
  private verifyFitMeasurement(): void {
    if (this._textSizing !== TextSizing.Fit || !this.textComponent || !this.textFlexItem) return
    const natural = this.measureNaturalTextWidth()
    if (natural === null) return
    if (this.fitNaturalWidth !== null && Math.abs(natural - this.fitNaturalWidth) <= FIT_REMEASURE_TOLERANCE) {
      return
    }
    // Internal drift correction: re-pin on the next flush WITHOUT starting a new
    // generation — routing this through markLayoutDirty would hand every
    // correction a fresh retry budget and a fresh revalidation window.
    this.deferFlush()
  }

  // ─── Batch Layout ──────────────────────────────────────────────────
  //
  // Multiple setter calls in one frame (e.g. setting text, leadingIcon,
  // and padding together) would each trigger a full layout pass and
  // auto-resize measurement. The dirty-flag pattern coalesces these into
  // a single deferred flush: each setter records its change immediately
  // (including structural work like creating/destroying FlexItems), then
  // calls markLayoutDirty(). setTimeout(0) defers the flush to after all
  // setters in the current frame have executed, so the expensive work —
  // applyLayoutConfig, forceLayout, fixTextAfterLayout, updateAutoSize —
  // runs exactly once regardless of how many properties changed. It only
  // coalesces; it does not advance the host's measurement frame. Work that
  // needs another frame uses the LateUpdate continuation below.

  private _layoutDirty = false
  // Cancel token for the deferred flush scheduled by markLayoutDirty(), so a
  // pending flush can be cancelled in onDestroy() before it fires on a
  // torn-down SceneObject.
  private _flushCancelToken: CancelToken | null = null

  // ─── Pending measurement lifecycle ────────────────────────────────────
  //
  // Text measurement is coordinated (TextMeasurement.ts): one native attempt
  // per Text per frame across UIKit, and a fresh label needs several (natural
  // extent, longest word, wrapped height). So natural-size work is routinely
  // PENDING on the frame it is first asked for, and a one-shot post-layout
  // retry is not enough. This component owns a LateUpdate continuation:
  // pending work enables it, each distinct frame re-runs the flush (cache
  // hits are free; only outstanding measurements spend an attempt), success
  // disables it, and a bounded budget (FIT_CONTENT_RETRY_FRAMES distinct
  // frames) stops it for content that never measures. External changes
  // (setters → markLayoutDirty) start a new generation with a fresh budget;
  // retries never reset it. Same-frame re-entries never spend a second frame.
  private retryEvent: SceneEvent | null = null
  private _naturalPending = false
  private _geometryPending = false
  // ─── Staged presentation ───────────────────────────────────────────────
  // A replacement label on an already-visible, content-sized control is NOT
  // written to the rendered Text until its natural size is known: the new
  // text, its natural-width knowledge, the child allocation, and the parent
  // dimensions are committed together in one synchronous operation
  // (prepareStagedLabel → commitStagedLabel → flush). Until then the last
  // committed presentation stays on screen. `_text` (the public getter) is the
  // REQUESTED label; `displayedText` is what is rendered. Fixed-size controls
  // and first appearances (no prior presentation) still write immediately.
  private _stagedText: string | null = null
  /** Requested font size travels with the staged label; native size stays committed until sizing is ready. */
  private _stagedTextSize: number | null = null
  private _presentationRevision = 0
  private _retryFramesUsed = 0
  private _lastRetryToken = Number.NaN
  private _retryExhausted = false
  private _revalidationsLeft = 0
  private _lastRevalidationToken = Number.NaN

  /**
   * An EXTERNAL change from a setter. Starts a new generation: fresh retry
   * budget (the retry path never resets it) and, when the change can affect
   * glyph metrics (`metricsChanged`: text, size, ranking/font), a fresh
   * revalidation window, armed immediately so a layout that settles at once
   * still gets its samples. Color-only, padding, spacing, and icon changes
   * pass `false` and open no window. The coordinator's spent frame allowance
   * is untouched either way — this frame's attempt stays spent.
   */
  private markLayoutDirty(metricsChanged = false): void {
    if (!this._initialized) return
    this._presentationRevision++
    this.resetRetryBudget()
    if (metricsChanged) this.beginRevalidation()
    this.deferFlush()
  }

  /**
   * Coalesces a layout flush to after the current frame's setters have run.
   * Internal callers (drift correction, staged commits) use this directly so
   * they never reset the generation.
   */
  private deferFlush(): void {
    if (!this._initialized) return
    if (this._layoutDirty) return
    this._layoutDirty = true
    // Track the cancel token so onDestroy can cancel a still-pending flush.
    // A global setTimeout is engine-level: it survives this component's
    // teardown and would otherwise fire flushLayout() on a destroyed
    // SceneObject (accessing this.sceneObject then throws "Object is null").
    this._flushCancelToken = setTimeout(() => {
      this._flushCancelToken = null
      this.flushLayout()
    }, 0)
  }

  private flushLayout(): void {
    if (!this._initialized || !this.flexLayout) return
    // A retry can flush before the timer; consume the pending flush either way.
    if (this._flushCancelToken !== null) {
      clearTimeout(this._flushCancelToken)
      this._flushCancelToken = null
    }
    this._layoutDirty = false
    this._geometryPending = false
    // Geometry-only changes (padding, icons, Auto-Resize toggles) need the
    // same owner transaction as a replacement label. Their deferred callback
    // can run after the owner's LateUpdate, so marking it dirty is insufficient.
    if (this._stagedText === null && this._autoResizeParent && this.siblingElement && this.findLayoutOwner()) {
      if (this.hasLiveTextComponent()) this._stagedText = this._textComponent!.text
      else this._geometryPending = true
    }
    // A staged label commits here through its owning layout (one operation:
    // label, allocation, element size, owner geometry), or stays staged while
    // pending / queued. A committed presentation already ran every pass below
    // against the new label; otherwise the flush runs against the RENDERED
    // label, so nothing can size the old text for the new one or vice versa.
    if (this._stagedText !== null || this._geometryPending) {
      const geometryOnly = this._geometryPending
      const remeasuringDisplayedLabel = this._stagedText === this._textComponent?.text
      if (this.presentContent() === "committed" || remeasuringDisplayedLabel || geometryOnly) {
        // Pending corrections to the displayed label must not fall through
        // and apply its new metrics outside the owner's transaction.
        this.announcePresentationIfReady()
        if (this.hasContinuationWork()) this.scheduleRetry()
        return
      }
    }
    this.applyCompactTextSizing()
    this.applyLayoutConfig()
    this.forceLayoutPass()
    if (this._autoResizeParent && this.siblingElement) {
      if (this.updateAutoSize()) {
        // The parent (and this container) just changed size: allocate the text
        // rect for the new size now, in the same operation, rather than leaving
        // it to an independently ordered LateUpdate one frame later.
        this.forceLayoutPass()
      }
    }
    this.announcePresentationIfReady()
    if (this.hasContinuationWork()) this.scheduleRetry()
  }

  // ─── Presentation readiness ─────────────────────────────────────────────
  //
  // First labels stay hidden until sizing resolves. Owners can also gate a
  // whole panel's reveal on this signal.
  // `onPresentationReady` fires once per request generation when this
  // control's sizing has fully resolved (no natural-size, staged, or layout
  // work pending). Owners gate their reveal on it; ElementContent cannot hide
  // or reveal a panel on their behalf.
  private readonly onPresentationReadyEvent = new Event<void>()
  public readonly onPresentationReady: PublicApi<void> = this.onPresentationReadyEvent.publicApi()
  private _presentationReadyRevision = -1
  private _textRevealPending = false

  /** True once the current request generation has a fully resolved presentation. */
  public get presentationReady(): boolean {
    return (
      this._initialized &&
      !this._layoutDirty &&
      !this.hasPendingMeasurementWork() &&
      this._presentationReadyRevision === this._presentationRevision
    )
  }

  private announcePresentationIfReady(): void {
    if (!this._initialized || this._layoutDirty || this.hasPendingMeasurementWork()) return
    if (this._presentationReadyRevision === this._presentationRevision) return
    if (this._textRevealPending) {
      this._textRevealPending = false
      this.updateTextRendering()
    }
    this._presentationReadyRevision = this._presentationRevision
    this.onPresentationReadyEvent.invoke()
  }

  // ─── Sibling Events ─────────────────────────────────────────────────

  private subscribeToSiblingEvents(): void {
    const sibling = this.siblingElement!
    // Required core
    this.unsubscribes.push(sibling.onSizeChanged.add((newSize: vec3) => this.onElementSizeChanged(newSize)))
    // Optional theme/state surface — only subscribe if the host implements it
    const stateUnsub = sibling.onStateChanged?.add((stateName: string) => this.onElementStateChanged(stateName))
    if (stateUnsub) this.unsubscribes.push(stateUnsub)
    const zUnsub = sibling.onContentZOffsetChanged?.add(() => this.applyContainerLocalZ())
    if (zUnsub) this.unsubscribes.push(zUnsub)
  }

  // ─── State Colors ───────────────────────────────────────────────────

  private onElementStateChanged(stateName: string): void {
    this._lastStateName = stateName
    this._colorsDirty = true
    this.applyResolvedColors()
  }

  /**
   * Apply the cached resolved colors with the current opacity multiplier.
   * Per-frame opacity tweens land here without re-running the theme
   * resolution pipeline. The cache is refreshed lazily when `_colorsDirty`.
   */
  private applyResolvedColors(): void {
    if (!this._initialized || this._lastStateName === null) return
    if (this._colorsDirty || this._cachedColors === null) {
      this._cachedColors = this._useThemeColors
        ? this.resolveThemeColors(this._lastStateName)
        : this.getManualColors(this._lastStateName)
      this._colorsDirty = false
    }
    const colors = this._cachedColors
    if (!colors) return
    const opacity = this._opacityFactor

    if (this._textComponent && colors.textColor) {
      if (this._useTextColorOverride) {
        this._textComponent.textFill.color = new vec4(
          this._textColorOverride.r,
          this._textColorOverride.g,
          this._textColorOverride.b,
          this._textColorOverride.a * colors.textColor.a * opacity
        )
      } else {
        this._textComponent.textFill.color = new vec4(
          colors.textColor.r,
          colors.textColor.g,
          colors.textColor.b,
          colors.textColor.a * opacity
        )
      }
    }
    // Underline tracks the resolved text color (honoring the per-instance
    // override) in every state.
    if (this.underlineVisual && colors.textColor) {
      const base = this._useTextColorOverride ? this._textColorOverride : colors.textColor
      const alpha = colors.textColor.a * opacity * (this._useTextColorOverride ? this._textColorOverride.a : 1)
      this.underlineVisual.baseDefaultColor = new vec4(base.r, base.g, base.b, alpha)
    }
    if (this.leadingIconImage && colors.iconTint) {
      this.leadingIconImage.mainPass.baseColor = new vec4(
        colors.iconTint.r,
        colors.iconTint.g,
        colors.iconTint.b,
        colors.iconTint.a * opacity
      )
    }
    if (this.trailingIconImage && colors.iconTint) {
      this.trailingIconImage.mainPass.baseColor = new vec4(
        colors.iconTint.r,
        colors.iconTint.g,
        colors.iconTint.b,
        colors.iconTint.a * opacity
      )
    }
  }

  /**
   * Mark the cached resolved colors as stale. Call after changing any
   * field that affects color resolution at runtime — theme override,
   * style name, visual element type, useThemeColors toggle, or any
   * per-state color override. The next opacity tick or state-change
   * pass will re-resolve and re-apply.
   *
   * Applies synchronously (matching `set opacity` in this file rather
   * than the deferred `markLayoutDirty()` pattern, since color writes
   * are a handful of bridge calls and don't benefit from batching).
   */
  public markColorsDirty(): void {
    this._colorsDirty = true
    if (this._initialized) this.applyResolvedColors()
  }

  public get useThemeColors(): boolean {
    return this._useThemeColors
  }

  public set useThemeColors(value: boolean) {
    if (this._useThemeColors === value) return
    this._useThemeColors = value
    this.markColorsDirty()
  }

  public get opacity(): number {
    return this._opacityFactor
  }

  public set opacity(value: number) {
    this._opacityFactor = value
    if (this._initialized) {
      this.applyResolvedColors()
    }
  }

  /**
   * Gets whether this content uses the per-instance text color override.
   * @returns Whether the override is enabled.
   */
  public get useTextColorOverride(): boolean {
    return this._useTextColorOverride
  }

  /**
   * Sets whether this content uses the per-instance text color override.
   * @param value - Whether the override is enabled.
   */
  public set useTextColorOverride(value: boolean) {
    if (this._useTextColorOverride === value) return
    this._useTextColorOverride = value
    this.markColorsDirty()
  }

  /**
   * Gets the per-instance text color override.
   * @returns A copy of the override color — mutate it and assign back
   * through the setter to change it. Interaction-state opacity still applies.
   */
  public get textColorOverride(): vec4 {
    const color = this._textColorOverride
    return new vec4(color.x, color.y, color.z, color.w)
  }

  /**
   * Sets the per-instance text color override. Stores by copy via `copyFrom`
   * (matching `Element.set size`) — callers may reuse or mutate the passed
   * vec4 afterwards without aliasing this content's override.
   * @param value - The override color. Interaction-state opacity still applies.
   */
  public set textColorOverride(value: vec4) {
    if (value == null || isEqual<vec4>(this._textColorOverride, value)) return
    this._textColorOverride.copyFrom(value)
    this.markColorsDirty()
  }

  /**
   * Releases (or restores) the content renderables (text + leading/trailing icons) independent of
   * opacity, so content faded to alpha 0 stops holding the viewport. Guarded so it is safe to call
   * before the renderables exist. The state is persisted so renderables created afterwards (via
   * buildContent or the icon/text setters) inherit it instead of resurrecting visible.
   * @param enabled - Whether the content renderables should be active.
   */
  public setRenderingEnabled(enabled: boolean): void {
    this._renderingEnabled = enabled
    this.updateTextRendering()
    if (!isNull(this.leadingIconImage)) {
      this.leadingIconImage.enabled = enabled
    }
    if (!isNull(this.trailingIconImage)) {
      this.trailingIconImage.enabled = enabled
    }
  }

  private updateTextRendering(): void {
    const enabled = this._renderingEnabled && !this._textRevealPending
    if (!isNull(this._textComponent)) this._textComponent.enabled = enabled
    if (this.underlineVisual && !isNull(this.underlineVisual.renderMeshVisual)) {
      this.underlineVisual.renderMeshVisual.enabled = enabled
    }
  }

  private resolveThemeColors(stateName: string): ContentColorState {
    const key: ContentStyleKey = {
      visualElementType: this._visualElementType || this.siblingElement?.typeString || "Button",
      style: this._styleName || this.siblingElement?.style || ThemeService.getInstance().currentTheme.defaultStyleName,
      themeName:
        this._themeOverride ||
        (this.siblingElement?.normalizedThemeOverride !== "Inherited"
          ? this.siblingElement?.normalizedThemeOverride
          : undefined)
    }
    return resolveContentColors(key, stateName)
  }

  private getManualColors(stateName: string): ContentColorState {
    switch (stateName) {
      case "hovered":
      case "toggledHovered":
        return {textColor: this._hoveredTextColor, iconTint: this._hoveredIconTint}
      case "triggered":
      case "toggledTriggered":
        return {textColor: this._triggeredTextColor, iconTint: this._triggeredIconTint}
      case "inactive":
        return {textColor: this._inactiveTextColor, iconTint: this._inactiveIconTint}
      default:
        return {textColor: this._defaultTextColor, iconTint: this._defaultIconTint}
    }
  }

  // ─── Size Handling ──────────────────────────────────────────────────

  private onElementSizeChanged(newSize: vec3): void {
    if (this._skipNextSizeUpdate) {
      this._skipNextSizeUpdate = false
      return
    }
    this.setContainerSize(newSize.x, newSize.y)
    // The owner may apply after our LateUpdate, or during a presentation commit.
    // Settle the content now so it renders in the same allocation as its host.
    if (this._initialized) this.forceLayoutPass()
  }

  /** Shared by presentation preparation and the live Auto-Resize commit. */
  private naturalContentSize(natural: {width: number; height: number}): {width: number; height: number} {
    const isRow = this._iconLayout === IconLayout.Left || this._iconLayout === IconLayout.Right
    return this.flexLayout!.computeContentSizeWithItem(
      this.textFlexItem,
      {width: natural.width + FIT_WIDTH_EPSILON, height: natural.height},
      {
        direction: DIRECTION_MAP[this._iconLayout] ?? FlexDirection.Row,
        justifyContent: JUSTIFY_MAP[this._textAlignment] ?? FlexJustify.Center,
        alignItems: FlexAlign.Center,
        columnGap: isRow ? this._spacing : 0,
        rowGap: isRow ? 0 : this._spacing,
        padding: {
          top: this._paddingTop,
          right: this._paddingRight,
          bottom: this._paddingBottom,
          left: this._paddingLeft
        }
      }
    )
  }

  /** Fit the parent using coordinated natural text metrics; retain its size while pending. */
  private updateAutoSize(): boolean {
    if (!this.siblingElement || !this.flexLayout) return false

    let contentSize = {width: 0, height: 0}
    const item = this.textFlexItem
    // Temporarily pin natural dimensions for the content probe, then restore flex sizing.
    const natural = item && this._textComponent ? this.measureNaturalTextSize() : null
    if (item && this._textComponent && natural === null && this._naturalPending) {
      // Keep the parent size until text is ready; the previous natural width is stale.
      this.autoResizeNaturalWidth = null
      return false
    }
    // fixTextAfterLayout uses this width to distinguish an exact fit from wrapping.
    this.autoResizeNaturalWidth = natural ? natural.width : null
    contentSize = item && natural ? this.naturalContentSize(natural) : this.flexLayout.computeContentSize()

    // Bail on degenerate measurements: zero (text not ready) or non-finite
    // (handler hasn't resolved yet, max defaults to Infinity). Either way,
    // resizing the Element from this call would clobber the next attempt.
    if (
      contentSize.width <= 0 ||
      contentSize.height <= 0 ||
      !isFinite(contentSize.width) ||
      !isFinite(contentSize.height)
    ) {
      return false
    }

    this.applyCompactTextSizing()

    const width = Math.max(contentSize.width, this._minWidth)
    const height = Math.max(contentSize.height, this._minHeight)
    const previous = elementContentSizes.get(this.siblingElement)
    const naturalChanged =
      !previous || Math.abs(previous.width - width) > 0.001 || Math.abs(previous.height - height) > 0.001
    const layoutItem = this.findLayoutItem()
    if (naturalChanged) {
      elementContentSizes.set(this.siblingElement, {width, height})
      layoutItem?.invalidateMeasure()
    }
    if (layoutItem?.parentLayout) {
      // The owner applies the allocation, including when natural size changes.
      return false
    }
    const currentSize = this.siblingElement.size
    if (Math.abs(currentSize.x - width) > 0.001 || Math.abs(currentSize.y - height) > 0.001) {
      this._skipNextSizeUpdate = true
      try {
        this.siblingElement.size = new vec3(width, height, currentSize.z)
      } finally {
        this._skipNextSizeUpdate = false
      }
      this.setContainerSize(width, height)
      if (!naturalChanged) layoutItem?.invalidateMeasure()
      return true
    }
    return false
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getBaseRenderOrder(): number {
    return this.getHostRenderOrder() + this.getContentRenderOrderOffset()
  }

  private getHostRenderOrder(): number {
    if (this._explicitRenderOrder !== null) {
      return this._explicitRenderOrder
    }
    const siblingAny = this.siblingElement as any
    if (siblingAny?._visual?.renderMeshVisual) {
      return siblingAny._visual.renderMeshVisual.renderOrder ?? 0
    }
    return 0
  }

  /**
   * Draw-order bump needed to composite above a blended host (see
   * Visual.contentRenderOrderOffset). Suppressed under a Hierarchy-sorting
   * Canvas: renderOrder outranks Canvas sorting, so a bump there would also
   * lift this content above sibling chrome that relies on child-after-parent
   * order (EdgeFade, masks, popups). The Canvas already draws us above the
   * host — our container is a child of the host's SceneObject — so the bump
   * is only the no-Canvas fallback.
   *
   * Resolved lazily and cached; the cache is dropped by
   * invalidateCanvasBinding() for callers that reparent through raw Lens APIs.
   */
  private getContentRenderOrderOffset(): number {
    // The host answers when it can. Content mounted on its own SceneObject has
    // no sibling to ask (Slider's knob content lives under the knob visual, not
    // on it), so it falls back to whatever the owner declared via
    // hostRenderOrderOffset.
    const offset = this.siblingElement?.contentRenderOrderOffset ?? this._hostRenderOrderOffset
    if (offset === 0) {
      return 0
    }
    if (this._governedByCanvas === null) {
      this._governedByCanvas = findGoverningCanvas(this.sceneObject) !== null
    }
    return this._governedByCanvas ? 0 : offset
  }

  /**
   * Drops the cached Canvas lookup behind the content render-order fallback and
   * re-pushes the resolved order onto the renderables. Call after reparenting
   * this component's SceneObject or changing ancestor Canvas topology through
   * raw Lens APIs. Wired to OnEnableEvent, so an enable/disable cycle after a
   * reparent already covers itself.
   */
  public invalidateCanvasBinding(): void {
    this._governedByCanvas = null
    if (this._initialized) {
      this.applyRenderOrder()
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Local z offset of the content container, added on top of the sibling
   * element's contentZOffset. Defaults to 0.05.
   */
  public get zOffset(): number {
    return this._zOffset
  }

  public set zOffset(value: number) {
    if (value === undefined || value === this._zOffset) {
      return
    }
    this._zOffset = value
    this.applyContainerLocalZ()
  }

  /**
   * This content's base render order: the explicit value if one was set, else
   * the sibling host's order. Symmetric with the setter, like every other
   * `renderOrder` in the kit — re-assigning the read value leaves the order
   * unchanged (it does pin a sibling-derived order as explicit, so the content
   * stops following the host from then on), and copying one content's order onto
   * another transfers the base rather than inflating it.
   *
   * The renderables do not necessarily sit AT this value: without a governing
   * Hierarchy Canvas they carry `renderOrder + contentRenderOrderOffset` so
   * they clear a blended host (see {@link getContentRenderOrderOffset}); under
   * a Canvas the offset is suppressed and the two coincide. Read
   * {@link textComponent} if you need the value actually on a renderable.
   */
  public get renderOrder(): number {
    return this.getHostRenderOrder()
  }

  /** Updates the render order of the text, icon, and underline components. */
  public set renderOrder(value: number) {
    if (value === undefined) return
    this._explicitRenderOrder = value
    this.applyRenderOrder()
  }

  /**
   * Render-order delta this content needs to composite above the visual it
   * belongs to, for owners that mount content on a SceneObject of their own
   * instead of alongside a VisualElement — Slider's knob content is the case in
   * the kit. Set it from the owning visual's `contentRenderOrderOffset`; a
   * discoverable sibling host overrides it. Like the sibling-sourced value, it
   * is suppressed under a Hierarchy-sorting Canvas.
   */
  public get hostRenderOrderOffset(): number {
    return this._hostRenderOrderOffset
  }

  public set hostRenderOrderOffset(value: number) {
    if (value === undefined || value === this._hostRenderOrderOffset) {
      return
    }
    this._hostRenderOrderOffset = value
    if (this._initialized) {
      this.applyRenderOrder()
    }
  }

  /** Pushes the current base render order onto every content renderable. */
  private applyRenderOrder(): void {
    const baseRenderOrder = this.getBaseRenderOrder()
    if (this._textComponent) {
      this._textComponent.renderOrder = baseRenderOrder
    }
    if (this.leadingIconImage) {
      this.leadingIconImage.renderOrder = baseRenderOrder
    }
    if (this.trailingIconImage) {
      this.trailingIconImage.renderOrder = baseRenderOrder
    }
    if (this.underlineVisual && !isNull(this.underlineVisual.renderMeshVisual)) {
      this.underlineVisual.renderMeshVisual.renderOrder = baseRenderOrder
    }
  }

  public set text(value: string) {
    // A plain assignment replaces whatever the label was, so a key recorded by
    // an earlier setLocalizedText no longer describes it. Leaving it stale made
    // localizationKey lie to audits AND permanently suppressed the raw-key
    // warning, since that check treated a non-null key as "already handled".
    if (!this._applyingLocalizedText) {
      this._localizationKey = null
    }
    this.warnOnRawLocalizationKey(value)
    // Repeated requests retain pending presentation and its frame budget.
    // An exhausted request may be retried explicitly with the same value.
    if (
      this._initialized &&
      !this._retryExhausted &&
      value === this._text &&
      (value
        ? this.hasLiveTextComponent() && (this._stagedText === value || this._textComponent!.text === value)
        : this.textSceneObject === null)
    ) {
      return
    }
    this._text = value
    if (!this._initialized) {
      this.autoResizeNaturalWidth = null
      return
    }
    // A new request invalidates the previous one, whatever branch it takes.
    this.supersedeLabelRequest()
    if (!value && this.textSceneObject) {
      // Clearing the label: nothing to stage, the blank is the intent, and no
      // text work of any kind remains owed.
      this.cancelTextWork()
      this.autoResizeNaturalWidth = null
      this.flexLayout!.removeItems([this.textFlexItem!])
      this.releaseExternalTextStylePreset()
      this.textSceneObject.destroy()
      this.textSceneObject = null
      this._textComponent = null
      this.textFlexItem = null
      this.textStylePresets = null
      this.ownsTextStylePresets = false
      // Underline is a child of the destroyed text object — release the
      // visual's off-graph resources (cloned material, cancel sets) and drop
      // the stale refs. Its SceneObject went down with the text object.
      if (this.underlineVisual) {
        this.underlineVisual.destroy()
      }
      this.underlineSceneObject = null
      this.underlineVisual = null
    } else if (value && !this._textComponent) {
      // Measure the first label while hidden; reveal it after sizing resolves.
      this.autoResizeNaturalWidth = null
      this.createTextItem()
      this.flexLayout!.addItems([this.textFlexItem!])
      this.applyResolvedColors()
    } else if (value && this._textComponent) {
      if (this.isContentSized()) {
        // Stage under the new revision: the rendered Text keeps the committed
        // label until the new one has usable sizing; the flush prepares and
        // commits. The committed label's fitting knowledge stays valid for
        // what is on screen.
        this._stagedText = value
      } else {
        // Fixed-size control: the geometry does not change with the label, so
        // there is no mismatched frame to avoid.
        this._textComponent.text = value
        this.autoResizeNaturalWidth = null
      }
    }
    this.markLayoutDirty(true)
  }

  /**
   * The REQUESTED label. On a content-sized control this can lead the rendered
   * label by the frames its sizing needs; see {@link displayedText}.
   */
  public get text(): string {
    return this._text
  }

  /**
   * Sets the label from a localization key, with a guaranteed fallback.
   *
   * Prefer this over assigning an `@key` to {@link text}. Both render the
   * translation on a hit — the engine resolves `@`-prefixed Text values itself,
   * before measurement — but they differ on a MISS. Assigning the key leaves
   * the raw key on screen, sized to its own length (measured at 2.57x the
   * English text, which grows the host element under `autoResize` and truncates
   * under `TextSizing.Fit`). This resolves in script instead and substitutes
   * `fallback`, so a miss costs you an untranslated label rather than a broken
   * layout.
   *
   * The resolved string is assigned to {@link text}, so `text` reads back the
   * display string, not the key; {@link localizationKey} keeps the key.
   *
   * Resolving once is safe — a device language change reboots, so there is no
   * in-session locale switch for the value to go stale against.
   *
   * IMPORTANT — the caller owns the bundle anchor. `localize()` creates no
   * build-time asset reference, so the lens using this must also name its table
   * in a literal-path `requireAsset`:
   *
   * ```ts
   * const STRINGS = requireAsset("Localization/Asset/strings") as LocalizationsAsset
   * ```
   *
   * Without it the table never ships, every key misses, and every label in the
   * UI falls back at once. The path must be an inline literal (the exporter
   * scans statically) and extensionless.
   *
   * @param key Localization key, e.g. `"@uikit:calendar:weekday-sunday-short"`.
   * @param fallback English text used when the lookup misses. Required — a
   *   fallback is the entire point of this method over assigning `text`.
   */
  public setLocalizedText(key: string, fallback: string): void {
    if (key === undefined || key === null) {
      return
    }
    // The flag tells the text setter this assignment is a localized one, so it
    // neither clears the key nor warns about it. Set around the assignment
    // rather than relying on _localizationKey being non-null, because the setter
    // now clears that — and because a fallback could itself start with "@".
    this._applyingLocalizedText = true
    try {
      this.text = localizeOr(key, fallback)
    } finally {
      this._applyingLocalizedText = false
    }
    this._localizationKey = key
  }

  /**
   * The localization key last passed to {@link setLocalizedText}, or null when
   * the label was set as a plain string. Assigning {@link text} directly clears
   * it, so this always describes what is currently displayed rather than a key
   * the label has since moved off. Provided for tooling and audits — the
   * displayed value is on {@link text}.
   */
  public get localizationKey(): string | null {
    return this._localizationKey
  }

  /**
   * Flags an `@key` assigned straight to {@link text} with no fallback. Not an
   * error — the engine resolves it and measurement is honest on a hit — but a
   * miss (most often a missing bundle anchor) then renders the raw key at ~2.5x
   * the intended width. Fires once per component; a label driven every frame
   * shouldn't flood the log.
   */
  private warnOnRawLocalizationKey(value: string): void {
    // Gate on the flag, not on _localizationKey: the key is now cleared by plain
    // assignments, and gating on it meant one setLocalizedText call silenced
    // every later raw-key assignment for the component's lifetime.
    if (this._warnedRawLocalizationKey || this._applyingLocalizedText) {
      return
    }
    if (typeof value !== "string" || value.charAt(0) !== LOCALIZATION_KEY_PREFIX) {
      return
    }
    this._warnedRawLocalizationKey = true
    // NativeLogger already prefixes "ElementContent: ", so this starts with the
    // SceneObject name rather than repeating the component.
    log.w(
      `${this.sceneObject.name}: text was set to the localization key "${value}" with no fallback. ` +
        "This renders correctly when the key resolves, but a miss (usually a missing requireAsset " +
        "bundle anchor) will show the raw key and size the layout to it. Prefer " +
        "setLocalizedText(key, fallback). Warned once for this component; other components warn " +
        "separately."
    )
  }

  /** Requested size; a content-sized label keeps its rendered size until the new measurement can commit. */
  public get textSize(): number {
    return this._textSize
  }
  public set textSize(value: number) {
    if (this._textSize === value) return
    this._textSize = value
    if (!this._initialized) return
    if (this._textComponent && this._ranking === null) {
      if (this.isContentSized()) {
        this._stagedTextSize = value
        this._stagedText = this._stagedText ?? this._text
        this._presentationRevision++
      } else {
        this._stagedTextSize = null
        this._textComponent.size = value
      }
    }
    this.markLayoutDirty(true)
  }

  /**
   * Whether the label may wrap to multiple lines when its cell is narrower
   * than the text (default). When false the label always renders on a single
   * line and overflows its rect instead of wrapping (e.g. toolbar buttons).
   */
  public get wrapText(): boolean {
    return this._wrapText
  }

  public set wrapText(value: boolean) {
    if (value === this._wrapText) return
    this._wrapText = value
    if (this._textComponent) {
      this._textComponent.horizontalOverflow = value ? HorizontalOverflow.Wrap : HorizontalOverflow.Overflow
      this.markLayoutDirty()
    }
  }

  /**
   * Whether an underline bar is drawn under the text. The bar tracks the text
   * width and recolors with the text per interaction state (e.g. Link).
   */
  public get underline(): boolean {
    return this._underline
  }

  public set underline(value: boolean) {
    if (this._underline === value) return
    this._underline = value
    if (!this._initialized) return
    if (value) {
      this.createUnderline()
    } else {
      this.destroyUnderline()
    }
    this.markLayoutDirty()
  }

  public get leadingIconSize(): number {
    return this._leadingIconSize
  }
  public set leadingIconSize(value: number) {
    if (value === undefined || this._leadingIconSize === value) return
    this._leadingIconSize = value
    if (!this._initialized) return
    this.applyIconSize(this.leadingIconSceneObject, this.leadingIconFlexItem, value)
    this.markLayoutDirty()
  }

  public get trailingIconSize(): number {
    return this._trailingIconSize
  }
  public set trailingIconSize(value: number) {
    if (value === undefined || this._trailingIconSize === value) return
    this._trailingIconSize = value
    if (!this._initialized) return
    this.applyIconSize(this.trailingIconSceneObject, this.trailingIconFlexItem, value)
    this.markLayoutDirty()
  }

  /**
   * Text style ranking applied to the embedded label via a TextStylePresets
   * component attached to the internal Text SceneObject. When set, ranking
   * overrides textSize. Set to null to remove the preset and fall back to textSize.
   */
  public get ranking(): Ranking | null {
    return this._ranking
  }
  public set ranking(value: Ranking | null) {
    if (this._ranking === value) {
      return
    }
    this._ranking = value
    // A preset owns the native font size. It supersedes an outstanding manual
    // size request, while preserving any still-requested replacement label.
    if (this._stagedTextSize !== null) {
      this._stagedTextSize = null
      this._presentationRevision++
    }
    if (this.applyRanking()) {
      this.markLayoutDirty(true)
    }
  }

  private applyRanking(): boolean {
    if (!this.textSceneObject || !this._textComponent) {
      return false
    }
    if (this._ranking === null) {
      if (this.textStylePresets && !isNull(this.textStylePresets)) {
        if (this.ownsTextStylePresets) {
          this.textStylePresets.destroy()
        } else {
          this.textStylePresets.bindTextComponent(null)
        }
      }
      this.textStylePresets = null
      this.ownsTextStylePresets = false
      this._textComponent.size = this._textSize
      if (this.weightBeforeRanking !== null) {
        ;(this._textComponent as unknown as {weight: number}).weight = this.weightBeforeRanking
        this.weightBeforeRanking = null
      }
      return true
    }
    if (this.weightBeforeRanking === null) {
      this.weightBeforeRanking = (this._textComponent as unknown as {weight: number}).weight
    }
    if (!this.textStylePresets || isNull(this.textStylePresets)) {
      this.textStylePresets = this.textSceneObject.createComponent(TextStylePresets.getTypeName()) as TextStylePresets
      this.ownsTextStylePresets = true
    }
    this.textStylePresets.bindTextComponent(this.textComponent)
    this.textStylePresets.ranking = this._ranking
    return true
  }

  private releaseExternalTextStylePreset(): void {
    if (this.textStylePresets && !isNull(this.textStylePresets) && !this.ownsTextStylePresets) {
      this.textStylePresets.bindTextComponent(null)
    }
  }

  public get leadingIcon(): Texture | null {
    return this._leadingIcon
  }
  public set leadingIcon(value: Texture | null) {
    if (
      this._initialized &&
      (value !== null) === this._useLeadingIcon &&
      ElementContent.isSameTexture(this._leadingIcon, value) &&
      (value ? this.leadingIconImage !== null && !isNull(this.leadingIconImage) : this.leadingIconSceneObject === null)
    ) {
      return
    }
    this._useLeadingIcon = value !== null
    this._leadingIcon = value
    if (!this._initialized) return

    if (!value && this.leadingIconSceneObject) {
      this.flexLayout!.removeItems([this.leadingIconFlexItem!])
      this.leadingIconSceneObject.destroy()
      this.leadingIconSceneObject = null
      this.leadingIconImage = null
      this.leadingIconFlexItem = null
    } else if (value && !this.leadingIconImage) {
      this.createLeadingIcon()
      this.flexLayout!.addItems([this.leadingIconFlexItem!])
    } else if (value && this.leadingIconImage) {
      this.leadingIconImage.mainPass.baseTex = value
    }
    this.applyResolvedColors()
    this.markLayoutDirty()
  }

  public get trailingIcon(): Texture | null {
    return this._trailingIcon
  }
  public set trailingIcon(value: Texture | null) {
    if (
      this._initialized &&
      (value !== null) === this._useTrailingIcon &&
      ElementContent.isSameTexture(this._trailingIcon, value) &&
      (value
        ? this.trailingIconImage !== null && !isNull(this.trailingIconImage)
        : this.trailingIconSceneObject === null)
    ) {
      return
    }
    this._useTrailingIcon = value !== null
    this._trailingIcon = value
    if (!this._initialized) return

    if (!value && this.trailingIconSceneObject) {
      this.flexLayout!.removeItems([this.trailingIconFlexItem!])
      this.trailingIconSceneObject.destroy()
      this.trailingIconSceneObject = null
      this.trailingIconImage = null
      this.trailingIconFlexItem = null
    } else if (value && !this.trailingIconImage) {
      this.createTrailingIcon()
      this.flexLayout!.addItems([this.trailingIconFlexItem!])
    } else if (value && this.trailingIconImage) {
      this.trailingIconImage.mainPass.baseTex = value
    }
    this.applyResolvedColors()
    this.markLayoutDirty()
  }

  private static isSameTexture(a: Texture | null, b: Texture | null): boolean {
    if (a === b) return true
    if (a === null || b === null || isNull(a) || isNull(b)) return false
    return a.isSame(b)
  }

  public get sizeOverride(): vec2 {
    return this._sizeOverride
  }

  public set sizeOverride(size: vec2) {
    this._sizeOverride = size
    if (this._initialized && this.standaloneMode) {
      this.setContainerSize(size.x, size.y)
    }
  }

  public get iconLayout(): string {
    return this._iconLayout
  }
  public set iconLayout(value: string) {
    if (this._iconLayout === value) return
    this._iconLayout = value
    this.markLayoutDirty()
  }

  public get textAlignment(): TextAlignment {
    return this._textAlignment
  }
  public set textAlignment(value: TextAlignment) {
    if (this._textAlignment === value) return
    this._textAlignment = value
    this.markLayoutDirty()
  }

  public get textSizing(): TextSizing {
    return this._textSizing
  }
  public set textSizing(value: TextSizing) {
    if (this._textSizing === value) return
    this._textSizing = value
    if (this._initialized) this.reconcileStagedRequestForMode()
    this.markLayoutDirty()
  }

  public get spacing(): number {
    return this._spacing
  }
  public set spacing(value: number) {
    const spacingChanged = this._spacing !== value
    this._customSpacing = true
    if (!spacingChanged) return
    this._spacing = value
    this.markLayoutDirty()
  }

  public get padding(): ElementContentPadding {
    return {
      top: this._paddingTop,
      right: this._paddingRight,
      bottom: this._paddingBottom,
      left: this._paddingLeft
    }
  }
  public set padding(value: ElementContentPadding) {
    const paddingChanged =
      this._paddingTop !== value.top ||
      this._paddingRight !== value.right ||
      this._paddingBottom !== value.bottom ||
      this._paddingLeft !== value.left

    this._customSpacing = true
    if (!paddingChanged) return

    this._paddingTop = value.top
    this._paddingRight = value.right
    this._paddingBottom = value.bottom
    this._paddingLeft = value.left
    this.markLayoutDirty()
  }

  public get paddingTop(): number {
    return this._paddingTop
  }
  public set paddingTop(value: number) {
    const paddingChanged = this._paddingTop !== value
    this._customSpacing = true
    if (!paddingChanged) return
    this._paddingTop = value
    this.markLayoutDirty()
  }

  public get paddingRight(): number {
    return this._paddingRight
  }
  public set paddingRight(value: number) {
    const paddingChanged = this._paddingRight !== value
    this._customSpacing = true
    if (!paddingChanged) return
    this._paddingRight = value
    this.markLayoutDirty()
  }

  public get paddingBottom(): number {
    return this._paddingBottom
  }
  public set paddingBottom(value: number) {
    const paddingChanged = this._paddingBottom !== value
    this._customSpacing = true
    if (!paddingChanged) return
    this._paddingBottom = value
    this.markLayoutDirty()
  }

  public get paddingLeft(): number {
    return this._paddingLeft
  }
  public set paddingLeft(value: number) {
    const paddingChanged = this._paddingLeft !== value
    this._customSpacing = true
    if (!paddingChanged) return
    this._paddingLeft = value
    this.markLayoutDirty()
  }

  public get autoResize(): boolean {
    return this._autoResizeParent
  }
  public set autoResize(value: boolean) {
    if (this._autoResizeParent === value) return
    this._autoResizeParent = value
    if (!value && this.siblingElement && elementContentSizes.delete(this.siblingElement)) {
      this.findLayoutItem()?.invalidateMeasure()
    }
    // The container is no longer sized from the text (or not yet), so the stored
    // width must not keep authorizing Overflow. Re-measured on the next pass.
    this.autoResizeNaturalWidth = null
    if (!this._initialized) return
    // Disabling Auto-Resize alone does not make the control fixed-size (Fit
    // may still stage); the helper re-evaluates both.
    this.reconcileStagedRequestForMode()

    if (value) {
      this.markLayoutDirty()
      return
    }

    if (this.siblingElement) {
      const currentSize = this.siblingElement.size
      this.setContainerSize(currentSize.x, currentSize.y)
    } else if (this.standaloneMode) {
      this.setContainerSize(this._sizeOverride.x, this._sizeOverride.y)
    }

    this.applyLayoutConfig()
    this.forceLayoutPass()
  }

  public setState(stateName: string): void {
    if (!this.standaloneMode) return
    this.onElementStateChanged(stateName)
  }

  /** Enables debug visualization (container and item bounds drawn each frame). */
  public get debug(): boolean {
    return this._debug
  }
  public set debug(value: boolean) {
    if (this._debug === value) return
    this._debug = value
    if (this.debugUpdateEvent) {
      this.debugUpdateEvent.enabled = value
    }
  }

  // ─── Custom content extension ────────────────────────────────────────

  /**
   * The internal `FlexLayout` that arranges this component's children
   * (leading icon, text, trailing icon). Exposed so callers can drop in
   * arbitrary `LayoutItem2D`-recognized content (e.g. a custom widget, an
   * extra Image, a nested layout) via {@link addContentItem}. `null` until
   * the component is initialized.
   */
  public get layout(): FlexLayout | null {
    return this.flexLayout
  }

  /**
   * Adds a custom child to the internal content layout. The child becomes a
   * sibling of the built-in text + icons. Caller is responsible for
   * attaching the right component (FlexItem auto-creates if missing) and
   * registering as a managed child of the sibling Element when in companion
   * mode.
   *
   * @param sceneObject The SceneObject to insert. Will be re-parented to
   *   this ElementContent's internal content container if not already.
   * @param order Optional sort order — the built-in items use 0/1/2 for
   *   leading-icon / text / trailing-icon; use higher values to append.
   */
  public addContentItem(sceneObject: SceneObject, order?: number): FlexItem | null {
    if (!this.flexLayout || !this.contentContainer) {
      log.w("ElementContent: addContentItem called before initialization; ignoring")
      return null
    }
    sceneObject.setParent(this.contentContainer)
    // `instanceof FlexItem` so an existing FlexItem subclass is reused
    // instead of synthesizing a duplicate plain FlexItem alongside it.
    let flexItem: FlexItem | null = null
    const scripts = sceneObject.getComponents("ScriptComponent")
    for (const c of scripts) {
      if (c instanceof FlexItem) {
        flexItem = c
        break
      }
    }
    if (!flexItem) {
      flexItem = sceneObject.createComponent(FlexItem.getTypeName()) as FlexItem
    }
    if (order !== undefined) flexItem.order = order
    this.flexLayout.addItems([flexItem])
    if (this.siblingElement) {
      this.siblingElement.registerManagedChild(sceneObject)
    }
    return flexItem
  }

  // ─── Debug Visualization ─────────────────────────────────────────────

  private renderDebug(): void {
    if (!this._debug || !this._initialized) return
    if (!this.flexLayout || !this.contentContainer) return

    const containerW = this.flexLayout.width
    const containerH = this.flexLayout.height

    // Use the contentContainer's transform (offset from parent)
    const transform = this.contentContainer.getTransform()
    const worldPos = transform.getWorldPosition()
    const worldRot = transform.getWorldRotation()
    const worldScale = transform.getWorldScale()

    // Container bounds (yellow box)
    const cColor = new vec4(1, 1, 0, 1)
    drawWorldBox(worldPos, containerW, containerH, worldRot, worldScale, cColor)

    // Origin marker (red diamond) at the ElementContent SceneObject origin
    const originPos = this.sceneObject.getTransform().getWorldPosition()
    const originRot = this.sceneObject.getTransform().getWorldRotation()
    const dSize = 0.3
    const dTop = originPos.add(originRot.multiplyVec3(new vec3(0, dSize, 0)))
    const dRight = originPos.add(originRot.multiplyVec3(new vec3(dSize, 0, 0)))
    const dBottom = originPos.add(originRot.multiplyVec3(new vec3(0, -dSize, 0)))
    const dLeft = originPos.add(originRot.multiplyVec3(new vec3(-dSize, 0, 0)))
    const dColor = new vec4(1, 0.2, 0.2, 1)
    global.debugRenderSystem.drawSolidTriangle(dTop, dLeft, dBottom, dColor)
    global.debugRenderSystem.drawSolidTriangle(dTop, dBottom, dRight, dColor)

    // Item bounds (orange) — distinct from FlexLayout (cyan) and GridLayout (green)
    const iColor = new vec4(1, 0.6, 0.2, 1)
    const items: (FlexItem | null)[] = [this.leadingIconFlexItem, this.textFlexItem, this.trailingIconFlexItem]
    for (const item of items) {
      if (!item) continue
      const itemPos = item.sceneObject.getTransform().getWorldPosition()
      const size = item.allocatedSize()
      drawWorldBox(itemPos, size.width, size.height, worldRot, worldScale, iColor)
    }
  }
}
