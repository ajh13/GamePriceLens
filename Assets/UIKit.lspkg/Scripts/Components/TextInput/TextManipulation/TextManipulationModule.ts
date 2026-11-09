import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractorCursor} from "InteractionKit.lspkg/Components/Interaction/InteractorCursor/InteractorCursor"
import {Interactor, InteractorInputType, TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {CursorControllerProvider} from "InteractionKit.lspkg/Providers/CursorControllerProvider/CursorControllerProvider"
import {easingFunctions} from "InteractionKit.lspkg/Utils/animate"
import Event from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {
  getCursorIndexFromUtf16Index,
  getUtf16IndexFromCursorIndex,
  isAtLineEnd,
  isAtLineStart,
  trimLinesWithCaretAdjustment,
  trimOuterWhitespaceFromCursorRange
} from "../../../../Scripts/Utility/TextManipulationUtils"
import {OpacityControllable} from "../../../Interfaces/OpacityControllable"
import {HighlightDefaultColor} from "../../../Themes/System-3.0/Colors"
import {findGoverningCanvas} from "../../../Utility/CanvasController"
import type {TextDrag} from "./TextGeometryResolver"
import {TextGeometryResolver} from "./TextGeometryResolver"
import {TextHighlightTracker} from "./TextHighlightTracker"
import type {CaretMorphTarget} from "./Visuals/CaretRenderer"
import {CARET_DEFAULT_COLOR, CaretRenderer} from "./Visuals/CaretRenderer"
import type {HandleDragUpdateEvent, HandleSide} from "./Visuals/GrabHandle"
import {GrabHandle, HANDLE_ACTIVE_COLOR, HANDLE_DEFAULT_COLOR} from "./Visuals/GrabHandle"
import type {HighlightRect, MeasureRangeResult} from "./Visuals/HighlightRenderer"
import {HighlightRenderer} from "./Visuals/HighlightRenderer"

const log = new NativeLogger("TextManipulationModule")

// Caret drag sensitivity by targeting mode. An indirect (far-field ray) drag amplifies hand motion through
// the ray's lever arm, so it runs at half sensitivity; poke and direct pinch track the hand on the surface
// and keep the full values. So does the mouse: it targets indirectly, but its ray lands exactly under the
// pointer, with no lever arm to damp.
const CARET_DRAG_SENSITIVITY: vec2 = new vec2(1, 1.3)
const CARET_DRAG_SENSITIVITY_INDIRECT: vec2 = new vec2(0.5, 0.65)
// Seconds for an abandoned hold preview's progress to run back from 1 to 0. The caret shows the eased
// value, so the visible shrink is front-loaded and over well before this elapses.
const HOLD_MORPH_RETRACT_DURATION = 0.15
// Maps hold-timer progress to morph progress: the caret barely changes early in the hold, then grows
// quickly into the word as the long press is about to fire.
const HOLD_MORPH_EASE = easingFunctions["ease-in-expo"]
// Hold-timer progress at which the preview reaches full size. The last preview frame lands one or two
// frames before IK fires the long press, and ease-in-expo is steep there, so easing raw progress would
// leave the caret visibly short of the word when the real highlight takes over. Finishing 5% early is
// 40 ms of the default 800 ms hold: two frames at 60 fps, one at 30.
const HOLD_MORPH_FULL_AT = 0.95
// Duration of IK's cursor fade-out. The cursor's visual is switched off as the fade starts (see
// hideInteractorCursor), so the cursor's fade isn't seen; it brings IK's own alpha to zero, which lets the
// release fade the cursor back in. Its spring steps at a fixed 1/120 s and diverges for durations below
// about 0.063 s; this sits inside the stable range.
const CURSOR_HIDE_DURATION = 0.08
// Hold-drift threshold (cm) a caret drag sets on the interactable to stop IK's hold timer. IK resets the
// timer when the drift from the press exceeds the threshold, so any negative value resets it on the next
// tick; zero would still let a pointer resting exactly on its press point run the timer out.
const HOLD_TIMER_OFF_THRESHOLD = -1

const INTERNAL_COLLIDER_DEPTH = 0.1
const SCREEN_RECT_CORNERS: vec2[] = [new vec2(-1, -1), new vec2(-1, 1), new vec2(1, -1), new vec2(1, 1)]
const WHITESPACE_CHARACTER_REGEX = /\s/

type LogicalHandleType = "start" | "end"
type HighlightHandleDragEvent = {
  type: LogicalHandleType
  index: number
}
type HighlightCharRange = {
  start: number
  end: number
}
// Hold-to-select preview state, one per caret press (see TextManipulationModule.startHoldMorph).
type HoldMorphState = {
  interactor: Interactor
  wordStart: number
  wordEnd: number
  // Highlight color at press time, allocated once per press rather than once per frame.
  color: vec4
  // Word rect measurement. Starts as "retry" so the first update queries it; "none" ends the preview.
  measurement: MeasureRangeResult
  // Hold-timer progress, 0-1; runs back down while retracting.
  progress: number
  retracting: boolean
}

// A hold-drift threshold a caret drag overrode to stop IK's hold timer (see
// TextManipulationModule.stopHoldTimer), kept so endCaretPress can put it back.
type HoldTimerOverride = {
  interactable: Interactable
  // The interactable's own threshold before the override; null means it used the interactor's.
  threshold: number | null
  // The interactor whose press the override belongs to; only its press end puts the threshold back.
  interactor: Interactor
}

/**
 * Payload emitted by {@link TextManipulationModule.onTextUpdated} whenever the module
 * replaces text programmatically (e.g. paste, cut, delete-selection).
 *
 * Carrying the authoritative UTF-16 character indices alongside the new text lets
 * subscribers forward them to downstream sinks (e.g. the system keyboard) without
 * converting through cursor positions, which can be briefly stale while the Lens
 * `Text` component has not yet re-rendered the new string.
 */
export interface TextManipulationTextUpdate {
  /** The new text string. */
  text: string
  /** Caret position in UTF-16 character units, valid for `text`. */
  caretCharIndex: number
  /** Start of highlight in UTF-16 character units. Undefined when caret is collapsed. */
  highlightStartCharIndex?: number
  /** End of highlight in UTF-16 character units. Undefined when caret is collapsed. */
  highlightEndCharIndex?: number
}

export type TextGeometryRefreshReasons = {
  fromText?: boolean
  fromFont?: boolean
  fromFontSize?: boolean
  fromAnchors?: boolean
  fromTextOffset?: boolean
  fromAlignment?: boolean
  fromOverflow?: boolean
  updateTextLayout?: boolean
}

export interface TextManipulationRefreshReasons extends TextGeometryRefreshReasons {
  text?: string
  fromTextComponentBounds?: boolean
}

@component
export class TextManipulationModule extends BaseScriptComponent implements OpacityControllable {
  @input
  @allowUndefined
  @hint("The Text component to manipulate")
  private _textComponent: Text

  @input
  @allowUndefined
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Optional interaction target. If not provided, one is generated internally.</span>'
  )
  private _interactable: Interactable

  @ui.separator
  @input
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Controls caret visibility for editable text interactions</span>'
  )
  @hint("Whether the text can be edited")
  private _isEditable: boolean = false

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Color Properties</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Text manipulation visual colors</span>')
  @input("vec4", "{0.317006,0.450004,0.4,1}")
  @showIf("_isEditable", true)
  @hint("Color of the caret.")
  @widget(new ColorWidget())
  private _caretColor: vec4 = CARET_DEFAULT_COLOR

  @input("vec4", "{0.317998,0.450004,0.396002,0.4}")
  @hint("Color of selected text highlights.")
  @widget(new ColorWidget())
  private _highlightColor: vec4 = HighlightDefaultColor

  @input("vec4", "{0.333333,0.45098,0.396078,0.4}")
  @hint("Default color of selection grab handles.")
  @widget(new ColorWidget())
  private _grabHandleColor: vec4 = HANDLE_DEFAULT_COLOR

  @input("vec4", "{1,1,1,0.4}")
  @hint("Active hover and drag color of selection grab handles.")
  @widget(new ColorWidget())
  private _grabHandleActiveColor: vec4 = HANDLE_ACTIVE_COLOR

  private geometryResolver: TextGeometryResolver = null
  private caretRenderer: CaretRenderer = null
  private textHighlightTracker: TextHighlightTracker = null
  private leftHandle: GrabHandle = null
  private rightHandle: GrabHandle = null
  private highlightRenderer: HighlightRenderer = null
  private _leftHandleAnchorSide: HandleSide = "left"

  private _boundingBox: Rect | null = null
  private _cursorPositions: CursorPosition[] | null = null
  private _cursorHeight: number = 0
  private _pendingBoundingBoxUpdate: boolean = false
  private _pendingCursorPositionsUpdate: boolean = false

  private dragStartPosition: vec3 | null = null
  private _caretIndex: number = 0

  // The interactor whose press placed the caret, from trigger start until IK reports the trigger's
  // end or cancel. Its cursor stays hidden for the press so the caret, not the cursor, carries the
  // long-press feedback below.
  private caretPressInteractor: Interactor | null = null
  // The caret index the current press resolved to (from the collider hit, or the planecast for direct
  // pinch), the press's planecast point (the drag's delta origin), and whether a drag has since moved the
  // caret off that index. A drag starts from the press index and measures its delta from the press
  // planecast point, so a still hand keeps the caret where the press put it. The drag itself starts on the
  // press's second frame (enableInstantDrag), so drag start cannot be the hold-to-select cancel condition:
  // hand jitter would cancel every hold. Caret movement is. The flag is not reset on drag end or trigger
  // cancel, because IK dispatches TriggerCanceled (and so drag end) before SecondaryTriggerStart when a
  // long press takes over, and the long-press gate must still see it then; the next handled trigger start
  // and deactivation reset it.
  private pressCaretIndex: number | null = null
  private pressPlanecastPoint: vec3 | null = null
  private caretMovedDuringPress: boolean = false
  // Set while a caret drag keeps IK's hold timer stopped (see stopHoldTimer).
  private holdTimerOverride: HoldTimerOverride | null = null
  // The caret drag in progress, reset on each drag start (see TextGeometryResolver.getIndexFromDragPosition).
  private readonly caretDrag: TextDrag = {startIndex: 0, startPosition: null}
  // Hold-to-select preview: while a caret press holds on a word, the caret grows into that word's
  // highlight in step with IK's hold timer, and retracts if the hold is abandoned.
  private holdMorph: HoldMorphState | null = null
  private readonly holdMorphTarget: CaretMorphTarget = {centerX: 0, centerY: 0, width: 0, height: 0}
  private holdMorphUpdateEvent: UpdateEvent = null

  private _active: boolean = true
  private _opacity: number = 1
  private _renderOrder: number | null = null
  // Whether a Hierarchy-sorting Canvas governs the Text object our visuals live
  // under; null = not resolved yet. Decides flat orders vs fallback bumps, see
  // applyRenderOrders.
  private governedByCanvas: boolean | null = null
  private isTouchingHighlight: boolean = false

  private readonly hiddenInteractorCursors: Map<Interactor, InteractorCursor> = new Map()

  private caretUpdateEvent: UpdateEvent = null
  private _batchUpdateEvent: SceneEvent = null
  private isFlushingBatchedUpdates: boolean = false
  private _caretDirty: boolean = false
  private _highlightDirty: boolean = false
  // Handles released since the last rendered highlight, one flag per handle so two releases that land
  // in the same flush window both animate. Consumed by the batched flush so the release animation
  // still plays when the geometry query is deferred by the per-frame rate limit.
  private _pendingStartRelease: boolean = false
  private _pendingEndRelease: boolean = false
  private _lastHighlightText: string = ""
  private _textDirty: boolean = false
  private _text: string | undefined = undefined
  private _caretVisibilityDirty: boolean = false
  private _isCaretVisible: boolean = false
  // Authoritative logical caret position. `_caretIndex` is only its projection into the
  // currently rendered cursor geometry, which may be partial while native truncation is active.
  private _caretCharIndex: number = 0
  private _pendingCaretGeometrySync: boolean = false
  // Authoritative logical selection. TextHighlightTracker stores only its disposable projection
  // into the current cursor geometry, which may still describe truncated text.
  private _highlightCharRange: HighlightCharRange | null = null
  private _pendingHighlightGeometrySync: boolean = false
  // Some native overflow modes intentionally expose only the visible cursor subset. In that mode,
  // nearest-cursor projection is terminal rather than a stale snapshot that can become complete.
  private _cursorGeometryMayRemainPartial: boolean = false
  private _blinkResetPending: boolean = false
  private _pendingBlinkState: "pause" | "resume" | null = null

  private initialized: boolean = false
  private destroyed: boolean = false
  private textComponentUnsubscribes: (() => void)[] = []
  private interactableUnsubscribes: (() => void)[] = []
  private internalColliderObject: SceneObject | null = null
  private internalCollider: ColliderComponent | null = null
  private internalColliderShape: BoxShape | null = null
  private internalInteractable: Interactable | null = null
  private readonly internalColliderSize: vec3 = vec3.zero()
  private readonly internalColliderPosition: vec3 = vec3.zero()

  private readonly onCursorPositionsUpdatedEvent: ReplayEvent<CursorPosition[]> = new ReplayEvent<CursorPosition[]>()
  /**
   * Event replaying the latest cursor position list whenever text geometry is refreshed.
   */
  public readonly onCursorPositionsUpdated = this.onCursorPositionsUpdatedEvent.publicApi()
  private readonly onTextBoundingBoxUpdatedEvent: ReplayEvent<Rect> = new ReplayEvent<Rect>()
  /**
   * Event replaying the latest text bounding box whenever the Text component bounds are refreshed.
   */
  public readonly onTextBoundingBoxUpdated = this.onTextBoundingBoxUpdatedEvent.publicApi()
  private readonly onCursorHeightUpdatedEvent: ReplayEvent<number> = new ReplayEvent<number>()
  /**
   * Event replaying the latest cursor height whenever font metrics are refreshed.
   */
  public readonly onCursorHeightUpdated = this.onCursorHeightUpdatedEvent.publicApi()
  private readonly onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()
  /**
   * Event replayed after the module has created its caret, highlight, and interaction dependencies.
   */
  public readonly onInitialized = this.onInitializedEvent.publicApi()

  private readonly onTextUpdatedEvent: Event<TextManipulationTextUpdate> = new Event<TextManipulationTextUpdate>()
  /**
   * Event fired when the module changes text through selection actions such as paste or cut.
   */
  public readonly onTextUpdated = this.onTextUpdatedEvent.publicApi()
  private readonly onCaretIndexChangedEvent: Event<number> = new Event<number>()
  /**
   * Event fired when the caret cursor index changes.
   */
  public readonly onCaretIndexChanged = this.onCaretIndexChangedEvent.publicApi()
  private readonly onHighlightUpdatedEvent: Event<string> = new Event<string>()
  /**
   * Event fired when highlighted text changes. Emits an empty string when highlighting clears.
   */
  public readonly onHighlightUpdated = this.onHighlightUpdatedEvent.publicApi()

  // Internal events
  private readonly onCaretDraggedEvent: Event<number> = new Event<number>()
  /**
   * Event fired while dragging the caret. The payload is the current cursor index.
   */
  public readonly onCaretDragged = this.onCaretDraggedEvent.publicApi()
  private readonly dragEventPayload: HighlightHandleDragEvent = {type: "start", index: 0}
  private readonly onHighlightHandleDraggedEvent: Event<HighlightHandleDragEvent> =
    new Event<HighlightHandleDragEvent>()
  /**
   * Event fired while dragging a highlight handle, including the logical handle side and cursor index.
   */
  public readonly onHighlightHandleDragged = this.onHighlightHandleDraggedEvent.publicApi()

  /**
   * Gets whether text manipulation visuals and interactions are active.
   * @returns `true` when caret, highlight, and interaction updates are enabled.
   */
  public get active(): boolean {
    return this._active
  }

  /**
   * Sets whether text manipulation visuals and interactions are active.
   * Disabling this synchronously hides the caret, highlight, and grab-handle interactions while
   * retaining the existing batched logical highlight cleanup after initialization.
   * @param active - `true` to enable text manipulation, `false` to disable it.
   */
  public set active(active: boolean) {
    if (this._active === active) {
      if (!active && this.initialized) {
        // Reassert the synchronous inactive invariant after a parent/host lifecycle transition.
        this.hideInactiveVisualsImmediately()
      }
      return
    }

    this._active = active
    if (this.initialized) {
      this.applyActiveVisualState()
    }
  }

  /**
   * Opacity multiplier applied to caret, highlight, and grab handle visuals.
   */
  public get opacity(): number {
    return this._opacity
  }

  /**
   * @param opacity - Opacity multiplier. Values are intentionally not clamped.
   * @see opacity
   */
  public set opacity(opacity: number) {
    if (opacity === undefined) return

    this._opacity = opacity
    this.applyOpacityToVisuals()
  }

  /**
   * Sets the base render order for every text-manipulation visual. Under a
   * Hierarchy-sorting Canvas they all share it flat and layer by tree order;
   * without one the caret and handles take small bumps (see applyRenderOrders).
   */
  public setRenderOrder(renderOrder: number): void {
    if (renderOrder === undefined) return

    this._renderOrder = renderOrder
    this.applyRenderOrders()
  }

  /**
   * Re-resolves whether a Canvas governs the manipulated Text's SceneObject and
   * re-applies render orders. Call after reparenting the text or its host, or
   * changing ancestor Canvas topology through raw Lens APIs. Hosts on the
   * batched-canvas pattern (BaseTextInputComponent) forward this after their
   * own reconcile; an enable cycle covers itself. Same duck-typed protocol
   * ScrollWindow walks over reparented subtrees — note that walk finds this hook
   * on the MODULE's object, so a standalone module on a sibling of its Text is
   * not reached when only the Text's subtree moves; the cached answer then stays
   * stale until this is called. Hosted modules are covered by the host's forward.
   */
  public invalidateCanvasBinding(): void {
    this.governedByCanvas = null
    if (this.initialized) {
      this.applyRenderOrders()
    }
  }

  /**
   * The one place that decides the draw order of the highlight layer, caret and
   * grab handles — all children of the manipulated Text's SceneObject. The
   * constructors seed a flat order so no visual is ever unset; this overrides it
   * right away. Under a Hierarchy-sorting Canvas (every BaseTextInputComponent
   * host, DatePicker's field labels) every visual shares the base order flat and
   * layers by tree order — highlight layer, then caret, then handles
   * (GrabHandle.moveToForeground keeps that after a lazily created caret); a
   * non-zero bump would outrank the Canvas and punch through sibling chrome.
   * Without a governing Canvas, equal-order blended quads distance-sort, so the
   * caret (+1) and handles (+2) keep bumps as the fallback — the same shape as
   * ElementContent's content render-order fallback. The Canvas lookup is cached
   * until `invalidateCanvasBinding()` or a `textComponent` change.
   */
  private applyRenderOrders(): void {
    if (!this._textComponent || isNull(this._textComponent)) return
    const base = this._renderOrder ?? this._textComponent.getRenderOrder()
    if (this.governedByCanvas === null) {
      this.governedByCanvas = findGoverningCanvas(this._textComponent.getSceneObject()) !== null
    }
    const caretOrder = this.governedByCanvas ? base : base + 1
    const handleOrder = this.governedByCanvas ? base : base + 2
    if (this.highlightRenderer) {
      this.highlightRenderer.renderOrder = base
    }
    if (this.caretRenderer) {
      this.caretRenderer.renderOrder = caretOrder
    }
    if (this.leftHandle) {
      this.leftHandle.renderOrder = handleOrder
    }
    if (this.rightHandle) {
      this.rightHandle.renderOrder = handleOrder
    }
  }

  /**
   * Gets the Text component whose geometry and content this module manipulates.
   * @returns The bound Text component.
   */
  public get textComponent(): Text {
    return this._textComponent
  }

  /**
   * Sets the Text component whose geometry and content this module manipulates.
   * Rebinds geometry, collider, caret, and highlight dependencies after initialization.
   * @param textComponent - The Text component to manipulate.
   * @throws If `textComponent` is null or undefined.
   */
  public set textComponent(textComponent: Text) {
    if (!textComponent) {
      throw new Error(`TextManipulationModule textComponent cannot be null or undefined on ${this.sceneObject.name}`)
    }
    if (this._textComponent === textComponent) return

    this._textComponent = textComponent
    // The governing Canvas is resolved against the Text's SceneObject, which just changed.
    this.governedByCanvas = null
    if (this.initialized) {
      const usingInternalInteractable = this._interactable === this.internalInteractable
      if (usingInternalInteractable) {
        this.syncInternalColliderParent()
        this.updateInternalCollider()
      }
      this.onTextComponentSet()
    }
  }

  /**
   * Gets the interaction target used for text gestures.
   * @returns The configured Interactable, or the internally generated one after initialization.
   */
  public get interactable(): Interactable {
    return this._interactable
  }

  /**
   * Sets the interaction target used for text gestures.
   * Replaces the internally generated interactable when a custom target is provided. A custom target keeps
   * its own targeting mode and drag settings; the internal one targets all modes and drags instantly.
   * @param interactable - The Interactable that should receive text manipulation gestures.
   */
  public set interactable(interactable: Interactable) {
    if (!interactable) return
    if (this._interactable === interactable) return

    if (this.initialized) {
      const replacingInternalInteractable = this.internalInteractable && interactable !== this.internalInteractable
      if (replacingInternalInteractable) {
        this.releaseInteractableDependencies()
        this.destroyInternalInteractable()
      }
    }

    this._interactable = interactable
    if (this.initialized) {
      this.onInteractableSet()
    }
  }

  /**
   * Gets whether editing-only visuals such as the caret are enabled.
   * @returns `true` when caret rendering and edit interactions are allowed.
   */
  public get isEditable(): boolean {
    return this._isEditable
  }

  /**
   * Sets whether editing-only visuals such as the caret are enabled.
   * Enabling this after initialization creates the caret renderer when dependencies are ready.
   * @param isEditable - `true` to enable editable caret behavior.
   */
  public set isEditable(isEditable: boolean) {
    if (this._isEditable === isEditable) return

    this._isEditable = isEditable
    if (this.initialized) {
      if (!this.areTextDependenciesReady()) return
      if (this._isEditable) {
        this.ensureCaretRenderer()
      }
      if (this._active && this._isEditable) {
        this.showCaret()
      } else {
        this.hideCaret()
      }
    }
  }

  /**
   * Gets the caret visual color.
   * @returns The caret color as an RGBA vector.
   */
  public get caretColor(): vec4 {
    return this._caretColor
  }

  /**
   * Sets the caret visual color and applies it to the active caret renderer.
   * @param color - The new caret color as an RGBA vector.
   */
  public set caretColor(color: vec4) {
    if (color === undefined) return

    this._caretColor = color
    if (this.caretRenderer) {
      this.caretRenderer.color = this.getOpacityAdjustedColor(color)
    }
  }

  /**
   * Gets the selected-text highlight color.
   * @returns The highlight color as an RGBA vector.
   */
  public get highlightColor(): vec4 {
    return this._highlightColor
  }

  /**
   * Sets the selected-text highlight color and applies it to the active highlight renderer.
   * @param color - The new highlight color as an RGBA vector.
   */
  public set highlightColor(color: vec4) {
    if (color === undefined) return

    this._highlightColor = color
    if (this.highlightRenderer) {
      this.highlightRenderer.color = this.getOpacityAdjustedColor(color)
    }
  }

  /**
   * Gets the default selection grab handle color.
   * @returns The inactive grab handle color as an RGBA vector.
   */
  public get grabHandleColor(): vec4 {
    return this._grabHandleColor
  }

  /**
   * Sets the default selection grab handle color.
   * @param color - The inactive grab handle color as an RGBA vector.
   */
  public set grabHandleColor(color: vec4) {
    if (color === undefined) return

    this._grabHandleColor = color
    this.applyGrabHandleColors()
  }

  /**
   * Gets the active hover and drag color for selection grab handles.
   * @returns The active grab handle color as an RGBA vector.
   */
  public get grabHandleActiveColor(): vec4 {
    return this._grabHandleActiveColor
  }

  /**
   * Sets the active hover and drag color for selection grab handles.
   * @param color - The active grab handle color as an RGBA vector.
   */
  public set grabHandleActiveColor(color: vec4) {
    if (color === undefined) return

    this._grabHandleActiveColor = color
    this.applyGrabHandleColors()
  }

  /**
   * Gets the current caret position in Text cursor-position units.
   * @returns The current caret cursor index.
   */
  public get caretIndex(): number {
    return this._caretIndex
  }

  /**
   * Sets the current caret position in Text cursor-position units.
   * The value is clamped to the available cursor positions before the caret is marked dirty.
   * @param index - The desired caret cursor index.
   */
  public set caretIndex(index: number) {
    const newCaretIndex = this.getClampedCaretIndex(index)
    const resolvedCaretCharIndex = getUtf16IndexFromCursorIndex(newCaretIndex, this.cursorPositions, this._text ?? "")
    // Cursor geometry can temporarily describe an older string. Clamp its UTF-16 payload against
    // the authoritative text; with no geometry, rendered cursor zero still means logical zero.
    const newCaretCharIndex = this.getClampedCaretCharIndex(resolvedCaretCharIndex ?? 0)
    const caretGeometryNeedsSync = resolvedCaretCharIndex !== undefined && resolvedCaretCharIndex !== newCaretCharIndex
    const caretIndexChanged = this._caretIndex !== newCaretIndex
    const caretCharIndexChanged = this._caretCharIndex !== newCaretCharIndex

    if (caretIndexChanged) {
      this._caretIndex = newCaretIndex
    }
    this._caretCharIndex = newCaretCharIndex
    this._pendingCaretGeometrySync = caretGeometryNeedsSync
    if (caretIndexChanged || caretCharIndexChanged) {
      this.markCaretDirty()
    } else if (caretGeometryNeedsSync) {
      this.batchUpdate()
    }
  }

  /**
   * Gets the caret position in UTF-16 character units for the current text.
   * @returns The authoritative caret character index.
   */
  public get caretCharIndex(): number {
    return this._caretCharIndex
  }

  /**
   * Gets whether any text is currently highlighted.
   * @returns `true` when a non-empty highlight range is active.
   */
  public get isHighlighted(): boolean {
    return this._highlightCharRange !== null
  }

  /**
   * Gets the highlight start in UTF-16 character units.
   * @returns The highlighted range start, or undefined when there is no highlight.
   */
  public get highlightStartCharIndex(): number | undefined {
    return this._highlightCharRange?.start
  }

  /**
   * Gets the highlight end in UTF-16 character units.
   * @returns The highlighted range end, or undefined when there is no highlight.
   */
  public get highlightEndCharIndex(): number | undefined {
    return this._highlightCharRange?.end
  }

  /**
   * Gets the most recently measured text bounding box.
   * @returns The cached text bounds, or null before measurement succeeds.
   */
  public get boundingBox(): Rect | null {
    return this._boundingBox
  }

  /**
   * Gets whether a rate-limited Text bounding-box query still needs to be retried.
   * @internal Used by text-input layout to avoid acting on stale measured bounds.
   */
  public get isBoundingBoxUpdatePending(): boolean {
    return this._pendingBoundingBoxUpdate
  }

  /**
   * Gets the most recently measured Text cursor positions.
   * @returns The cached cursor position array, or null before measurement succeeds.
   */
  public get cursorPositions(): CursorPosition[] | null {
    return this._cursorPositions
  }

  /**
   * Configures whether native cursor geometry is intentionally limited to visible text.
   * @internal Text-input overflow implementations use this to prevent impossible geometry retries.
   */
  public setCursorGeometryMayRemainPartial(mayRemainPartial: boolean): void {
    if (this._cursorGeometryMayRemainPartial === mayRemainPartial) return

    this._cursorGeometryMayRemainPartial = mayRemainPartial
    if (this._pendingCaretGeometrySync || this._pendingHighlightGeometrySync) {
      this.batchUpdate()
    }
  }

  /**
   * Gets the most recently measured cursor height.
   * @returns The cached cursor height.
   */
  public get cursorHeight(): number {
    return this._cursorHeight
  }

  /**
   * Highlights all editable text.
   * @returns `true` if the highlight was applied.
   */
  public setHighlightAll(): boolean {
    if (!this._active) return false
    if (!this.textHighlightTracker) return false
    return this.setHighlightByCharIndex(0, this._text.length)
  }

  /**
   * Highlights a range of text using UTF-16 character indices.
   * Passing equal indices clears the current highlight and moves the caret to that index.
   * @param startCharIndex - Inclusive highlight start in UTF-16 character units.
   * @param endCharIndex - Exclusive highlight end in UTF-16 character units.
   * @returns `true` if the highlight state was updated.
   */
  public setHighlightByCharIndex(startCharIndex: number, endCharIndex: number): boolean {
    if (!this._active) return false
    if (!this.textHighlightTracker) return false

    if (startCharIndex === endCharIndex) {
      this.clearHighlight()
      this.showCaret()
      const newCaretCharIndex = this.getClampedCaretCharIndex(startCharIndex)
      const caretCharIndexChanged = this._caretCharIndex !== newCaretCharIndex
      this._caretCharIndex = newCaretCharIndex
      this._pendingCaretGeometrySync = true
      if (caretCharIndexChanged) {
        this.markCaretDirty()
      } else {
        this.batchUpdate()
      }
      return true
    }

    const rangeStart = Math.min(startCharIndex, endCharIndex)
    const rangeEnd = Math.max(startCharIndex, endCharIndex)
    const clampedStart = this.getClampedHighlightCharIndex(rangeStart, true)
    const clampedEnd = this.getClampedHighlightCharIndex(rangeEnd, false)
    if (clampedStart === clampedEnd) {
      return this.setHighlightByCharIndex(clampedEnd, clampedEnd)
    }

    this._highlightCharRange = {start: clampedStart, end: clampedEnd}
    this._pendingHighlightGeometrySync = true
    this.hideCaret()
    this.markHighlightDirty()
    return true
  }

  // For Copying
  /**
   * Gets the currently highlighted text.
   * @returns The highlighted substring, or an empty string when no text is highlighted.
   */
  public getHighlightedText(): string {
    if (!this._active) return ""
    const range = this._highlightCharRange
    if (!range) return ""

    return this._text.substring(range.start, range.end)
  }

  // For Cutting
  /**
   * Removes the currently highlighted text.
   * @returns `true` if highlighted text was removed.
   */
  public removeHighlightedText(): boolean {
    if (!this._active) return false
    return this.replaceHighlightedText("")
  }

  // For Pasting
  /**
   * Replaces the highlighted text, or inserts at the caret when there is no highlight.
   * @param textToPaste - The text to insert.
   * @returns `true` if the text replacement was staged.
   */
  public replaceHighlightedText(textToPaste: string): boolean {
    if (!this._active) return false
    if (!this.textHighlightTracker) return false

    let newText: string
    let newCaretCharPos: number

    const highlightRange = this._highlightCharRange
    if (highlightRange) {
      // Logical selection remains exact even while its rendered cursor projection is pending.
      newText = this._text.slice(0, highlightRange.start) + textToPaste + this._text.slice(highlightRange.end)
      newCaretCharPos = highlightRange.start + textToPaste.length
      this.clearHighlight()
    } else {
      // Insert using the authoritative logical position. Rendered cursor geometry may still
      // describe only the inactive, truncated text during synchronous edit-entry callbacks.
      const charIndex = this.caretCharIndex
      newText = this._text.slice(0, charIndex) + textToPaste + this._text.slice(charIndex)
      newCaretCharPos = charIndex + textToPaste.length
    }

    // Trim whitespace from each line (Text component doesn't support cursor positions for them)
    const trimmed = trimLinesWithCaretAdjustment(newText, newCaretCharPos)
    this.updateText(trimmed.text, trimmed.charPos)
    if (this._isEditable) {
      this.showCaret()
    }

    return true
  }

  /**
   * Refreshes the cached text bounding box from the Text component.
   * This is intended for internal text input geometry maintenance.
   * If Lens Studio rate-limits the query, the update is retried in the next batch flush.
   */
  public updateBoundingBox() {
    if (!this._textComponent) return

    let boundingBox: Rect
    try {
      boundingBox = this._textComponent.getBoundingBox()
    } catch {
      // getBoundingBox has a per-frame rate limit; retry next batch flush.
      this.requestBoundingBoxUpdate()
      return
    }

    this._pendingBoundingBoxUpdate = false
    this.boundingBox = boundingBox
  }

  /**
   * Refreshes cached cursor positions from the Text component.
   * This is intended for internal text input geometry maintenance.
   * If Lens Studio rate-limits the query, the update is retried in the next batch flush.
   */
  public updateCursorPositions() {
    if (!this._textComponent) return

    let cursorPositions: CursorPosition[]
    try {
      cursorPositions = this._textComponent.getCursorPositions()
    } catch {
      // getCursorPositions has a per-frame rate limit; retry next batch flush.
      this.requestCursorPositionsUpdate()
      return
    }

    this.cursorPositions = cursorPositions
  }

  /**
   * Refreshes the cached cursor height from the Text component.
   * This is intended for internal text input geometry maintenance.
   */
  public updateCursorHeight() {
    if (!this._textComponent) return

    this.cursorHeight = this._textComponent.getCursorHeight()
  }

  private requestBoundingBoxUpdate(): void {
    this._pendingBoundingBoxUpdate = true
    this.batchUpdate()
  }

  private requestCursorPositionsUpdate(): void {
    this._pendingCursorPositionsUpdate = true
    this.batchUpdate()
  }

  /**
   * Refreshes text manipulation geometry and visual state for the supplied change reasons.
   * @param reasons - Flags describing which text, layout, font, or bounds changes occurred.
   */
  public refresh(reasons: TextManipulationRefreshReasons): void {
    let textChanged = false
    if (reasons.text !== undefined) {
      textChanged = reasons.text !== this._text
      this._text = reasons.text
      const clampedCaretCharIndex = this.getClampedCaretCharIndex(this._caretCharIndex)
      if (this._caretCharIndex !== clampedCaretCharIndex) {
        this._caretCharIndex = clampedCaretCharIndex
        this.markCaretDirty()
      }
      this._pendingCaretGeometrySync = true
    }

    if (textChanged && this.isHighlighted) {
      this.clearHighlight()
      this.showCaret()
    }

    if (reasons.fromTextComponentBounds === true) {
      this.updateInternalCollider()
    }

    if (!this.areTextDependenciesReady()) {
      return
    }

    let shouldUpdateBoundingBox = false
    let shouldUpdateCursorPositions = false
    let shouldUpdateCursorHeight = false

    if (reasons.text !== undefined) {
      shouldUpdateBoundingBox = true
      shouldUpdateCursorPositions = true
    }

    if (reasons.fromText === true) {
      shouldUpdateBoundingBox = true
      shouldUpdateCursorPositions = true
    }

    if (reasons.fromFont === true || reasons.fromFontSize === true) {
      shouldUpdateCursorHeight = true
      shouldUpdateBoundingBox = true
      shouldUpdateCursorPositions = true
    }

    if (reasons.fromAnchors === true || reasons.fromAlignment === true || reasons.fromOverflow === true) {
      shouldUpdateBoundingBox = true
      shouldUpdateCursorPositions = true
    }

    if (reasons.fromTextOffset === true) {
      shouldUpdateCursorPositions = true
    }

    if (shouldUpdateCursorHeight) {
      this.updateCursorHeight()
    }
    if (shouldUpdateBoundingBox) {
      this.updateBoundingBox()
    }
    if (shouldUpdateCursorPositions) {
      this.requestCursorPositionsUpdate()
    }
  }

  /**
   * Sets up Lens lifecycle events for initialization, destruction, caret updates, and batch flushing.
   */
  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.initialize())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
    // Reparenting fires no event of its own; the enable that usually follows
    // it is where the governing-Canvas answer gets re-resolved.
    this.createEvent("OnEnableEvent").bind(() => this.invalidateCanvasBinding())

    this.caretUpdateEvent = this.createEvent("UpdateEvent")
    this.caretUpdateEvent.enabled = false

    this.holdMorphUpdateEvent = this.createEvent("UpdateEvent")
    this.holdMorphUpdateEvent.enabled = false
    this.holdMorphUpdateEvent.bind(() => this.updateHoldMorph())

    this._batchUpdateEvent = this.createEvent("LateUpdateEvent")
    this._batchUpdateEvent.enabled = false
    this._batchUpdateEvent.bind(() => this.flushBatchedUpdates())
  }

  private initialize(): void {
    if (this.initialized || this.destroyed) return

    this.validateTextComponent()
    this.ensureInteractable()

    this.onTextComponentSet()
    this.onInteractableSet()
    this.initialized = true
    this.onInitializedEvent.invoke()
  }

  private onDestroy(): void {
    if (this.destroyed) return

    this.destroyed = true
    this.initialized = false
    this.releaseInteractableDependencies()
    this.destroyInternalInteractable()
    this.releaseTextComponentDependencies()

    if (this._batchUpdateEvent) {
      this._batchUpdateEvent.enabled = false
    }
    if (this.holdMorphUpdateEvent) {
      this.holdMorphUpdateEvent.enabled = false
    }
    if (this.caretUpdateEvent) {
      this.caretUpdateEvent.enabled = false
    }
  }

  private onTextComponentSet(): void {
    this.releaseTextComponentDependencies()

    if (!this._textComponent || !this.caretUpdateEvent) return

    this.geometryResolver = new TextGeometryResolver(
      this._textComponent,
      this.onCursorPositionsUpdated,
      this.onCursorHeightUpdated
    )
    this.textHighlightTracker = new TextHighlightTracker(this._textComponent, this.onCursorPositionsUpdated)

    this.governedByCanvas = null
    const renderOrder = this._renderOrder ?? this._textComponent.getRenderOrder()
    const parent = this._textComponent.getSceneObject()

    // Creation order here IS the draw order under the host's Hierarchy Canvas:
    // the highlight layer first (lazy pool growth stays inside it, behind the
    // rest), then the caret, then the handles. The constructors only seed a flat
    // order so no visual is ever unset; applyRenderOrders() below is the one place
    // that decides the final orders (flat vs. the no-Canvas fallback bumps).
    this.highlightRenderer = new HighlightRenderer(
      this._textComponent,
      this.onCursorPositionsUpdated,
      this.getOpacityAdjustedColor(this._highlightColor)
    )

    if (this._isEditable) {
      this.ensureCaretRenderer()
    }

    this.leftHandle = new GrabHandle(
      parent,
      renderOrder,
      "left",
      this.getOpacityAdjustedColor(this._grabHandleColor),
      this.getOpacityAdjustedColor(this._grabHandleActiveColor)
    )
    this.rightHandle = new GrabHandle(
      parent,
      renderOrder,
      "right",
      this.getOpacityAdjustedColor(this._grabHandleColor),
      this.getOpacityAdjustedColor(this._grabHandleActiveColor)
    )
    this.applyRenderOrders()

    this.setupHighlightHandlesDragEvents()

    // Fallback for standalone use only; rendered text may be placeholder or masked display text.
    if (this._text === undefined) {
      this._text = this._textComponent.text
    }

    this.updateBoundingBox()
    this.updateCursorPositions()
    this.updateCursorHeight()

    this.applyActiveVisualState()
  }

  private ensureCaretRenderer(): void {
    if (this.caretRenderer || !this._textComponent || !this.caretUpdateEvent) return

    this.caretRenderer = new CaretRenderer(
      this._textComponent,
      this.caretUpdateEvent,
      this.onCursorPositionsUpdated,
      this.onCursorHeightUpdated,
      this.getOpacityAdjustedColor(this._caretColor)
    )
    this.caretRenderer.updatePosition(this._caretIndex)
    this.applyRenderOrders()
    this.leftHandle?.moveToForeground()
    this.rightHandle?.moveToForeground()
  }

  private onInteractableSet(): void {
    this.releaseInteractableDependencies()

    const interactable = this._interactable
    if (!interactable) return

    this.interactableUnsubscribes.push(
      interactable.onTriggerStart.add((event) => {
        if (event.target !== interactable) return
        if (this._active) {
          this.handleTriggerDown(event)
        }
      }),
      interactable.onTriggerEnd.add((event) => {
        if (event.target !== interactable) return
        this.endCaretPress(event.interactor)
        if (this._active) {
          this.handleTriggerUp()
        }
      }),
      interactable.onTriggerEndOutside.add((event) => {
        if (event.target !== interactable) return
        this.endCaretPress(event.interactor)
        if (this._active) {
          this.handleTriggerUp()
        }
      }),
      interactable.onTriggerCanceled.add((event) => {
        if (event.target !== interactable) return
        // Also fires when a long press takes over the trigger, which ends the caret press.
        this.endCaretPress(event.interactor)
        if (this._active && this.caretRenderer) {
          this.caretRenderer.setDragState(false)
        }
      }),
      interactable.onDragStart.add((event) => {
        if (event.target !== interactable) return
        if (this._active && !this.isHighlighted) {
          this.handleDragStart(event)
        }
      }),
      interactable.onDragUpdate.add((event) => {
        if (event.target !== interactable) return
        if (this._active && !this.isHighlighted) {
          this.handleDragUpdate(event)
        }
      }),
      interactable.onDragEnd.add((event) => {
        if (event.target !== interactable) return
        if (this._active) {
          this.handleDragEnd()
          this.restoreInteractorCursor(event.interactor)
        }
      }),
      interactable.onSecondaryTriggerStart.add((event) => {
        if (event.target !== interactable) return
        // A press whose caret has moved is a caret drag, not a hold; drag start alone does not qualify.
        // Once the caret moves, stopHoldTimer keeps the dragging interactor's long press from firing. This
        // guard is the fallback for another interactor's hold that runs out in the frame the caret first
        // moves: IK ticks every hold timer before it dispatches that frame's drag updates.
        if (this.caretMovedDuringPress) return
        if (this._active) {
          this.handleLongPress()
        }
      })
    )
  }

  private applyActiveVisualState(): void {
    if (this._active) {
      this.showCaret()
    } else {
      // Keep the existing batched logical cleanup, but hide every independent renderer and handle
      // SceneObject now. The ancestor mask may be disabled immediately after this setter returns.
      this.hideCaret()
      this.clearHighlight()
      this.hideInactiveVisualsImmediately()
    }
  }

  private hideInactiveVisualsImmediately(): void {
    this.dragStartPosition = null
    // A press that starts while inactive skips handleTriggerDown, so clear the press state here or a drag
    // that begins once focus lands mid-press would anchor at the previous session's press point.
    this.pressCaretIndex = null
    this.pressPlanecastPoint = null
    this.caretMovedDuringPress = false
    this.isTouchingHighlight = false
    this._blinkResetPending = false
    this._pendingBlinkState = null
    if (this.caretRenderer) {
      this.caretRenderer.setDragState(false)
      this.caretRenderer.hide()
    }
    if (this.highlightRenderer) {
      this.highlightRenderer.hide()
    }
    this.hideHandles()
    this.stopHoldMorph()
    this.endCaretPress()
  }

  private releaseTextComponentDependencies(): void {
    this.textComponentUnsubscribes.forEach((unsub) => unsub())
    this.textComponentUnsubscribes = []

    this.stopHoldMorph()
    this.endCaretPress()

    if (this.geometryResolver) {
      this.geometryResolver.destroy()
      this.geometryResolver = null
    }
    if (this.textHighlightTracker) {
      this.textHighlightTracker.destroy()
      this.textHighlightTracker = null
    }
    if (this.caretRenderer) {
      this.caretRenderer.destroy()
      this.caretRenderer = null
    }
    if (this.leftHandle) {
      this.leftHandle.destroy()
      this.leftHandle = null
    }
    if (this.rightHandle) {
      this.rightHandle.destroy()
      this.rightHandle = null
    }
    if (this.highlightRenderer) {
      this.highlightRenderer.destroy()
      this.highlightRenderer = null
    }

    this.dragStartPosition = null
    this.isTouchingHighlight = false
    this._boundingBox = null
    this._cursorPositions = null
    this._cursorHeight = 0
    this._pendingBoundingBoxUpdate = false
    this._pendingCursorPositionsUpdate = false
    this._pendingCaretGeometrySync = false
    this._highlightCharRange = null
    this._pendingHighlightGeometrySync = false
    this._cursorGeometryMayRemainPartial = false
    this._caretVisibilityDirty = false
    this._isCaretVisible = false
    this._caretDirty = false
    this._highlightDirty = false
    this._blinkResetPending = false
    this._pendingBlinkState = null
    this._lastHighlightText = ""
    this.resetHandleAnchorSides()
  }

  private releaseInteractableDependencies(): void {
    this.interactableUnsubscribes.forEach((unsub) => unsub())
    this.interactableUnsubscribes = []
    this.dragStartPosition = null
    this.endCaretPress()
  }

  private validateTextComponent(): void {
    if (!this._textComponent) {
      throw new Error(`TextManipulationModule missing textComponent on ${this.sceneObject.name}`)
    }
  }

  private ensureInteractable(): void {
    if (this._interactable || !this._textComponent) return

    this.ensureInternalInteractable()
  }

  private ensureInternalInteractable(): void {
    if (!this._textComponent) return

    if (!this.internalColliderObject || isNull(this.internalColliderObject)) {
      this.internalColliderObject = global.scene.createSceneObject("TextManipulationInternalCollider")
      this.syncInternalColliderParent()

      this.internalCollider = this.internalColliderObject.createComponent("Physics.ColliderComponent")
      this.internalColliderShape = Shape.createBoxShape()
      this.internalCollider.shape = this.internalColliderShape
      this.internalCollider.intangible = false
      this.internalCollider.fitVisual = false
      this.internalCollider.debugDrawEnabled = false

      this.internalInteractable = this.internalColliderObject.createComponent(
        Interactable.getTypeName()
      ) as Interactable
      this.internalInteractable.targetingMode = TargetingMode.All
      // Drag from the press's second frame: most intended caret moves are shorter than IK's drag
      // threshold. Hold-to-select uses caret movement, not drag start, as its cancel condition.
      this.internalInteractable.enableInstantDrag = true
      this.internalInteractable.colliders = [this.internalCollider]
    } else {
      this.syncInternalColliderParent()
    }

    this.updateInternalCollider()
    this._interactable = this.internalInteractable
  }

  private syncInternalColliderParent(): void {
    if (!this._textComponent || !this.internalColliderObject || isNull(this.internalColliderObject)) {
      return
    }

    const textSceneObject = this._textComponent.getSceneObject()
    this.internalColliderObject.layer = textSceneObject.layer
    if (this.internalColliderObject.getParent() !== textSceneObject) {
      this.internalColliderObject.setParent(textSceneObject)
    }
  }

  private updateInternalCollider(): void {
    if (
      !this._textComponent ||
      !this.internalColliderObject ||
      !this.internalCollider ||
      !this.internalColliderShape ||
      isNull(this.internalColliderObject)
    ) {
      return
    }

    const textSceneObject = this._textComponent.getSceneObject()
    const textTransform = textSceneObject.getTransform()
    const screenTransform = textSceneObject.getComponent("ScreenTransform")

    if (screenTransform) {
      this.updateInternalColliderFromScreenTransform(screenTransform, textTransform)
      return
    }

    const worldScale = textTransform.getWorldScale()
    if (worldScale.x === 0 || worldScale.y === 0) {
      this.internalColliderSize.x = 0
      this.internalColliderSize.y = 0
      this.internalColliderSize.z = INTERNAL_COLLIDER_DEPTH

      this.internalColliderPosition.x = 0
      this.internalColliderPosition.y = 0
      this.internalColliderPosition.z = 0

      this.applyInternalColliderBounds()
      return
    }

    const rect = this._textComponent.layoutRect
    if (!rect) return

    this.internalColliderSize.x = Math.abs(rect.right - rect.left) / Math.abs(worldScale.x)
    this.internalColliderSize.y = Math.abs(rect.top - rect.bottom) / Math.abs(worldScale.y)
    this.internalColliderSize.z = INTERNAL_COLLIDER_DEPTH

    this.internalColliderPosition.x = (rect.left + rect.right) / 2 / worldScale.x
    this.internalColliderPosition.y = (rect.top + rect.bottom) / 2 / worldScale.y
    this.internalColliderPosition.z = 0

    this.applyInternalColliderBounds()
  }

  private updateInternalColliderFromScreenTransform(screenTransform: ScreenTransform, textTransform: Transform): void {
    const worldToLocal = textTransform.getInvertedWorldTransform()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const corner of SCREEN_RECT_CORNERS) {
      const localCorner = worldToLocal.multiplyPoint(screenTransform.localPointToWorldPoint(corner))
      minX = Math.min(minX, localCorner.x)
      minY = Math.min(minY, localCorner.y)
      maxX = Math.max(maxX, localCorner.x)
      maxY = Math.max(maxY, localCorner.y)
    }

    this.internalColliderSize.x = maxX - minX
    this.internalColliderSize.y = maxY - minY
    this.internalColliderSize.z = INTERNAL_COLLIDER_DEPTH

    this.internalColliderPosition.x = minX + this.internalColliderSize.x / 2
    this.internalColliderPosition.y = minY + this.internalColliderSize.y / 2
    this.internalColliderPosition.z = 0

    this.applyInternalColliderBounds()
  }

  private applyInternalColliderBounds(): void {
    if (!this.internalColliderObject || !this.internalCollider || !this.internalColliderShape) {
      return
    }

    this.internalColliderShape.size = this.internalColliderSize
    this.internalCollider.shape = this.internalColliderShape
    this.internalColliderObject.getTransform().setLocalPosition(this.internalColliderPosition)
  }

  private destroyInternalInteractable(): void {
    const internalInteractable = this.internalInteractable

    if (this._interactable === internalInteractable) {
      this._interactable = null
    }

    // Unwire internalCollider from internalInteractable.colliders before destroying the
    // SceneObject so a pending OnDisable cascade doesn't iterate a destroyed handle. Filter
    // (not zero) so any other producer's entries aren't wiped. Match by .isSame() and drop
    // null/destroyed entries.
    const internalCollider = this.internalCollider
    if (internalInteractable && !isNull(internalInteractable) && internalCollider && internalInteractable.colliders) {
      internalInteractable.colliders = internalInteractable.colliders.filter((c) => {
        if (!c || isNull(c)) return false
        return !c.isSame(internalCollider)
      })
    }

    if (this.internalColliderObject && !isNull(this.internalColliderObject)) {
      this.internalColliderObject.destroy()
    }

    this.internalColliderObject = null
    this.internalCollider = null
    this.internalColliderShape = null
    this.internalInteractable = null
  }

  private areTextDependenciesReady(): boolean {
    return (
      !!this._textComponent &&
      this.geometryResolver !== null &&
      this.textHighlightTracker !== null &&
      this.leftHandle !== null &&
      this.rightHandle !== null &&
      this.highlightRenderer !== null
    )
  }

  private set boundingBox(textBounds: Rect | null) {
    this._boundingBox = textBounds
    this.onTextBoundingBoxUpdatedEvent.invoke(textBounds)

    if (this.isHighlighted) {
      this.markHighlightDirty()
    }
  }

  private set cursorPositions(cursorPositions: CursorPosition[] | null) {
    this._cursorPositions = cursorPositions
    this._pendingCaretGeometrySync = true
    // Publish a coherent geometry snapshot: listeners may synchronously pair the new positions
    // with caretIndex, so reconcile its logical projection before invoking the public event.
    this.reconcileCaretGeometry()
    if (this.isHighlighted) {
      this._pendingHighlightGeometrySync = true
    }

    this.onCursorPositionsUpdatedEvent.invoke(cursorPositions)

    if (this.isHighlighted) {
      this.markHighlightDirty()
    } else {
      this.markCaretDirty()
    }
  }

  private set cursorHeight(cursorHeight: number) {
    if (this._cursorHeight === cursorHeight) return

    this._cursorHeight = cursorHeight
    this.onCursorHeightUpdatedEvent.invoke(cursorHeight)

    if (this.isHighlighted) {
      this.markHighlightDirty()
    } else {
      this.markCaretDirty()
    }
  }

  private showCaret(): void {
    if (!this._isEditable) return

    this._isCaretVisible = true
    this._caretVisibilityDirty = true
    this.batchUpdate()
  }

  private hideCaret() {
    this._isCaretVisible = false
    this._caretVisibilityDirty = true
    this.batchUpdate()
  }

  private handleTriggerDown(event: InteractorEvent): void {
    if (!this.areTextDependenciesReady()) return

    // A press that lands on the highlight keeps the highlight and skips the caret's blink reset and pause. A
    // press while a drag is under way leaves that drag's press state alone.
    if (!this.dragStartPosition && this.beginPress(event)) return
    this.requestBlinkReset()
    this.requestBlinkPause()
  }

  /**
   * Starts tracking a press. Clears the previous press's state; then, for a press with a planecast point,
   * either reports that it landed on the current highlight, or clears the highlight and, if there is text,
   * places the caret where it landed.
   * @returns true if the press landed on the highlight (a potential menu trigger), which it keeps
   */
  private beginPress(event: InteractorEvent): boolean {
    // Every handled press starts as a hold candidate; only the caret-placement branch below records where
    // it landed. Reset first, before the highlight early return, so a press that never places the caret
    // cannot inherit the previous press's caret-moved latch.
    this.pressCaretIndex = null
    this.pressPlanecastPoint = null
    this.caretMovedDuringPress = false
    const interactor = event.interactor
    const planecastPoint = interactor ? interactor.planecastPoint : null
    if (!interactor || !planecastPoint) return false

    const pressPoint = this.resolvePressPoint(interactor, event.target, planecastPoint)
    if (this.isHighlighted) {
      const highlightIndex = this.geometryResolver.getIndexFromWorldPosition(pressPoint)
      this.isTouchingHighlight =
        highlightIndex >= this.textHighlightTracker.startCursorIndex &&
        highlightIndex <= this.textHighlightTracker.endCursorIndex &&
        !this.geometryResolver.isAtLineBoundary(highlightIndex) // Edge case: allow clearing highlight by touching line boundaries (beginning/end of any line)

      if (this.isTouchingHighlight) {
        print(`Touching highlight - potential menu trigger`)
        return true
      }

      this.clearHighlight()
    }

    if (this._text.length === 0) return false
    this.caretIndex = this.geometryResolver.getIndexFromWorldPosition(pressPoint)
    this.pressCaretIndex = this.caretIndex
    // Drag deltas are planecast-to-planecast, so the delta origin is the planecast, not the hit. Each
    // planecastPoint read builds a fresh vector, so the reference is safe to keep.
    this.pressPlanecastPoint = planecastPoint
    this.showCaret()
    if (this._isEditable && this.caretRenderer) {
      this.beginCaretPress(interactor)
    }
    return false
  }

  /**
   * Returns where a press landed on the text: the collider hit (where IK draws the cursor the user lined
   * up with the text), or the planecast when there is no usable hit.
   *
   * For ray targeting, the planecast is the ray's intersection with the plane through the interactable's
   * origin, typically half the collider's depth behind the hit face, so an angled ray (a hand ray from
   * below the panel) lands it up to a line above the cursor; the editor's near-perpendicular mouse ray
   * hides this. getIndexFromWorldPosition drops local Z, which projects the hit onto the text plane along
   * its normal, the way the eye lines the cursor up with the text. Only ray and poke hits lie on the
   * collider. IK's direct-pinch hit is synthetic, placed at the index/thumb midpoint, so direct pinch keeps
   * the planecast: the index tip projected onto the plane. The hit must also be on this interactable, not
   * one the interactor carries for another target.
   */
  private resolvePressPoint(interactor: Interactor, target: Interactable, planecastPoint: vec3): vec3 {
    const hitInfo = interactor.targetHitInfo
    const isUsableHit =
      hitInfo !== null &&
      hitInfo.interactable === target &&
      (hitInfo.targetMode & (TargetingMode.Indirect | TargetingMode.Poke)) !== 0
    return isUsableHit ? hitInfo.hit.position : planecastPoint
  }

  /**
   * Starts a caret press: hides the interactor's cursor and begins growing the caret into the word
   * under it, so the caret rather than the cursor shows the long press progressing. Read-only text has
   * no caret and keeps the cursor's own hold feedback.
   */
  private beginCaretPress(interactor: Interactor): void {
    this.caretPressInteractor = interactor
    this.hideInteractorCursor(interactor)
    this.startHoldMorph(interactor)
  }

  /**
   * Ends the caret press, restoring the interactor's cursor and any hold-drift threshold its caret drag
   * overrode. Pass no interactor to end it unconditionally (teardown, deactivation). A hold preview still
   * running retracts on its next update.
   * @param interactor - The interactor whose trigger ended, or omit for all
   */
  private endCaretPress(interactor?: Interactor | null): void {
    if (!interactor || interactor === this.caretPressInteractor) {
      this.caretPressInteractor = null
    }
    const override = this.holdTimerOverride
    if (override && (!interactor || interactor === override.interactor)) {
      if (!isNull(override.interactable)) {
        override.interactable.secondaryTriggerPlaneDistanceThreshold = override.threshold
      }
      this.holdTimerOverride = null
    }
    this.restoreInteractorCursor(interactor)
  }

  /**
   * Starts growing the caret into the highlight of the word under it, if there is one.
   */
  private startHoldMorph(interactor: Interactor): void {
    if (!this.textHighlightTracker || !this.holdMorphUpdateEvent) return

    // A new press always starts from a plain caret. Without this, a second hand or a quick re-press
    // during the retract would leave the caret stretched toward the previous word for a frame.
    this.stopHoldMorph()

    const word = this.textHighlightTracker.getWordAt(this.caretIndex)
    if (!word || word.cursorStart === word.cursorEnd) return

    this.holdMorph = {
      interactor,
      wordStart: word.cursorStart,
      wordEnd: word.cursorEnd,
      color: this.getOpacityAdjustedColor(this._highlightColor),
      measurement: "retry",
      progress: 0,
      retracting: false
    }
    this.holdMorphUpdateEvent.enabled = true
  }

  /**
   * Advances the hold preview once per frame. Growth follows the interactor's hold timer, reaching full
   * size at `HOLD_MORPH_FULL_AT` so the caret is already filling the word when the long press fires and
   * the real highlight takes over. Releasing, dragging the caret off its press index, or IK resetting the
   * hold (drift, hover loss — seen as regressed progress) retracts it back to the plain caret.
   */
  private updateHoldMorph(): void {
    const morph = this.holdMorph
    if (!morph || !this.caretRenderer || !this.highlightRenderer) {
      this.stopHoldMorph()
      return
    }

    if (!morph.retracting) {
      const holdProgress = morph.interactor.holdTimerProgress
      const pressEnded = this.caretPressInteractor !== morph.interactor
      if (pressEnded || this.caretMovedDuringPress || holdProgress < morph.progress) {
        morph.retracting = true
      } else {
        morph.progress = holdProgress
      }
    }
    if (morph.retracting) {
      // A preview that never got its rect has nothing visible to shrink, so end it here rather than
      // measuring on the way out: a late answer would pop the caret out toward the word mid-retract.
      if (morph.measurement !== "measured") {
        this.stopHoldMorph()
        return
      }
      morph.progress -= getDeltaTime() / HOLD_MORPH_RETRACT_DURATION
      if (morph.progress <= 0) {
        this.stopHoldMorph()
        return
      }
    }

    // Text.getHighlightRects is queried until it answers, then never again for this press. While the
    // answer is pending (rate-limited, or cursor positions not ready) the caret stays plain rather than
    // morphing toward a guessed rectangle. This runs outside the LateUpdate flush that coalesces every
    // other Text geometry query, so it must not keep spending the shared per-frame budget: once the host
    // reports no visible rect there is nothing to preview, and the preview ends.
    if (morph.measurement === "retry") {
      morph.measurement = this.highlightRenderer.measureRange(morph.wordStart, morph.wordEnd, this.holdMorphTarget)
      if (morph.measurement === "none") {
        this.stopHoldMorph()
        return
      }
    }

    this.caretRenderer.setMorph(
      HOLD_MORPH_EASE(Math.min(1, morph.progress / HOLD_MORPH_FULL_AT)),
      morph.measurement === "measured" ? this.holdMorphTarget : null,
      morph.color
    )
  }

  private stopHoldMorph(): void {
    const wasMorphing = this.holdMorph !== null
    this.holdMorph = null
    if (this.holdMorphUpdateEvent) {
      this.holdMorphUpdateEvent.enabled = false
    }
    // Only a caret that was actually morphing needs restoring; teardown paths call this unconditionally.
    if (wasMorphing) {
      this.caretRenderer?.clearMorph()
    }
  }

  private handleTriggerUp(): void {
    this.requestBlinkResume()
  }

  private handleDragStart(event: DragInteractorEvent): void {
    // With enableInstantDrag this fires on the press's second frame whether or not the hand moved, so it
    // only records the drag's start index and delta origin. Measure from the press's planecast point, not
    // this frame's, so movement between the press and this frame still counts. The drag look, the cursor
    // hide, and the hold cancel wait for the caret to actually move (see beginCaretDrag). Blink was already
    // reset and paused on trigger down.
    this.dragStartPosition = this.pressPlanecastPoint ?? event.interactor.planecastPoint
    // A press that didn't place the caret (it began before activation, or had no planecast point) starts
    // its drag where the caret is.
    this.pressCaretIndex ??= this.caretIndex
    this.caretDrag.startIndex = this.pressCaretIndex
    this.caretDrag.startPosition = null
  }

  private handleDragUpdate(event: DragInteractorEvent): void {
    if (!this.geometryResolver) return

    const interactor = event.interactor
    if (!interactor || !interactor.planecastPoint || !this.dragStartPosition) return
    if (this._text.length > 0) {
      const isIndirect = (interactor.activeTargetingMode & TargetingMode.Indirect) !== 0
      const isMouse = (interactor.inputType & InteractorInputType.Mouse) !== 0
      // Starts from the press index rather than re-resolving it from the delta origin: the press resolved
      // from the collider hit, and the planecast origin sits a depth parallax away from it on an angled ray.
      this.caretIndex = this.geometryResolver.getIndexFromDragPosition(
        this.caretDrag,
        this.dragStartPosition,
        interactor.planecastPoint,
        isIndirect && !isMouse ? CARET_DRAG_SENSITIVITY_INDIRECT : CARET_DRAG_SENSITIVITY
      )
      if (!this.caretMovedDuringPress && this.pressCaretIndex !== null && this.caretIndex !== this.pressCaretIndex) {
        this.beginCaretDrag(interactor)
      }
      this.onCaretDraggedEvent.invoke(this.caretIndex)
    }
  }

  /**
   * First caret movement of a press: from here on the press is a caret drag. The caret takes its drag look,
   * the interactor's cursor hides, the hold-to-select preview retracts, and IK's hold timer stops, so the
   * long press cannot fire for the rest of the press. Latched until the next trigger start.
   */
  private beginCaretDrag(interactor: Interactor): void {
    this.caretMovedDuringPress = true
    this.caretRenderer?.setDragState(true)
    this.hideInteractorCursor(interactor)
    this.stopHoldTimer(interactor)
  }

  /**
   * Stops IK's hold timer for the rest of the press. Ignoring the long press is not enough: when the
   * timer elapses, IK cancels the primary trigger and clears the drag, so a caret drag that stayed inside
   * the hold's drift radius would stop following the hand until release. IK reads the interactable's
   * hold-drift threshold on every tick, so HOLD_TIMER_OFF_THRESHOLD resets the timer on the next one, and
   * IK only restarts it on the next trigger start. endCaretPress puts the threshold back.
   */
  private stopHoldTimer(interactor: Interactor): void {
    const interactable = this._interactable
    if (!interactable || this.holdTimerOverride) return

    this.holdTimerOverride = {
      interactable,
      threshold: interactable.secondaryTriggerPlaneDistanceThreshold,
      interactor
    }
    interactable.secondaryTriggerPlaneDistanceThreshold = HOLD_TIMER_OFF_THRESHOLD
  }

  private handleDragEnd(): void {
    this.dragStartPosition = null
    if (this.caretRenderer) {
      this.caretRenderer.setDragState(false)
    }
    this.requestBlinkResume()
  }

  private handleLongPress() {
    if (!this.textHighlightTracker) return

    this.textHighlightTracker.updateHighlightByCursorIndex(this.caretIndex)
    const wordRange = this.textHighlightTracker.getHighlight()
    if (wordRange && this.syncLogicalHighlightFromCursorRange(wordRange)) {
      // The grown caret already covers the word. hideCaret() below is batched to this frame's LateUpdate
      // flush, which runs before rendering and never defers a hide, so on its own it would already keep
      // a bare caret off screen. Hiding directly first is a safeguard: if the flush throws before its
      // caret-visibility step, stopHoldMorph() has snapped the caret back to plain and it would show for
      // a frame.
      this.caretRenderer?.hide()
      this.stopHoldMorph()
      this.hideCaret()
      this.markHighlightDirty()
    } else if (this.holdMorph) {
      // No selection to hand off to: let the preview shrink back instead of snapping.
      this.holdMorph.retracting = true
    }
  }

  private setupHighlightHandlesDragEvents() {
    if (
      !this.leftHandle ||
      !this.rightHandle ||
      !this.textHighlightTracker ||
      !this.geometryResolver ||
      !this.highlightRenderer
    ) {
      return
    }

    // Per handle, latched on the drag's first update: the index of the highlight edge that stays put (-1
    // between drags), and the TextDrag that moves the other edge, starting from where that edge was.
    const dragAnchorIndexByHandle: Record<LogicalHandleType, number> = {
      start: -1,
      end: -1
    }
    const dragByHandle: Record<LogicalHandleType, TextDrag> = {
      start: {startIndex: 0, startPosition: null},
      end: {startIndex: 0, startPosition: null}
    }

    const highlightHandleDragUpdate = (event: HandleDragUpdateEvent, handleType: LogicalHandleType) => {
      let dragAnchorIndex = dragAnchorIndexByHandle[handleType]
      const handleDrag = dragByHandle[handleType]

      if (dragAnchorIndex === -1) {
        const anchorSide = this.getOppositeSide(this.getHandleAnchorSide(handleType))
        const tracker = this.textHighlightTracker
        dragAnchorIndex = anchorSide === "left" ? tracker.startCursorIndex : tracker.endCursorIndex
        dragAnchorIndexByHandle[handleType] = dragAnchorIndex
        handleDrag.startIndex = anchorSide === "left" ? tracker.endCursorIndex : tracker.startCursorIndex
        handleDrag.startPosition = null
      }

      const newCaretIndex = this.geometryResolver.getIndexFromDragPosition(
        handleDrag,
        event.dragStartWorldPosition,
        event.dragCurrentWorldPosition
      )
      const targetWord = this.textHighlightTracker.getWordAt(newCaretIndex)

      let newStart: number
      let newEnd: number

      if (newCaretIndex < dragAnchorIndex) {
        newStart = targetWord ? targetWord.cursorStart : newCaretIndex

        let adjustedEnd = dragAnchorIndex
        if (isAtLineStart(adjustedEnd, this.cursorPositions, this._text)) {
          adjustedEnd = Math.max(0, adjustedEnd - 1)
        }
        newEnd = adjustedEnd
      } else {
        let adjustedStart = dragAnchorIndex
        if (isAtLineEnd(adjustedStart, this.cursorPositions, this._text)) {
          adjustedStart = Math.min(this.cursorPositions.length - 1, adjustedStart + 1)
        }
        newStart = adjustedStart

        newEnd = targetWord ? targetWord.cursorEnd : newCaretIndex
      }

      const trimmedRange = trimOuterWhitespaceFromCursorRange(newStart, newEnd, this.cursorPositions, this._text)
      newStart = trimmedRange.cursorStart
      newEnd = trimmedRange.cursorEnd

      this.textHighlightTracker.updateHighlightByRange(newStart, newEnd)

      const draggedHandleAtLeftSide = newCaretIndex < dragAnchorIndex
      const draggedHandleAnchorSide: HandleSide = draggedHandleAtLeftSide ? "left" : "right"
      this.setHandleAnchorSide(handleType, draggedHandleAnchorSide)

      const range = this.textHighlightTracker.getHighlight()
      if (range && this.syncLogicalHighlightFromCursorRange(range)) {
        // Defer rendering to this frame's batched flush instead of querying geometry here.
        // Text.getHighlightRects is rate-limited per frame and throws when exceeded, and the
        // onHighlightHandleDragged subscribers below may auto-scroll the text, which refreshes
        // cursor positions in that same flush. One query per frame, taken after the scroll.
        this.markHighlightDirty()

        this.dragEventPayload.type = handleType
        this.dragEventPayload.index = draggedHandleAtLeftSide ? newStart : newEnd
        this.onHighlightHandleDraggedEvent.invoke(this.dragEventPayload)

        this.onHighlightTextUpdated()
      }
    }
    const highlightHandleDragEnd = (handleType: LogicalHandleType) => {
      dragAnchorIndexByHandle[handleType] = -1

      // Same single-query-per-frame path; the flush applies the release animation.
      if (handleType === "start") {
        this._pendingStartRelease = true
      } else {
        this._pendingEndRelease = true
      }
      this.markHighlightDirty()
    }

    this.textComponentUnsubscribes.push(
      this.leftHandle.onDragStart.add((event) => {
        this.hideInteractorCursor(event.interactor)
      }),
      this.rightHandle.onDragStart.add((event) => {
        this.hideInteractorCursor(event.interactor)
      }),
      this.leftHandle.onDragUpdate.add((event) => highlightHandleDragUpdate(event, "start")),
      this.rightHandle.onDragUpdate.add((event) => highlightHandleDragUpdate(event, "end")),
      this.leftHandle.onDragEnd.add((event) => {
        highlightHandleDragEnd("start")
        this.restoreInteractorCursor(event.interactor)
      }),
      this.rightHandle.onDragEnd.add((event) => {
        highlightHandleDragEnd("end")
        this.restoreInteractorCursor(event.interactor)
      })
    )
  }

  private getClampedCaretIndex(index: number): number {
    if (!this.cursorPositions || this.cursorPositions.length === 0) return 0
    return Math.max(0, Math.min(index, this.cursorPositions.length - 1))
  }

  /**
   * Returns whether a cursor projection represents the requested logical UTF-16 boundary.
   *
   * Logical targets are normalized to valid character boundaries before projection. Lens may omit
   * cursor boundaries for whitespace, making the closest cursor a complete projection. Any other
   * mismatch means that the cursor snapshot is partial, commonly because it still describes
   * native-truncated text, and must be refreshed.
   */
  private isCursorProjectionResolved(cursorIndex: number | undefined, targetCharIndex: number): cursorIndex is number {
    if (cursorIndex === undefined) return false

    const projectedCharIndex = getUtf16IndexFromCursorIndex(cursorIndex, this.cursorPositions, this._text)
    if (projectedCharIndex === undefined) return false
    if (projectedCharIndex === targetCharIndex) return true

    // Native Truncate geometry deliberately omits hidden cursor boundaries. Its nearest visible
    // cursor is the only renderable projection; the logical UTF-16 position remains authoritative.
    if (this._cursorGeometryMayRemainPartial) return true

    const rangeStart = Math.min(projectedCharIndex, targetCharIndex)
    const rangeEnd = Math.max(projectedCharIndex, targetCharIndex)
    if (rangeStart === rangeEnd) return false

    for (let index = rangeStart; index < rangeEnd; index++) {
      if (!WHITESPACE_CHARACTER_REGEX.test(this._text[index] ?? "")) {
        return false
      }
    }
    return true
  }

  /**
   * Reconciles the rendered caret with the authoritative UTF-16 index using current cursor geometry.
   * A valid round-trip preserves soft-wrap affinity; invalidated geometry falls back to the
   * canonical end-boundary projection. The caret event itself remains batched.
   */
  private reconcileCaretGeometry(): void {
    if (!this.cursorPositions || this.cursorPositions.length === 0) {
      const clampedIndex = this.getClampedCaretIndex(this._caretIndex)
      if (this._caretIndex !== clampedIndex) {
        this._caretIndex = clampedIndex
        this._caretDirty = true
      }
      if (this.shouldRetryCaretGeometry()) {
        // An active editor with non-empty text must eventually recover a renderable caret from a
        // transient empty snapshot. Inactive native-truncation geometry intentionally does not poll.
        this.requestCursorPositionsUpdate()
      } else {
        // A future non-empty snapshot establishes a new projection request in its setter.
        this._pendingCaretGeometrySync = false
      }
      return
    }

    const currentCaretCharIndex = getUtf16IndexFromCursorIndex(this._caretIndex, this.cursorPositions, this._text)
    const newCaretIndex =
      currentCaretCharIndex === this._caretCharIndex
        ? this._caretIndex
        : getCursorIndexFromUtf16Index(this._caretCharIndex, this.cursorPositions, this._text, false)
    if (!this.isCursorProjectionResolved(newCaretIndex, this._caretCharIndex)) {
      // Keep the rendered cursor valid for the newly published snapshot without treating its
      // nearest truncated boundary as the authoritative logical caret.
      const fallbackIndex = this.getClampedCaretIndex(newCaretIndex ?? this._caretIndex)
      if (this._caretIndex !== fallbackIndex) {
        this._caretIndex = fallbackIndex
        this._caretDirty = true
      }
      // Partial native-truncation geometry is expected while inactive. During editing, however,
      // the full logical caret must eventually project into Overflow geometry.
      if (this.shouldRetryCaretGeometry()) {
        this.requestCursorPositionsUpdate()
      }
      return
    }

    const clampedIndex = this.getClampedCaretIndex(newCaretIndex)
    if (this._caretIndex !== clampedIndex) {
      this._caretIndex = clampedIndex
      this._caretDirty = true
    }
    this._pendingCaretGeometrySync = false
  }

  private getClampedCaretCharIndex(index: number): number {
    const text = this._text ?? ""
    let clampedIndex = Math.max(0, Math.min(index, text.length))

    // A collapsed range uses the end-boundary preference, so an index inside a surrogate pair
    // snaps after the complete character rather than retaining an invalid half-character caret.
    if (clampedIndex > 0 && clampedIndex < text.length) {
      const currentCodeUnit = text.charCodeAt(clampedIndex)
      const previousCodeUnit = text.charCodeAt(clampedIndex - 1)
      const isInsideSurrogatePair =
        currentCodeUnit >= 0xdc00 &&
        currentCodeUnit <= 0xdfff &&
        previousCodeUnit >= 0xd800 &&
        previousCodeUnit <= 0xdbff
      if (isInsideSurrogatePair) {
        clampedIndex++
      }
    }
    return clampedIndex
  }

  private getClampedHighlightCharIndex(index: number, isStart: boolean): number {
    const text = this._text ?? ""
    let clampedIndex = Math.max(0, Math.min(index, text.length))

    if (clampedIndex > 0 && clampedIndex < text.length) {
      const currentCodeUnit = text.charCodeAt(clampedIndex)
      const previousCodeUnit = text.charCodeAt(clampedIndex - 1)
      const isInsideSurrogatePair =
        currentCodeUnit >= 0xdc00 &&
        currentCodeUnit <= 0xdfff &&
        previousCodeUnit >= 0xd800 &&
        previousCodeUnit <= 0xdbff
      if (isInsideSurrogatePair) {
        clampedIndex += isStart ? -1 : 1
      }
    }
    return clampedIndex
  }

  private syncLogicalHighlightFromCursorRange(range: {cursorStart: number; cursorEnd: number}): boolean {
    const startCharIndex = getUtf16IndexFromCursorIndex(range.cursorStart, this.cursorPositions, this._text)
    const endCharIndex = getUtf16IndexFromCursorIndex(range.cursorEnd, this.cursorPositions, this._text)
    if (startCharIndex === undefined || endCharIndex === undefined) return false

    const rangeStart = Math.min(startCharIndex, endCharIndex)
    const rangeEnd = Math.max(startCharIndex, endCharIndex)
    const clampedStart = this.getClampedHighlightCharIndex(rangeStart, true)
    const clampedEnd = this.getClampedHighlightCharIndex(rangeEnd, false)
    if (clampedStart === clampedEnd) {
      // A handle can be dragged onto its anchor. Clear both the projected and logical selection
      // rather than leaving later cut/paste operations pointed at the previous logical range.
      this.setHighlightByCharIndex(clampedEnd, clampedEnd)
      return false
    }

    this._highlightCharRange = {start: clampedStart, end: clampedEnd}
    this._pendingHighlightGeometrySync = false
    this.hideCaret()
    return true
  }

  private markCaretDirty(): void {
    this._caretDirty = true
    this.batchUpdate()
  }

  private markHighlightDirty(): void {
    this._highlightDirty = true
    this.batchUpdate()
  }

  private batchUpdate(): void {
    if (!this.isFlushingBatchedUpdates && this._batchUpdateEvent) {
      this._batchUpdateEvent.enabled = true
    }
  }

  private requestBlinkReset() {
    if (!this.caretRenderer) return

    this._blinkResetPending = true
    this.batchUpdate()
  }

  private requestBlinkPause() {
    if (!this.caretRenderer) return

    this._pendingBlinkState = "pause"
    this.batchUpdate()
  }

  private requestBlinkResume() {
    if (!this.caretRenderer) return

    this._pendingBlinkState = "resume"
    this.batchUpdate()
  }

  private flushPendingGeometryUpdates(): void {
    if (this._pendingBoundingBoxUpdate) {
      this._pendingBoundingBoxUpdate = false
      this.updateBoundingBox()
    }

    if (this._pendingCursorPositionsUpdate) {
      this._pendingCursorPositionsUpdate = false
      this.updateCursorPositions()
    }
  }

  private flushBatchedUpdates(): void {
    if (!this._batchUpdateEvent) return

    this.isFlushingBatchedUpdates = true
    this._batchUpdateEvent.enabled = false

    try {
      if (!this.areTextDependenciesReady()) {
        return
      }

      if (this._textDirty) {
        this._textDirty = false

        const payload: TextManipulationTextUpdate = {
          text: this._text,
          caretCharIndex: this._caretCharIndex
        }

        if (this.isHighlighted) {
          const startChar = this.highlightStartCharIndex
          const endChar = this.highlightEndCharIndex
          if (startChar !== undefined && endChar !== undefined && startChar !== endChar) {
            payload.highlightStartCharIndex = startChar
            payload.highlightEndCharIndex = endChar
          }
        }

        this.onTextUpdatedEvent.invoke(payload)
      }

      this.flushPendingGeometryUpdates()

      const cursorPositionsReady = !this._pendingCursorPositionsUpdate

      if (this._pendingCaretGeometrySync && cursorPositionsReady) {
        this.reconcileCaretGeometry()
      }

      if (this._pendingHighlightGeometrySync && cursorPositionsReady) {
        const highlightRange = this._highlightCharRange
        if (!highlightRange) {
          this._pendingHighlightGeometrySync = false
        } else {
          const startCursor = getCursorIndexFromUtf16Index(highlightRange.start, this.cursorPositions, this._text, true)
          const endCursor = getCursorIndexFromUtf16Index(highlightRange.end, this.cursorPositions, this._text, false)
          const startResolved = this.isCursorProjectionResolved(startCursor, highlightRange.start)
          const endResolved = this.isCursorProjectionResolved(endCursor, highlightRange.end)
          if (startResolved && endResolved) {
            this.textHighlightTracker.updateHighlightByRange(startCursor, endCursor)
            this._pendingHighlightGeometrySync = false
            this._highlightDirty = true
          } else if (!this._cursorGeometryMayRemainPartial) {
            // The cached snapshot may still be empty or describe native-truncated text. A logical
            // selection cannot be projected from that snapshot, so request fresh geometry instead
            // of leaving the pending selection dormant until an unrelated layout change.
            this.requestCursorPositionsUpdate()
          } else {
            // There is no renderable selection when native truncation exposes no cursor positions.
            // Keep the logical range for keyboard/cut/paste operations without polling forever.
            if (this.textHighlightTracker.isHighlighted) {
              this.textHighlightTracker.clearHighlight()
            }
            this._pendingHighlightGeometrySync = false
            this._highlightDirty = true
          }
        }
      }

      if (cursorPositionsReady) {
        const caretDirty = this._caretDirty
        const highlightDirty = this._highlightDirty && !this._pendingHighlightGeometrySync
        this._caretDirty = false
        if (highlightDirty) {
          this._highlightDirty = false
        }

        if (caretDirty) {
          this.updateCaretPosition(this.caretIndex)
        }

        if (highlightDirty) {
          this.updateHighlightVisuals()
        }
      }

      if (this._caretVisibilityDirty) {
        const shouldDeferShow = this._isCaretVisible && !cursorPositionsReady
        if (!shouldDeferShow) {
          this._caretVisibilityDirty = false
          if (this.caretRenderer) {
            if (this._isCaretVisible) {
              this.caretRenderer.show()
            } else {
              this.caretRenderer.hide()
            }
          }
        }
      }

      // Process blink updates
      if (this._blinkResetPending) {
        if (this.caretRenderer) {
          this.caretRenderer.resetBlink()
        }
        this._blinkResetPending = false
      }

      if (this.caretRenderer) {
        if (this._pendingBlinkState === "pause") {
          this.caretRenderer.pauseBlink()
        } else if (this._pendingBlinkState === "resume") {
          this.caretRenderer.resumeBlink()
        }
      }

      this._pendingBlinkState = null
    } catch (error) {
      // An exception escaping a LateUpdateEvent callback aborts the hosting Lens app on device.
      // Log and keep the module alive; only still-pending or newly staged work re-arms below.
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log.e(`flushBatchedUpdates failed: ${message}`)
    } finally {
      this.isFlushingBatchedUpdates = false
      // Public-event subscribers can stage new work after the corresponding phase of this flush has
      // already run. Since batchUpdate() is suppressed while flushing, explicitly carry any such
      // work into the next frame after dropping the guard.
      if (this.hasPendingBatchedWork()) {
        this.batchUpdate()
      }
    }
  }

  private hasPendingBatchedWork(): boolean {
    return (
      this._pendingBoundingBoxUpdate ||
      this._pendingCursorPositionsUpdate ||
      this._textDirty ||
      this._caretDirty ||
      this._highlightDirty ||
      this.shouldRetryCaretGeometry() ||
      (this._pendingHighlightGeometrySync && this._highlightCharRange !== null) ||
      this._caretVisibilityDirty ||
      this._blinkResetPending ||
      this._pendingBlinkState !== null
    )
  }

  private shouldRetryCaretGeometry(): boolean {
    return (
      this._pendingCaretGeometrySync &&
      this._active &&
      this._isEditable &&
      !this._cursorGeometryMayRemainPartial &&
      (this._text?.length ?? 0) > 0
    )
  }

  /**
   * Stages a text replacement for the next batched flush.
   *
   * Pairing `text` with `caretCharIndex` in a single call enforces the invariant that
   * {@link TextManipulationTextUpdate.caretCharIndex} emitted by {@link onTextUpdated}
   * is always a valid UTF-16 index for the new `text`, without relying on the (now stale)
   * `cursorPositions` snapshot to re-derive it from `this._caretIndex`.
   */
  private updateText(text: string, caretCharIndex: number) {
    this._text = text
    this._caretCharIndex = this.getClampedCaretCharIndex(caretCharIndex)
    this._pendingCaretGeometrySync = true
    this._textDirty = true
    this._caretDirty = true
    this.batchUpdate()
  }

  private updateCaretPosition(index: number) {
    if (this.caretRenderer) {
      this.caretRenderer.updatePosition(index)
      this.requestBlinkReset()
    }

    this.onCaretIndexChangedEvent.invoke(index)
  }

  private getHandleAnchorSide(handleType: LogicalHandleType): HandleSide {
    return handleType === "start" ? this.leftHandleAnchorSide : this.rightHandleAnchorSide
  }

  private getOppositeSide(side: HandleSide): HandleSide {
    return side === "left" ? "right" : "left"
  }

  private get leftHandleAnchorSide(): HandleSide {
    return this._leftHandleAnchorSide
  }

  private get rightHandleAnchorSide(): HandleSide {
    return this.getOppositeSide(this._leftHandleAnchorSide)
  }

  private resetHandleAnchorSides(): void {
    this._leftHandleAnchorSide = "left"
  }

  private setHandleAnchorSide(handleType: LogicalHandleType, anchorSide: HandleSide): void {
    if (handleType === "start") {
      this._leftHandleAnchorSide = anchorSide
    } else {
      this._leftHandleAnchorSide = this.getOppositeSide(anchorSide)
    }
  }

  private updateHandle(handle: GrabHandle, rect: HighlightRect, anchorSide: HandleSide, isReleasing: boolean): void {
    handle.updateVisualStateFromRect(rect, anchorSide, isReleasing)
    handle.show()
  }

  private hideHandles(): void {
    if (!this.leftHandle || !this.rightHandle) return

    this.leftHandle.hide()
    this.rightHandle.hide()
  }

  private applyGrabHandleColors(): void {
    if (this.leftHandle) {
      this.leftHandle.defaultColor = this.getOpacityAdjustedColor(this._grabHandleColor)
      this.leftHandle.activeColor = this.getOpacityAdjustedColor(this._grabHandleActiveColor)
    }
    if (this.rightHandle) {
      this.rightHandle.defaultColor = this.getOpacityAdjustedColor(this._grabHandleColor)
      this.rightHandle.activeColor = this.getOpacityAdjustedColor(this._grabHandleActiveColor)
    }
  }

  private applyOpacityToVisuals(): void {
    if (this.caretRenderer) {
      this.caretRenderer.color = this.getOpacityAdjustedColor(this._caretColor)
    }
    if (this.highlightRenderer) {
      this.highlightRenderer.color = this.getOpacityAdjustedColor(this._highlightColor)
    }
    this.applyGrabHandleColors()
  }

  private getOpacityAdjustedColor(color: vec4): vec4 {
    return new vec4(color.x, color.y, color.z, color.w * this._opacity)
  }

  private updateHandles(
    activeHighlightRects: ReadonlyArray<HighlightRect>,
    releasingStart: boolean,
    releasingEnd: boolean
  ): void {
    if (!this.leftHandle || !this.rightHandle) return

    if (activeHighlightRects.length === 0) {
      this.hideHandles()
      return
    }

    const leftRect = activeHighlightRects[0]
    const rightRect = activeHighlightRects[activeHighlightRects.length - 1]

    if (!leftRect || !rightRect) {
      this.hideHandles()
      return
    }

    const leftHandleRect = this.leftHandleAnchorSide === "left" ? leftRect : rightRect
    const rightHandleRect = this.rightHandleAnchorSide === "left" ? leftRect : rightRect

    this.updateHandle(this.leftHandle, leftHandleRect, this.leftHandleAnchorSide, releasingStart)
    this.updateHandle(this.rightHandle, rightHandleRect, this.rightHandleAnchorSide, releasingEnd)
  }

  private updateHighlightVisuals(): void {
    if (!this.textHighlightTracker || !this.highlightRenderer) return

    const range = this.textHighlightTracker.isHighlighted ? this.textHighlightTracker.getHighlight() : null
    if (!range) {
      this._pendingStartRelease = false
      this._pendingEndRelease = false
      this.highlightRenderer.hide()
      this.hideHandles()
      this.resetHandleAnchorSides()
      this.onHighlightTextUpdated()
      return
    }

    const activeHighlightRects = this.highlightRenderer.updateHighlight(range.cursorStart, range.cursorEnd)
    if (activeHighlightRects === null) {
      // Text.getHighlightRects was rate-limited this frame. The previously rendered rects and handles
      // stay on screen; re-flag the highlight so the flush guard re-arms a retry on the next frame.
      this.markHighlightDirty()
      this.onHighlightTextUpdated()
      return
    }

    const releasingStart = this._pendingStartRelease
    const releasingEnd = this._pendingEndRelease
    this._pendingStartRelease = false
    this._pendingEndRelease = false
    this.updateHandles(activeHighlightRects, releasingStart, releasingEnd)
    this.onHighlightTextUpdated()
  }

  /**
   * Resolves the authoritative logical highlight to its text content and fires
   * {@link onHighlightUpdatedEvent} when the text differs from the last emission.
   *
   * Cursor geometry is intentionally not used here because it can lag—or intentionally omit—the
   * logical selection while native truncation or layout changes are active.
   */
  private onHighlightTextUpdated(): void {
    const range = this._highlightCharRange
    const newText = range ? this._text.substring(range.start, range.end) : ""
    if (newText !== this._lastHighlightText) {
      this._lastHighlightText = newText
      this.onHighlightUpdatedEvent.invoke(newText)
    }
  }

  private clearHighlight() {
    const hadLogicalHighlight = this._highlightCharRange !== null
    const hadProjectedHighlight = this.textHighlightTracker?.isHighlighted ?? false
    if (!hadLogicalHighlight && !hadProjectedHighlight) return

    this._highlightCharRange = null
    this._pendingHighlightGeometrySync = false
    if (hadProjectedHighlight) {
      this.textHighlightTracker.clearHighlight()
    }
    this.resetHandleAnchorSides()
    this.markHighlightDirty()
  }

  /**
   * Hides the interactor cursor for a caret press or a text manipulation drag.
   *
   * The cursor's visual is switched off at once, so none of the cursor's fade is seen. A caret press hides
   * it in the press frame, before the frame renders, so the pressed look IK's cursor animates into from
   * that frame on (a filled white circle) is never shown either. Selection handles hide it on drag start,
   * a frame after the press, so a handle press still shows the cursor for its first frame. A caret drag
   * hides it on its first caret move when no caret press hid it first (read-only text, or a press that
   * began before activation). The cursor keeps tracking underneath, so when it returns (release, or the
   * long press taking over) it is already in place.
   *
   * IK's fade alone cannot hide it within a frame: its spring diverges for durations below about 0.063 s,
   * and at 0.08 s the pressed cursor still showed for two or three frames. The fade still runs. It keeps
   * the far-field alpha at zero for the rest of the press, and it lets release fade the cursor back in over
   * show()'s 0.2 s instead of popping it back at full opacity. It is also the only hide for the far-field
   * ray, which is not part of the cursor's visual; where an interaction plane makes the ray the targeting
   * visual, the fade is what is seen.
   *
   * Poke and direct pinch are hidden too, although IK pins their fade to 1. A near/far switch mid-press
   * can still bring the cursor back, because IK re-enables the visual when its alpha climbs back through
   * the visibility threshold: far-to-near for the rest of the press, near-to-far through the switch's
   * fade-in. Cursors are tracked per-interactor so that simultaneous drags (e.g. both selection handles,
   * one per hand) each hide and restore their own cursor.
   * @param interactor - The interactor whose cursor should be hidden
   */
  private hideInteractorCursor(interactor?: Interactor | null): void {
    if (!interactor || this.hiddenInteractorCursors.has(interactor)) return

    const cursor = CursorControllerProvider.getInstance().getCursorByInteractor(interactor)
    if (cursor) {
      this.setCursorVisualEnabled(cursor, false)
      cursor.hide(CURSOR_HIDE_DURATION)
      this.hiddenInteractorCursors.set(interactor, cursor)
    }
  }

  /**
   * Restores cursors hidden by {@link hideInteractorCursor}. Pass an interactor
   * to restore only that one (press or drag end); pass nothing to restore all (teardown).
   * @param interactor - The interactor whose cursor should be restored, or omit for all
   */
  private restoreInteractorCursor(interactor?: Interactor | null): void {
    if (interactor) {
      const cursor = this.hiddenInteractorCursors.get(interactor)
      if (cursor) {
        this.showCursor(cursor)
        this.hiddenInteractorCursors.delete(interactor)
      }
      return
    }

    this.hiddenInteractorCursors.forEach((cursor) => {
      this.showCursor(cursor)
    })
    this.hiddenInteractorCursors.clear()
  }

  private showCursor(cursor: InteractorCursor): void {
    // Re-enable the visual here. IK only toggles the visual when its alpha crosses the visibility
    // threshold, and a near-field press (fade pinned to 1) or a quick far-field press (under about 0.15 s)
    // never takes it below, so IK would never re-enable it.
    this.setCursorVisualEnabled(cursor, true)
    cursor.show()
  }

  private setCursorVisualEnabled(cursor: InteractorCursor, enabled: boolean): void {
    const visual = cursor.visual
    if (visual && !isNull(visual)) {
      visual.enabled = enabled
    }
  }
}
