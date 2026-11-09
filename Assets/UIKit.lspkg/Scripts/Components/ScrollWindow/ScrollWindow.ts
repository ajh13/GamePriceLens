import {
  Interactable,
  InteractableEventArgs
} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandInteractor} from "InteractionKit.lspkg/Core/HandInteractor/HandInteractor"
import {InteractionManager} from "InteractionKit.lspkg/Core/InteractionManager/InteractionManager"
import {Interactor, InteractorTriggerType, TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {findAllComponentsInSelfOrChildren} from "InteractionKit.lspkg/Utils/SceneObjectUtils"
import {findGoverningCanvas, invalidateCanvasBindingsIn} from "../../Utility/CanvasController"
import {Frustum} from "../../Utility/Frustum"
import {getElement, isEqual} from "../../Utility/UIKitUtilities"
import type {BaseScrollerConfig} from "../BaseScroller"
import {BaseScroller} from "../BaseScroller"
import {Element} from "../Element"
import {Layoutable} from "../Layout2D/Layoutable"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import type {EdgeMode, Feel, SnapMode, SnapPolicyParams} from "../ScrollerPresets"
import {makeScroller, SCROLL_WINDOW_PAGING_PRESET} from "../ScrollerPresets"
import type {SnapSettleOptions, SnapSettleResult} from "../ScrollUtilities"
import {
  detentMaxPagesFromStart,
  isAxisScrollable,
  maxValidPageIndex,
  normalizedFromPosition,
  pageIndexFromPosition,
  pagePositionForIndex,
  positionFromNormalized,
  projectSnapPageFromCurrent,
  projectSnapPageFromStart,
  SnapScrollPolicy
} from "../ScrollUtilities"
import {
  classifyScrollEnd,
  classifyTickEndReason,
  evaluatePlaneSideEngagement,
  GestureState,
  ScrollGestureEndReason,
  ScrollGestureInterceptor
} from "./ScrollGestureInterceptor"

// Re-export so consumers can `import { ScrollGestureEndReason } from "ScrollWindow"`.
// The enum's canonical home is the interceptor module (gesture-state domain).
export {ScrollGestureEndReason} from "./ScrollGestureInterceptor"
// Side-effect import — register UIKit Layout2D handlers. ScrollWindow
// doesn't extend Element, so it needs its own bootstrap reference.
import "../../UIKitBootstrap"

const log = new NativeLogger("ScrollWindow")

/**
 * Edge behaviors ScrollWindow supports. Narrowed from ScrollerPresets' EdgeMode
 * ("unbounded" is expressed per axis via `scrollDimensions = -1`, and "wrapped"
 * is not supported — both are compile errors here rather than silent no-ops).
 */
export type ScrollWindowEdgeMode = Extract<EdgeMode, "elastic" | "clamped">

/**
 * Snap modes ScrollWindow supports while `scrollSnapping` is enabled.
 * Narrowed from ScrollerPresets' SnapMode: "none" is expressed by the
 * `scrollSnapping` toggle (V1 parity) rather than a mode value, so it is a
 * compile error here rather than a silent no-op.
 */
export type ScrollWindowSnapMode = Extract<SnapMode, "paging" | "detent">

/**
 * Selects where Paging anchors a finite snap-step cap. Detent always preserves
 * physically crossed detents and ignores this setting.
 */
export type ScrollWindowPagingSnapCapMode = "gestureStart" | "releasePage"

// Lateral motion (real-cm world space, computed from intersection.distance) the
// gesture interceptor requires before committing to a scroll. Widened back to
// 2.0 cm after on-device testing showed that 1.0 cm still allowed tap-reach
// motions toward forward-protruding child UI to clip the deadzone in 3–4
// frames — even with the forward-velocity gate, dwell counter (engageDwellFrames
// = 4), and pokeStillTouching gating in place. At 2.0 cm the lateral budget is
// large enough that natural reach-and-tap trajectories no longer false-trigger,
// while deliberate horizontal/vertical scroll intent (>2 cm of sweep) still
// engages within a few frames.
const SCROLL_LATERAL_DEADZONE_CM = 2.5

// Hysteresis margin (world cm) around the engagement plane that the
// knuckle→tip line-segment-crosses-plane check uses to reject single-frame
// hand-tracker jitter. A point whose signed distance from the plane is within
// ±this value is treated as "ambiguous" and doesn't contribute to a
// disengagement decision — preventing flicker when the finger is held right
// at the surface.
const ENGAGEMENT_PLANE_HYSTERESIS_CM = 0.5

// Follow-up listener passes allowed after the initial snap-index announcement.
// Bounds synchronous feedback while preserving ordinary short reentrancy.
const MAX_SNAP_INDEX_ANNOUNCE_REDRAINS = 4

// ─── Edge fade ────────────────────────────────────────────────────────
const EDGE_FADE_DEFAULT_SOFTNESS = 1.5
const EDGE_FADE_STRENGTH_EPSILON = 0.005
const EDGE_FADE_RAMP_MIN = 0.0025
// Depth bias for the fade, in depth-buffer units (polygonOffset factor, units).
// The fade is depth-tested so that UI outside this window can occlude it, but it
// still has to win against the content it covers, which sits at most +0.05 cm
// forward of the window plane (measured across a real list — ElementContent's
// default zOffset).
//
// A physical z lift was tried first and z-fought: clearing +0.05 by a 0.005 cm
// hairline is ~50 microns, far below depth-buffer resolution at panel viewing
// distance. Sizing the lift up to beat that resolution is what the original
// "parallax gap at steep view angles" comment was rightly worried about.
// polygonOffset avoids the choice — it biases the comparison in depth-buffer
// units, so the fade wins reliably while staying geometrically coplanar with the
// window. No lift, no parallax.
//
// Negative pulls toward the viewer. Content further forward than the bias can
// resolve — a prism in a list, whose contentZOffset is size.z * 0.5 + 0.1, or
// one mid-hover-extrusion — will poke through. Accepted: a popped element
// reading as in front of the chrome is defensible.
const EDGE_FADE_DEPTH_BIAS = new vec2(-1, -1)
// Outside a Hierarchy Canvas, companion content on blended visuals raises itself
// contentRenderOrderOffset (currently 1, see Visual.contentRenderOrderOffset)
// above its host, and renderOrder outranks both depth and polygonOffset — so a
// fade sharing the window's order would lose to that content unconditionally.
// This headroom (max content offset + 1) keeps the fade above it. Applied only
// when NO Hierarchy Canvas governs: under one, the content offset is suppressed
// too, and a non-zero fade order there would escape the canvas bucket and draw
// over unrelated chrome. Depth-testing (above) is what keeps a headroomed fade
// occludable by outside UI — depth-writing geometry in front draws first and
// rejects the fade's fragments.
const EDGE_FADE_CONTENT_ORDER_HEADROOM = 2

type ScrollEventArg = {
  startPosition: vec2
  dragAmount: vec2
}

/** Viewport corner pair — bottomLeft and topRight — in local or normalized space (see the getVisibleWindow* helpers). */
export type VisibleWindow = {
  bottomLeft: vec2
  topRight: vec2
}

/** Payload for `onScrollEngaged`. */
export type ScrollEngagedArg = {
  /** Lateral deadzone (cm) the user crossed to engage. Set on the physical
   * (poke / direct pinch) path. Omitted on the indirect path — IK's
   * `indirectDragThreshold` (a per-lens BaseInteractor tunable) gated
   * engagement instead; ScrollWindow has no deadzone of its own there. */
  thresholdCm?: number
  /** Designer-friendly description of how engagement was reached. */
  message: string
}

/** Payload for `onScrollDisengaged` and `onScrollRejected`. */
export type ScrollGestureEndArg = {
  /** Programmatic cause — stable, switchable. */
  reason: ScrollGestureEndReason
  /** Designer-friendly description. */
  message: string
}

/**
 * Per-instance scroll-physics engine, expanded from a scroller preset by
 * `buildScrollEngine` (the first statement of onAwake). Object members are
 * null and numeric members are 0 only before onAwake runs.
 */
type ScrollWindowEngineState = {
  /** Flat physics config shared by both axis scrollers. */
  config: BaseScrollerConfig | null
  /** Snap-policy data from the preset. Non-null by construction — the paging preset always emits it. */
  snapParams: SnapPolicyParams | null
  /** Positions/velocities below this magnitude are treated as zero. */
  epsilon: number
  /** Reference frame time used to convert per-frame velocities to per-second units. */
  velocityBaseFrameTime: number
  /** Fling velocities below this magnitude stop coasting. */
  minimumScrollingVelocity: number
  /** Fraction of the viewport the content may overscroll past an edge. */
  maxOvershootFactor: number
  horizontalScroller: BaseScroller | null
  verticalScroller: BaseScroller | null
  // Per-axis snap latch + drag-start page anchor, owned by the policy collaborator.
  // The latch is committed once chosen and held until the snap completes.
  horizontalSnapPolicy: SnapScrollPolicy | null
  verticalSnapPolicy: SnapScrollPolicy | null
}

/** Live drag-gesture and scroll-motion bookkeeping. */
type ScrollWindowGestureState = {
  /** Scroller local position latched at drag start. */
  startPosition: vec3
  /** Interactor position (scroll-window local) latched at drag start. */
  interactorOffset: vec3
  /** True once the active drag has seeded startPosition/interactorOffset. */
  interactorUpdated: boolean
  activeInteractor: Interactor | null
  isDragging: boolean
  /** True while an external controller drives the scroll position. */
  isControlledExternally: boolean
  /** Cumulative drag displacement of the active gesture (scroll-window local). */
  dragAmount: vec2
  scrollTweenCancel: CancelSet
  isTweeningScroll: boolean
  /** Previous frame's settled state — edge-detects the scroll-end event. */
  wasScrollSettled: boolean
}

/** Child-collider management (hover gating of descendant interactables). */
type ScrollWindowColliderState = {
  /** Cache of each descendant collider's owning Element for enabled/inactive checks. */
  colliderToElementMap: Map<ColliderComponent, Element>
  // Descendant-collider snapshot; invalidated on scrollDimensions change or disable.
  childCollidersCache: ColliderComponent[] | null
  lastChildCollidersEnabled: boolean | null
  /** When true, the owner manages descendant colliders itself. */
  skipColliderManagement: boolean
  /** Normalized (-1..1) hover region within which child colliders are enabled. */
  enableChildCollidersBoundary: Rect
  /** Per-side inset subtracted from windowSize when sizing the OWN collider (mask/viewport unaffected). */
  colliderInset: vec2
  /** Box shape backing this component's own collider. */
  colliderShape: BoxShape
  isSubscribedToEvents: boolean
  eventUnsubscribes: (() => void)[]
}

// Per-frame scratch buffers — subscribers MUST NOT retain across ticks.
type ScrollWindowScratchState = {
  /** tweenTo's per-update lerp output. */
  tweenLerp: vec3
  /** Payload for the scroll-position-updated event. */
  scrollPosUpdated: vec2
  /** Output of getClampedBoundsAndCheckOutOfBounds. */
  clampedBounds: vec3
  /** processFrictionScrolling's output position. */
  frictionStep: vec3
  /** processSnapScrolling's output position. */
  snapStep: vec3
  /** Per-axis outputs of SnapScrollPolicy.stepSettleInto. */
  snapSettleX: SnapSettleResult
  snapSettleY: SnapSettleResult
  /** Stable settle options, refreshed when the scroll engine is rebuilt. */
  snapSettleOptions: SnapSettleOptions
  /** onInteractableDragUpdate's per-tick drag position. */
  dragPosition: vec3
  /** applyOverscrollIfNeeded's output — distinct from every producer buffer that feeds it. */
  overscroll: vec3
}

/** Snap-selection bookkeeping (page-index twins of the per-axis snap latches) plus the pre-init position-seed flag. */
type ScrollWindowSnapState = {
  /** True when a pre-init raw scrollPosition write should win over the normalized input. */
  pendingInitialPositionIsRaw: boolean
  /** Index twin of the horizontal latch — non-null iff the policy has a committed target. */
  committedSnapIndexX: number | null
  /** Index twin of the vertical latch — non-null iff the policy has a committed target. */
  committedSnapIndexY: number | null
  /** Last announced horizontal snap index (committed or settled). */
  snapIndexX: number
  /** Last announced vertical snap index (committed or settled). */
  snapIndexY: number
  /** Payload for the snap-index-changed event — subscribers MUST NOT retain across ticks. */
  snapIndexScratch: vec2
  /**
   * One-shot deadzone exemption for the next horizontal snap commit — set by
   * setVelocity. A programmatic kick has no gesture displacement, and the
   * deadzone is a drag-noise filter: without the exemption every from-rest
   * kick is swallowed (the reseeded anchor IS the current page, so the
   * projection's below-deadzone branch targets it and the velocity handoff
   * clears the fling with zero movement).
   */
  programmaticKickX: boolean
  /** One-shot deadzone exemption for the next vertical snap commit (see programmaticKickX). */
  programmaticKickY: boolean
  /**
   * True while update()'s physics pass runs: snap-index announces update the
   * dedupe state immediately (snapIndex reads stay fresh) but defer the event
   * INVOKE to the pass flush, after the frame's final position write. Fired
   * mid-pass, a subscriber writing scrollPosition would be clobbered by the
   * pass's stale position buffer, and its latch clears would desync the
   * in-flight commit.
   */
  deferAnnounces: boolean
  /** True while listeners are receiving a snap-index announcement. */
  isDispatchingAnnounce: boolean
  /** A physics-deferred or reentrant snap-index change is waiting to be dispatched. */
  announceOwed: boolean
}

/**
 * Per-axis clamped-edge landing targets — non-null while the settle spring is
 * easing a coast onto an edge (velocity-continuous arrival instead of a
 * one-frame wall stop or a freeze-then-snap). Latched by
 * processFrictionScrolling on the frame the coast would cross the edge;
 * cleared on settle and by clearEdgeLanding() when anything interrupts.
 */
type ScrollWindowEdgeLandingState = {
  x: number | null
  y: number | null
}

type ScrollWindowState = {
  engine: ScrollWindowEngineState
  gesture: ScrollWindowGestureState
  snap: ScrollWindowSnapState
  edgeLanding: ScrollWindowEdgeLandingState
  colliders: ScrollWindowColliderState
  scratch: ScrollWindowScratchState
}

/**
 * Builds the initial state tree. A function (rather than an inline field
 * literal) so shared mutable state such as `gesture.dragAmount` is created once
 * and then wired into the appropriate sub-group.
 */
function createScrollWindowState(): ScrollWindowState {
  const dragAmount = vec2.zero()
  return {
    engine: {
      config: null,
      snapParams: null,
      epsilon: 0,
      velocityBaseFrameTime: 0,
      minimumScrollingVelocity: 0,
      maxOvershootFactor: 0,
      horizontalScroller: null,
      verticalScroller: null,
      horizontalSnapPolicy: null,
      verticalSnapPolicy: null
    },
    gesture: {
      startPosition: vec3.zero(),
      interactorOffset: vec3.zero(),
      interactorUpdated: false,
      activeInteractor: null,
      isDragging: false,
      isControlledExternally: false,
      dragAmount,
      scrollTweenCancel: new CancelSet(),
      isTweeningScroll: false,
      wasScrollSettled: true
    },
    snap: {
      // True by default: the inspector seed is the raw "Scroll Position" input.
      // Pre-init normalized writes flip this false (last write wins).
      pendingInitialPositionIsRaw: true,
      committedSnapIndexX: null,
      committedSnapIndexY: null,
      snapIndexX: 0,
      snapIndexY: 0,
      snapIndexScratch: new vec2(0, 0),
      programmaticKickX: false,
      programmaticKickY: false,
      deferAnnounces: false,
      isDispatchingAnnounce: false,
      announceOwed: false
    },
    edgeLanding: {
      x: null,
      y: null
    },
    colliders: {
      colliderToElementMap: new Map<ColliderComponent, Element>(),
      childCollidersCache: null,
      lastChildCollidersEnabled: null,
      skipColliderManagement: false,
      enableChildCollidersBoundary: Rect.create(-1, 1, -1, 1),
      colliderInset: new vec2(0, 0),
      colliderShape: Shape.createBoxShape(),
      isSubscribedToEvents: false,
      eventUnsubscribes: []
    },
    scratch: {
      tweenLerp: new vec3(0, 0, 0),
      scrollPosUpdated: new vec2(0, 0),
      clampedBounds: new vec3(0, 0, 0),
      frictionStep: new vec3(0, 0, 0),
      snapStep: new vec3(0, 0, 0),
      snapSettleX: {position: 0, settled: true, alreadyAtTarget: true, velocity: 0},
      snapSettleY: {position: 0, settled: true, alreadyAtTarget: true, velocity: 0},
      snapSettleOptions: {earlyExitEpsilon: 0},
      dragPosition: new vec3(0, 0, 0),
      overscroll: new vec3(0, 0, 0)
    }
  }
}

/**
 * The low-level scrolling container.
 *
 * Children of this Component's SceneObject are masked into `windowSize` and
 * made scrollable across `scrollDimensions`.
 * - **Snap modes**: `scrollSnapping` toggles snapping on/off (off = free
 *   momentum scrolling); `snapMode` picks "paging" (settle on `snapRegion`
 *   multiples per gesture) or "detent" (resolve from gesture direction and
 *   also re-snap at idle)
 * - **Edge modes**: `edgeMode` of "elastic" (rubber-band bounce), "clamped"
 *   (hard stop); per-axis unbounded via `scrollDimensions = -1`
 * - **Scroll feel**: `feel` of "smooth" (classic long glide) or "crisp"
 * - **Top-left-anchored frame**: the scroller rests at local (0, 0) showing the
 *   authored view — what you lay out in the viewport is the initial view, and
 *   content resizes never shift it. y grows scrolling down through content
 *   (range [0, D−W]); x shrinks scrolling right (range [−(D−W), 0]).
 * - **Content origin**: where content-space (0,0) sits in the viewport.
 *   "Center" (default) keeps the classic authored-view frame. "TopLeft" puts
 *   (0,0) at the viewport's top-left corner — the scroll engine's page
 *   origin — so top-left-anchored content (a FlexLayout with Left/Top content
 *   alignment, or anything laid out in reading order toward +x/−y) drops in
 *   at local (0,0) with no half-window offset. The corner tracks windowSize
 *   resizes. Init-only.
 * - **Normalized position**: 0 = top/left, 1 = bottom/right; content starts at
 *   the top by default (the raw "Scroll Position" input seeds the start view)
 * - **Programmatic control**: `scrollPosition`, `tweenTo`, `setVelocity`, and
 *   external-control handoff (`isControlledExternally`) — programmatic writes
 *   land on gesture-disabled axes too (axis flags gate input, not the API)
 * - **Viewport helpers**: `frustum` and `getVisibleWindow*` for testing
 *   content visibility inside the masked window
 *
 * MIGRATION: (changed vs the classic center-anchored ScrollWindow) the
 * frame moved from center-origin to top-left-anchored — raw positions shift by
 * half the scroll span (y: new = old + (D.y−W.y)/2; x: new = old −
 * (D.x−W.x)/2); `scrollPositionNormalized`
 * changed from −1..1 center-origin (y +1 = top) to 0..1 (0 = top/left;
 * y: nNew = (1 − nOld)/2, x: nNew = (nOld + 1)/2); horizontal page 0 is now the
 * LEFTMOST page (was rightmost); `maxSnapOne` became `maxSnapStepsPerFling`
 * (true ≡ 1, false ≡ 0) with the default `pagingSnapCapMode` of
 * "gestureStart";
 * `getVisibleWindow` and `getVisibleWindowInto` keep their
 * −scrollPosition ± W/2 math but read it in the new frame — for the same
 * physical viewport pose on a bounded axis, raw corners shift by
 * +(D.x−W.x)/2 on x and −(D.y−W.y)/2 on y. The normalized helper then
 * divides those corners by D/2; over the scroll range its output spans
 * [W/D − 2, W/D] on y ([−W/D, 2 − W/D] on x) instead of the classic
 * exactly −1..1. Only RELATIVE item-vs-window tests in the same scroller-local
 * frame carry over; retained or otherwise absolute corner values must be
 * re-based (see the helper docs).
 * `edgeFade` is carried over unchanged.
 *
 * @example
 * ```typescript
 * const scrollWindow = sceneObject.getComponent(ScrollWindow.getTypeName());
 * scrollWindow.windowSize = new vec2(32, 32);
 * scrollWindow.scrollDimensions = new vec2(32, 200);
 *
 * scrollWindow.onScrollPositionUpdated.add((position) => {
 *   print("Scrolled to: " + position.y);
 * });
 * ```
 */
@component
export class ScrollWindow extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. ScrollWindow
   * is `Layoutable` but doesn't extend Element, so the brand is declared
   * explicitly here. See `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  // ─── Inspector Inputs ────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Scrolling</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Axes, viewport, content size, and start position</span>')
  @input
  @hint("Enable Vertical Scrolling")
  private _vertical: boolean = true
  @input
  @hint("Enable Horizontal Scrolling")
  private _horizontal: boolean = false

  @input("vec2", "{32,32}")
  @hint(
    "Size of masked window viewport in local space. <br><br>Note: to set dynamically, use the <code>windowSize</code> property"
  )
  private _windowSize: vec2 = new vec2(32, 32)
  @input("vec2", "{32,100}")
  @hint(
    "Size of total scrollable area. Use -1 on an axis for unbounded scrolling. <br><br>Note: to set dynamically, use <code>setScrollDimensions</code>"
  )
  private _scrollDimensions: vec2 = new vec2(32, 100)

  @input("vec2", "{0,0}")
  @label("Scroll Position")
  @hint(
    "Initial scroll position in raw local units, top-left anchored: the default (0,0) shows the content top-left (the authored view). y grows scrolling down through content; x shrinks scrolling right."
  )
  private _scrollPosition: vec2 = vec2.zero()

  @input("string", "Center")
  @label("Content Origin")
  @widget(new ComboBoxWidget([new ComboBoxItem("Top Left", "TopLeft"), new ComboBoxItem("Center", "Center")]))
  @hint(
    "Init-only. Where content-space (0,0) sits in the viewport. <code>Center</code> = classic authored-view frame (what you lay out around the origin is the initial view). <code>TopLeft</code> = (0,0) is the viewport's top-left corner (the scroll engine's page origin), so top-left-anchored layouts drop in at (0,0) with no half-window offset; content flows +x/−y."
  )
  private _contentOrigin: string = "Center"

  // ─── Snapping ────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Snapping</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Rest-position policy: free scrolling, page snapping, or per-item detents</span>'
  )
  @input
  @label("Scroll Snapping")
  @hint("Enable snapping to Snap Region multiples. Off = free momentum scrolling.")
  private _scrollSnapping: boolean = false

  @input("string", "paging")
  @showIf("_scrollSnapping")
  @widget(new ComboBoxWidget([new ComboBoxItem("Paging", "paging"), new ComboBoxItem("Detent", "detent")]))
  @hint(
    "Paging projects the continuous release position through its fling. Detent advances by gesture direction after the deadzone and re-snaps at idle, so the view always rests on a snap point."
  )
  private _snapMode: ScrollWindowSnapMode = "paging"

  @input("vec2", "{8,8}")
  @showIf("_scrollSnapping")
  @label("Snap Region")
  @hint("Per-axis size of each snap segment in local units.")
  private _snapRegion: vec2 = new vec2(8, 8)

  @input("string", "gestureStart")
  @showIf("_scrollSnapping")
  @label("Paging Cap Mode")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Gesture Start (Legacy)", "gestureStart"),
      new ComboBoxItem("Release Page (Cap at Release)", "releasePage")
    ])
  )
  @hint(
    "Paging only: Gesture Start caps the final target from the gesture start (legacy maxSnapOne behavior). Release Page anchors the cap at the page nearest release, so the cap does not truncate drag travel; an opposing fling can still settle behind the release page."
  )
  private _pagingSnapCapMode: ScrollWindowPagingSnapCapMode = "gestureStart"

  @input("int", "0")
  @showIf("_scrollSnapping")
  @label("Max Snap Steps Per Fling")
  @hint("Maximum snap steps. 0 = unlimited. Paging uses Paging Cap Mode; Detent preserves detents crossed by dragging.")
  private _maxSnapStepsPerFling: number = 0

  // ─── Behavior ────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Behavior</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Edge response and scroll feel</span>')
  @input("string", "elastic")
  @widget(new ComboBoxWidget([new ComboBoxItem("Elastic", "elastic"), new ComboBoxItem("Clamped", "clamped")]))
  @hint(
    "Edge behavior: Elastic = rubber-band overscroll with spring-back; Clamped = hard stop at bounds. For an unbounded axis, set that axis of Scroll Dimensions to -1."
  )
  private _edgeMode: ScrollWindowEdgeMode = "elastic"

  @input("string", "smooth")
  @widget(new ComboBoxWidget([new ComboBoxItem("Smooth", "smooth"), new ComboBoxItem("Crisp", "crisp")]))
  @hint("Deceleration/tuning bundle: Smooth = classic long glide; Crisp = short glide, firm feel.")
  private _feel: Feel = "smooth"

  // ─── Rendering ───────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Rendering</span>')
  @input
  @hint("Fade the content out at the edges toward Edge Fade Color <code>(rendering trick for transparency)</code>")
  private _edgeFade: boolean = false

  @input("vec3", "{0.1254902,0.1254902,0.1254902}")
  @widget(new ColorWidget())
  @showIf("_edgeFade")
  @hint(
    "Color the edge fade blends to. Defaults to the standard panel background; match your own backing panel color to fade over it."
  )
  // #202020 — matches PanelLevel0 in Themes/System-3.0/Colors.ts. Was pure
  // black, which only disappears over a black backing.
  private _edgeFadeColor: vec3 = new vec3(32 / 255, 32 / 255, 32 / 255)

  @input("int", "0")
  @showIf("_edgeFade")
  @hint(
    "Render order for the edge fade overlay. Leave at 0 unless you need the fade in a specific band relative to other chrome — it already layers over its own content via a depth bias plus hierarchy order."
  )
  private _renderOrder: number = 0

  // ─── Internal State ──────────────────────────────────────────────────

  private readonly state: ScrollWindowState = createScrollWindowState()

  /**
   * Pending pre-init normalized position (0..1 reading order) — written by
   * pre-init `scrollPositionNormalized` writes and consumed exactly once by
   * initialize() when `state.snap.pendingInitialPositionIsRaw` is false. The
   * raw "Scroll Position" input (`_scrollPosition`) is the default seed.
   */
  private _initialScrollPositionNormalized: vec2 = vec2.zero()

  private _initialized: boolean = false
  private _scrollingPaused: boolean = false
  /** Desired MaskingComponent enabled state; persists across SceneObject enable cycles. */
  private _maskingEnabledDesired: boolean = true
  /** Desired Interactable enabled state; persists across SceneObject enable cycles. */
  private _interactableEnabledDesired: boolean = true

  // Scene plumbing — component/scene handles resolved during initialize().
  private camera: WorldCameraFinderProvider = WorldCameraFinderProvider.getInstance()
  private cameraComponent = this.camera.getComponent()
  private transform: Transform
  private screenTransform: ScreenTransform
  private collider: ColliderComponent
  private _interactable: Interactable
  private maskingComponent: MaskingComponent
  private rmv: RenderMeshVisual
  private material: Material = requireAsset("../../../Materials/ScrollWindowFadeMask.mat") as Material
  // Edge-fade overlay state — builder + host object for the band mesh, and
  // scroll-driven per-side strengths.
  private fadeObject: SceneObject | null = null
  private fadeMeshBuilder: MeshBuilder | null = null
  private edgeFadeRamp: number = 0
  private lastEdgeFadeStrength: vec4 = new vec4(1, 1, 1, 1)
  private managedSceneObjects: SceneObject[] = []
  private managedComponents: Component[] = []
  private scroller: SceneObject
  private scrollerTransform: Transform
  // "TopLeft" content-origin node, parented between the scroller and content
  // at the viewport's top-left corner. Null in "Center" mode. The scroller's
  // position stays == scrollPosition either way — the scroll engine and every
  // position consumer are unaffected; only the content frame shifts.
  private contentOriginNode: SceneObject | null = null
  private debugRender: boolean = false

  /**
   * Frustum for testing whether content is visible within the scroll window. Recomputes lazily
   * on access (at most once per frame), so it's always current without {@link updateFrustum}.
   * If you read many planes/corners in a tight loop, cache them in locals.
   */
  public readonly frustum: Frustum = new Frustum()

  /**
   * When true, pre-warms {@link frustum} every LateUpdate. Off by default — the frustum already
   * refreshes lazily on read, so most consumers never need this (debug render refreshes it anyway).
   * Code-only (set in code, not an Inspector `@input`).
   */
  public updateFrustum: boolean = false

  // Poke-scroll (physical / direct-pinch) state from main's poke-scroll feature, grouped into one
  // container. Shared gesture fields (startPosition / interactorOffset / interactorUpdated /
  // activeInteractor) live in state.gesture; only poke-specific state is here.
  // Touched only during a physical / direct-pinch gesture, not the hands-out settle.
  private _poke = {
    // State machine governing gesture capture / engage / release independently of IK's spherecast
    // hit set (see ScrollGestureInterceptor). Driven from update() (LateUpdate), seeded from
    // onInteractableTriggerStart. engageDwellFrames 4 (~67 ms @60fps) filters tap lateral residue.
    gestureInterceptor: new ScrollGestureInterceptor(
      SCROLL_LATERAL_DEADZONE_CM,
      /* notTouchingGraceFrames */ 5,
      /* engageDwellFrames */ 4
    ),
    // Most recent trigger-start event, stashed so cancelChildInteraction has a valid
    // InteractableEventArgs when the interceptor transitions to Engaged.
    lastTriggerStartEvent: null as InteractorEvent | null,
    // Child Interactable that received the FIRST TriggerStart of this gesture — captured on
    // Idle → Intercepting, unchanged across drift swaps (unlike lastTriggerStartEvent). Lets
    // shouldSuppressChildEventDuringGesture tell the original target's clean retract from a
    // swap-target's spurious tap.
    originalPokeTarget: null as Interactable | null,
    // World-space intersection at gesture start; the deadzone check needs a real-cm scalar
    // invariant under scene scale. Re-anchored by the forward-velocity gate to track from "landing".
    gestureStartWorld: null as vec3 | null,
    // Engagement-plane anchor + normal for the line-segment-crosses-plane check
    // (isFingerStillEngaged). Anchored at FINGERTIP DEPTH (not the back-plane raycast — a child in
    // front would lose engagement on tick 0). Normal captured once so mid-gesture parent rotation
    // doesn't swing the plane.
    _initialPokePlanePoint: null as vec3 | null,
    _initialPlaneNormal: null as vec3 | null,
    // True when the gesture is driven by ScrollGestureInterceptor (poke / direct pinch); false for
    // indirect (HandInteractor indirect, Mouse, Mobile) which use IK's onDragUpdate directly.
    useStateMachine: false,
    // Previous-tick intersection world-position; feeds anti-hook lateral delta.
    _prevIntersectionWorld: null as vec3 | null,
    // Previous-tick fingertip-to-plane signed distance; feeds forward-velocity gate.
    _prevSignedDistance: null as number | null,
    // Last interactorPos applied to the scroller, after anti-hook axis masking.
    _lastAppliedInteractorPos: null as vec3 | null,
    // Per-axis anti-hook-mask state from the previous tick. On a true→false flip the lost-motion
    // delta is absorbed into the gesture anchors so dragAmount stays continuous across recovery
    // (else the recovery frame applies the full masked-out motion as one jump → exaggerated fling
    // sample).
    _wasMaskedAxisX: false,
    _wasMaskedAxisY: false
  }

  // ─── Events ──────────────────────────────────────────────────────────

  private readonly events = {
    initialized: new ReplayEvent<void>(),
    scrollDrag: new Event<ScrollEventArg>(),
    scrollDimensionsUpdated: new Event<vec2>(),
    scrollPositionUpdated: new Event<vec2>(),
    scrollEnd: new Event<void>(),
    sizeChanged: new Event<vec3>(),
    snapIndexChanged: new Event<vec2>(),
    scrollEngaged: new Event<ScrollEngagedArg>(),
    scrollDisengaged: new Event<ScrollGestureEndArg>(),
    scrollRejected: new Event<ScrollGestureEndArg>()
  }

  /** Event that fires when the ScrollWindow has been initialized. */
  public readonly onInitialized: PublicApi<void> = this.events.initialized.publicApi()

  /**
   * Event that fires during scroll drag interactions. The payload and its
   * `vec2` fields are fresh per event, so subscribers may safely retain them.
   */
  public readonly onScrollDrag: PublicApi<ScrollEventArg> = this.events.scrollDrag.publicApi()

  /**
   * Event that fires when scroll dimensions are updated. The emitted `vec2` is
   * mutable ScrollWindow-owned state; copy `x` / `y` values if retaining
   * them beyond the callback.
   */
  public readonly onScrollDimensionsUpdated: PublicApi<vec2> = this.events.scrollDimensionsUpdated.publicApi()

  /**
   * Event that fires when the scroll position is updated (local space). The
   * emitted `vec2` is a mutable scratch reference reused by ScrollWindow;
   * copy `x` / `y` values if retaining them beyond the callback.
   *
   * MIGRATION: the payload is a raw top-left-anchored position, shifted by
   * half the scroll span vs the classic center-anchored ScrollWindow (y adds
   * (D.y−W.y)/2; x subtracts (D.x−W.x)/2). Consumers that keyed off the old
   * center-origin values must re-base. See the class-level MIGRATION note.
   */
  public readonly onScrollPositionUpdated: PublicApi<vec2> = this.events.scrollPositionUpdated.publicApi()

  /**
   * Event that fires when scroll motion finishes (drag ended, spring settled,
   * content in bounds). May fire multiple times per gesture if the spring
   * bounces and re-settles.
   */
  public readonly onScrollEnd: PublicApi<void> = this.events.scrollEnd.publicApi()

  /** Event that fires when the layout size of the scroll window changes. */
  public readonly onSizeChanged: PublicApi<vec3> = this.events.sizeChanged.publicApi()

  /**
   * Event that fires when the snap selection changes: at snap-target commit
   * time (fling release, detent idle re-snap — commits made inside the physics
   * pass fire after that frame's final position write), and as a rest-position
   * correction when motion ends or the view is repositioned without a commit
   * (interrupted snap, tween destination, programmatic position write) —
   * announcing the valid page nearest the actual position. Programmatic-write
   * corrections dispatch synchronously after that setter's position and
   * velocity work is complete. Subscribers may safely write `scrollPosition`
   * from either path; reentrant changes are coalesced and announced after the
   * current listener pass, up to a bounded synchronous drain budget. Excess
   * listener feedback is cut off so it cannot stall the frame. x = horizontal
   * page index, y = vertical page index in the reading-order frame (0 = top /
   * left). Fires for paging and detent modes. The emitted `vec2` is a mutable
   * scratch reference reused between announcements; copy `x` / `y` values if
   * retaining them beyond the callback.
   */
  public readonly onSnapIndexChanged: PublicApi<vec2> = this.events.snapIndexChanged.publicApi()

  /**
   * Fires once when a gesture transitions from `Intercepting` → `Engaged`
   * (lateral motion crossed the deadzone). One event per scroll session.
   * Distinct from {@link onScrollEnd} (motion-settle, may fire multiple times).
   */
  public readonly onScrollEngaged: PublicApi<ScrollEngagedArg> = this.events.scrollEngaged.publicApi()

  /** Fires once when an engaged scroll ends. Counterpart to {@link onScrollEngaged}. */
  public readonly onScrollDisengaged: PublicApi<ScrollGestureEndArg> = this.events.scrollDisengaged.publicApi()

  /** Fires once when a candidate gesture ends without ever engaging. */
  public readonly onScrollRejected: PublicApi<ScrollGestureEndArg> = this.events.scrollRejected.publicApi()

  // ─── Public Getters / Setters ────────────────────────────────────────

  /**
   * Whether scrolling is currently paused
   * @returns true if scrolling is paused, false otherwise
   */
  public get scrollingPaused(): boolean {
    return this._scrollingPaused
  }

  /**
   * Pause or resume scrolling
   * @param scrollingPaused - true to pause scrolling, false to resume
   */
  public set scrollingPaused(scrollingPaused: boolean) {
    const engine = this.state.engine
    if (this._initialized && scrollingPaused) {
      this.cancelCurrentInteractor(ScrollGestureEndReason.Paused, "scrollingPaused setter flipped mid-gesture")
      // Latch clears must precede syncScrollEndState — the end event depends on them.
      this.clearSnapTarget("x")
      this.clearSnapTarget("y")
      engine.horizontalSnapPolicy!.setStartAnchor(0, 0)
      engine.verticalSnapPolicy!.setStartAnchor(0, 0)
      this.syncScrollEndState()
    } else if (this._initialized && this._scrollingPaused && !scrollingPaused) {
      // Re-seed snap anchors from the current position — otherwise a programmatic
      // setVelocity() right after resume snaps relative to page 0's deadzone.
      const scrollerPosition = this.scrollerTransform.getLocalPosition()
      engine.horizontalSnapPolicy!.setStartAnchor(
        this.getPageIndexFromPosition("x", scrollerPosition.x),
        scrollerPosition.x
      )
      engine.verticalSnapPolicy!.setStartAnchor(
        this.getPageIndexFromPosition("y", scrollerPosition.y),
        scrollerPosition.y
      )
    }
    this._scrollingPaused = scrollingPaused
  }

  /**
   * Gets whether this scroll window is initialized.
   * @returns True if the scroll window is initialized, false otherwise.
   */
  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * Gets the width of the scroll window layout in local space centimeters.
   * @returns The current width of the scroll window.
   */
  public get width(): number {
    return this._windowSize.x
  }

  /**
   * Sets the width of the scroll window.
   * @param value - The new width value.
   */
  public set width(value: number) {
    this.windowSize = new vec2(value, this._windowSize.y)
  }

  /**
   * Gets the height of the scroll window layout in local space centimeters.
   * @returns The current height of the scroll window.
   */
  public get height(): number {
    return this._windowSize.y
  }

  /**
   * Sets the height of the scroll window.
   * @param value - The new height value.
   */
  public set height(value: number) {
    this.windowSize = new vec2(this._windowSize.x, value)
  }

  /**
   * Gets the depth of the scroll window layout in local space centimeters.
   * @returns The current depth of the scroll window.
   */
  public get depth(): number {
    return 1
  }

  /**
   * Sets the depth of the scroll window.
   * This is a no-op as depth is not configurable for 2D components.
   * @param value - The new depth value (ignored).
   */
  public set depth(value: number) {}

  /**
   * Gets the current size of the layout as a vec3 (width, height, depth).
   * @returns The layout size with width, height, and depth.
   */
  public get layoutSize(): vec3 {
    return new vec3(this.width, this.height, this.depth)
  }

  /**
   * Gets the child SceneObjects in the content of the scroll window
   * (empty until initialized).
   */
  public get children(): SceneObject[] {
    if (!this._initialized) {
      return []
    }
    return (this.contentOriginNode ?? this.scroller).children
  }

  /**
   * The Interactable component of this scroll window
   * @returns Interactable component
   */
  public get interactable(): Interactable {
    return this._interactable
  }

  /** Enables the internal MaskingComponent. Persists across SceneObject enable cycles. */
  public get maskingEnabled(): boolean {
    return this._maskingEnabledDesired
  }

  /**
   * Enables or disables the internal MaskingComponent.
   * @param enabled - true to enable masking, false to disable
   */
  public set maskingEnabled(enabled: boolean) {
    this._maskingEnabledDesired = enabled
    if (this.maskingComponent) {
      this.maskingComponent.enabled = enabled
    }
  }

  /** Enables the internal Interactable. Persists across SceneObject enable cycles. */
  public get interactableEnabled(): boolean {
    return this._interactableEnabledDesired
  }

  /**
   * Enables or disables the internal Interactable.
   * @param enabled - true to enable the Interactable, false to disable
   */
  public set interactableEnabled(enabled: boolean) {
    this._interactableEnabledDesired = enabled
    if (this._interactable) {
      this._interactable.enabled = enabled
    }
  }

  /**
   * Whether vertical scrolling is enabled
   * @returns true if vertical scrolling is enabled, false otherwise
   */
  public get vertical(): boolean {
    return this._vertical
  }

  /**
   * Whether vertical scrolling is enabled
   * @param value - true to enable vertical scrolling, false to disable.
   * Disabling kills the axis's in-flight motion (fling, snap, edge landing) —
   * update()'s physics arms only run for enabled axes, so motion left latched
   * on a disabled axis could never finish (blocking the scroll-end event) and
   * would replay, un-decayed, on re-enable.
   */
  public set vertical(value: boolean) {
    if (value === undefined || value === this._vertical) return
    this._vertical = value
    if (!value && this._initialized) {
      this.quiesceDisabledAxis("y")
    }
    // Fade strips are built per scrollable axis — rebuild on runtime flips.
    if (this._edgeFade) {
      this.refreshEdgeFade()
    }
  }

  /**
   * Whether horizontal scrolling is enabled
   * @returns true if horizontal scrolling is enabled, false otherwise
   */
  public get horizontal(): boolean {
    return this._horizontal
  }

  /**
   * Where content-space (0,0) sits in the viewport: "Center" (the classic
   * authored-view frame) or "TopLeft" ((0,0) = the viewport's top-left
   * corner, the scroll engine's page origin).
   */
  public get contentOrigin(): string {
    return this._contentOrigin
  }

  /** Init-only. Set before {@link initialize}. */
  public set contentOrigin(value: string) {
    if (this._initialized) {
      log.w("contentOrigin is init-only and cannot be changed after initialization")
      return
    }
    if (value !== "Center" && value !== "TopLeft") {
      log.w(`unsupported contentOrigin "${value}"`)
      return
    }
    this._contentOrigin = value
  }

  /**
   * Whether horizontal scrolling is enabled
   * @param value - true to enable horizontal scrolling, false to disable.
   * Disabling kills the axis's in-flight motion (fling, snap, edge landing) —
   * see {@link vertical}.
   */
  public set horizontal(value: boolean) {
    if (value === undefined || value === this._horizontal) return
    this._horizontal = value
    if (!value && this._initialized) {
      this.quiesceDisabledAxis("x")
    }
    // Fade strips are built per scrollable axis — rebuild on runtime flips.
    if (this._edgeFade) {
      this.refreshEdgeFade()
    }
  }

  /**
   * Whether this scroll window is controlled externally
   * @returns true if controlled externally, false otherwise
   */
  public get isControlledExternally(): boolean {
    return this.state.gesture.isControlledExternally
  }

  /**
   * Whether this scroll window is controlled externally
   * @param value - true to control externally, false to control internally
   */
  public set isControlledExternally(value: boolean) {
    if (value === undefined) {
      return
    }
    const gesture = this.state.gesture
    if (!value) {
      this.releaseExternalControl()
      return
    }
    if (gesture.isControlledExternally) {
      return
    }
    if (this._initialized) {
      // Taking external control mid-gesture: flush the in-flight gesture so
      // Disengaged fires with proper timing. Without this, `isDragging` stays
      // set across the takeover and the next end path emits an unpaired
      // Disengaged whose Engaged was on the prior input-driven session.
      if (
        gesture.isDragging ||
        gesture.interactorUpdated ||
        gesture.activeInteractor !== null ||
        this._poke.gestureInterceptor.isActive
      ) {
        this.cancelCurrentInteractor(ScrollGestureEndReason.Canceled, "external control assumed mid-gesture")
      }
      // Anchor external-control displacement at the takeover pose.
      // cancelCurrentInteractor re-seeds the Detent policy independently but
      // does not update the gesture origin used by external-control deltas.
      this.resetDragState()
    }
    gesture.isControlledExternally = true
  }

  /**
   * Ends an external-control session.
   *
   * `allowFling = true` preserves the historical handoff: sampled position
   * velocity becomes momentum. External position APIs normalize samples before
   * smoothing/freshness, so Feel, SnapMode, thresholds, accumulation, and
   * settling all operate in one coordinate space.
   *
   * @param allowFling - Whether sampled external velocity should become momentum.
   */
  public releaseExternalControl(allowFling: boolean = true): void {
    const gesture = this.state.gesture
    if (!gesture.isControlledExternally) {
      return
    }
    if (this._initialized) {
      if (!allowFling) {
        // Drop sampled/chained velocity, then latch a zero-velocity release.
        // The latch is important: Paging has no idle re-snap path, while Detent
        // should retain its slow-drag/deadzone decision rather than fling ahead.
        const engine = this.state.engine
        engine.horizontalScroller!.cancelMotion()
        engine.verticalScroller!.cancelMotion()
      }
      this.applyAccumulatedVelocity()
    }
    gesture.isControlledExternally = false
  }

  /**
   * Gets whether the scroller snaps to Snap Region multiples.
   * @returns True when snapping is enabled.
   */
  public get scrollSnapping(): boolean {
    return this._scrollSnapping
  }

  /**
   * Sets whether the scroller snaps to Snap Region multiples.
   * Toggling either way clears any committed snap target (leaving snapping
   * mid-flight must not strand the latch and block the scroll-end event) and
   * re-seeds the per-axis projection anchors from the current position — so enabling
   * snapping in a purely programmatic flow can't project against a stale (or
   * never-seeded) gesture anchor. A detent scroller then re-snaps at the next
   * idle.
   * @param value - True to enable snapping.
   */
  public set scrollSnapping(value: boolean) {
    if (value === undefined || value === this._scrollSnapping) return
    this._scrollSnapping = value
    if (this._initialized) {
      const scrollerPosition = this.scrollerTransform.getLocalPosition()
      this.reseedSnapAxis("x", scrollerPosition.x)
      this.reseedSnapAxis("y", scrollerPosition.y)
    }
  }

  /**
   * Gets how the scroller chooses rest positions while snapping is enabled.
   * @returns The current snap mode.
   */
  public get snapMode(): ScrollWindowSnapMode {
    return this._snapMode
  }

  /**
   * Sets how the scroller chooses rest positions while snapping is enabled
   * (see {@link scrollSnapping} to toggle snapping itself).
   * Changing modes mid-snap clears any committed snap target so motion can
   * resolve under the new mode: a pending fling is re-projected by the snap
   * path, and "detent" re-snaps at idle. Without the clear, switching modes
   * mid-flight would strand the latch and block the scroll-end event until
   * the next drag.
   * @param value - The snap mode to apply.
   */
  public set snapMode(value: ScrollWindowSnapMode) {
    if (value === undefined || value === this._snapMode) return
    this._snapMode = value
    if (this._initialized) {
      this.clearSnapTarget("x")
      this.clearSnapTarget("y")
    }
  }

  /**
   * Gets the per-axis size of each snap segment in local units (V1 parity name).
   * @returns The snap region (page size or item extent per axis).
   */
  public get snapRegion(): vec2 {
    return this._snapRegion
  }

  /**
   * Sets the per-axis size of each snap segment in local units.
   * Changing an axis's snap region mid-snap clears that axis's committed target
   * and re-seeds its projection anchor on the new grid; a paging scroller at rest may
   * sit off the new grid until the next gesture, while detent re-snaps at idle.
   * @param value - The snap region (page size or item extent per axis).
   */
  public set snapRegion(value: vec2) {
    if (value === undefined || isEqual(value, this._snapRegion)) return
    const previous = this._snapRegion
    this._snapRegion = value
    if (this._initialized) {
      const scrollerPosition = this.scrollerTransform.getLocalPosition()
      if (previous.x !== value.x) this.reseedSnapAxis("x", scrollerPosition.x)
      if (previous.y !== value.y) this.reseedSnapAxis("y", scrollerPosition.y)
    }
  }

  /** Gets the page used as Paging's finite-cap anchor. */
  public get pagingSnapCapMode(): ScrollWindowPagingSnapCapMode {
    return this._pagingSnapCapMode
  }

  /**
   * Sets Paging's cap reference. "gestureStart" is the compatibility default:
   * the final target is capped from the gesture's starting page. "releasePage"
   * anchors the cap at the page nearest release, so the cap does not truncate
   * drag travel; an opposing fling may still settle behind the release page.
   * Detent ignores this setting and always preserves physically crossed detents.
   * A committed target remains valid; the new mode applies next projection.
   */
  public set pagingSnapCapMode(value: ScrollWindowPagingSnapCapMode) {
    if (value !== "gestureStart" && value !== "releasePage") return
    this._pagingSnapCapMode = value
  }

  /**
   * Gets the finite snap-step cap. Paging interprets it through
   * {@link pagingSnapCapMode}; Detent caps projected travel without pulling
   * back detents physically crossed by the drag.
   * @returns The cap, where 0 means unlimited.
   */
  public get maxSnapStepsPerFling(): number {
    return this._maxSnapStepsPerFling
  }

  /**
   * Sets the snap-step cap. For Paging, the default "gestureStart" mode makes
   * 1 equivalent to legacy maxSnapOne=true; "releasePage" prevents the cap
   * itself from truncating drag travel, though an opposing fling may move back.
   * Detent always preserves crossed detents.
   * A committed snap target is not invalidated — it was valid under the rules
   * at commit time; the new cap applies to the next projection.
   * @param value - The cap; 0 means unlimited.
   */
  public set maxSnapStepsPerFling(value: number) {
    if (value === undefined || !Number.isFinite(value) || value < 0) return
    this._maxSnapStepsPerFling = Math.floor(value)
  }

  /**
   * Gets the edge behavior at the scroll bounds.
   * @returns "elastic" (rubber-band overscroll) or "clamped" (hard stop).
   */
  public get edgeMode(): ScrollWindowEdgeMode {
    return this._edgeMode
  }

  /**
   * Sets the edge behavior at the scroll bounds.
   * @param value - "elastic" or "clamped".
   */
  public set edgeMode(value: ScrollWindowEdgeMode) {
    if (value === undefined || value === this._edgeMode) return
    this._edgeMode = value
    if (this._initialized) {
      this.clearEdgeLanding()
      if (value !== "elastic") {
        // Entering a clamped-family mode mid-overscroll: every in-bounds
        // recovery path is elastic-only, so an out-of-bounds position would
        // rest visibly overscrolled forever — clamp back now.
        const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(this.scrollerTransform.getLocalPosition())
        if (boundsCheck.isOutOfBounds) {
          this.updateScrollerPosition(boundsCheck.clamped, false)
        }
      }
    }
  }

  /**
   * Whether edge fade is enabled
   * @returns true if edge fade is enabled, false otherwise
   */
  public get edgeFade(): boolean {
    return this._edgeFade
  }

  /**
   * Whether edge fade is enabled
   * @param value - true to enable edge fade, false to disable
   */
  public set edgeFade(value: boolean) {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this.enableEdgeFade(value)
    } else {
      this._edgeFade = value
    }
  }

  /**
   * The color the edge fade blends to at the window border
   * @returns the current edge fade color
   */
  public get edgeFadeColor(): vec3 {
    return this._edgeFadeColor
  }

  /**
   * The color the edge fade blends to at the window border.
   * Black reads as transparent on device; match a backing panel color to fade over it.
   * @param color - the edge fade color
   */
  public set edgeFadeColor(color: vec3) {
    if (color === undefined) {
      return
    }
    this._edgeFadeColor = color
    if (this.rmv) {
      this.material.mainPass.fadeColor = color
    }
  }

  /**
   * Render order of the edge fade overlay, 0 by default.
   *
   * The fade is layered over its own content by a depth bias
   * (EDGE_FADE_DEPTH_BIAS) plus hierarchy order, not by out-ranking content on
   * renderOrder — so it stays depth-sortable against UI outside this window
   * (overlapping panels, a field docked forward to the keyboard). Raise this
   * only to place the fade in a specific band relative to other chrome.
   * @returns the render order
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Render order of the edge fade overlay.
   * @param order - the render order
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    this._renderOrder = order
    this.applyEdgeFadeRenderOrder()
  }

  /**
   * Gets the deceleration/tuning bundle driving the scroll feel.
   * @returns "smooth" (classic long glide) or "crisp" (short glide, firm feel).
   */
  public get feel(): Feel {
    return this._feel
  }

  /**
   * Sets the deceleration/tuning bundle driving the scroll feel.
   * The physics config is immutable after construction, so this rebuilds the
   * per-axis scrollers and snap policies — any in-flight gesture or motion is
   * dropped by design, and the snap anchors are re-seeded from the current position.
   * @param value - "smooth" or "crisp".
   */
  public set feel(value: Feel) {
    if (value === undefined || value === this._feel) return
    this._feel = value
    if (this._initialized) {
      this.cancelCurrentInteractor(ScrollGestureEndReason.Canceled, "feel setter rebuilt the scroll engine mid-gesture")
      // Clear latches AND their index twins before the rebuild — fresh policies
      // implicitly clear the latches, which would strand stale twins.
      this.clearSnapTarget("x")
      this.clearSnapTarget("y")
      this.clearEdgeLanding()
      this.buildScrollEngine()
      const engine = this.state.engine
      const scrollerPosition = this.scrollerTransform.getLocalPosition()
      engine.horizontalSnapPolicy!.setStartAnchor(
        this.getPageIndexFromPosition("x", scrollerPosition.x),
        scrollerPosition.x
      )
      engine.verticalSnapPolicy!.setStartAnchor(
        this.getPageIndexFromPosition("y", scrollerPosition.y),
        scrollerPosition.y
      )
    } else if (this.state.engine.config) {
      // Post-onAwake, pre-initialize: rebuild so initialize() uses the new feel.
      this.buildScrollEngine()
    }
  }

  /**
   * Gets the current snap page indices in the reading-order frame (0 = top / left):
   * the committed target index while a snap is in flight, else the valid page
   * nearest the last rest (or programmatically written) position.
   * @returns A fresh vec2 of (x page index, y page index).
   */
  public get snapIndex(): vec2 {
    const snap = this.state.snap
    return new vec2(snap.committedSnapIndexX ?? snap.snapIndexX, snap.committedSnapIndexY ?? snap.snapIndexY)
  }

  /**
   * When true, disables the default child collider management.
   * Useful for virtualized scroll windows that manage colliders themselves.
   *
   * Set before any colliders are added; flipping after `enableChildColliders`
   * has run will not undo prior toggles.
   */
  public get skipColliderManagement(): boolean {
    return this.state.colliders.skipColliderManagement
  }

  /**
   * Sets whether the default child collider management is skipped.
   * @param value - true to let an owner manage descendant colliders itself.
   */
  public set skipColliderManagement(value: boolean) {
    this.state.colliders.skipColliderManagement = value
  }

  /**
   * The scroll position in raw local units, top-left anchored (default (0,0) =
   * content top-left).
   *
   * MIGRATION: raw values shifted vs the classic center-anchored ScrollWindow —
   * y: new = old + (D.y−W.y)/2; x: new = old − (D.x−W.x)/2
   * (D = scrollDimensions, W = windowSize). Code that reads or writes absolute
   * scrollPosition must be re-based; prefer `scrollPositionNormalized` if you
   * only need a fractional position. See the class-level MIGRATION note.
   */
  public get scrollPosition(): vec2 {
    return this._scrollPosition
  }

  /**
   * Whether a content rebase can preserve the active drag. Snap and tween
   * position writes do not translate drag anchors; defer publication until that
   * drag ends. Outside a drag their ordinary position-write behavior is safe.
   */
  public get canRebaseScrollPosition(): boolean {
    return !this.state.gesture.isDragging || (this.effectiveSnapMode === "none" && !this.state.gesture.isTweeningScroll)
  }

  /**
   * Rebase free-scroll content coordinates after insertion, without treating
   * the offset as finger travel or canceling the current fling. Call outside
   * scroll event dispatch. Snapping windows and active tweens retain normal
   * position-write behavior: a tween's captured endpoints cannot be rebased.
   * Check canRebaseScrollPosition before changing content during an active drag.
   */
  public rebaseScrollPosition(position: vec2): void {
    if (!this._initialized || this.effectiveSnapMode !== "none" || this.state.gesture.isTweeningScroll) {
      this.scrollPosition = position
      return
    }
    const current = this.scrollerTransform.getLocalPosition()
    let target = this.clampLockedAxes(new vec3(position.x, position.y, current.z))
    if (this.edgeClamped) target = this.getClampedBoundsAndCheckOutOfBounds(target).clamped
    const dx = target.x - current.x
    const dy = target.y - current.y
    const {gesture, engine} = this.state
    gesture.startPosition.x += dx
    gesture.startPosition.y += dy
    engine.horizontalScroller!.offsetGestureAnchor(dx)
    engine.verticalScroller!.offsetGestureAnchor(dy)
    if (gesture.isDragging) {
      // Velocity samples live in displayed space, but drag anchors precede the
      // resistance curve. Reconstruct the raw pose under the updated bounds so
      // a stationary finger reproduces the rebased displayed position.
      const inputX = gesture.interactorOffset.x + gesture.dragAmount.x
      const inputY = gesture.interactorOffset.y + gesture.dragAmount.y
      engine.horizontalScroller!.startPosition +=
        this.getUnresistedDragPosition("x", target.x) - engine.horizontalScroller!.getDragPosition(inputX)
      engine.verticalScroller!.startPosition +=
        this.getUnresistedDragPosition("y", target.y) - engine.verticalScroller!.getDragPosition(inputY)
    }
    this.clearEdgeLanding()
    // Publish last: reentrant observers see matching gesture and content frames.
    this.updateScrollerPosition(target, false)
  }

  /**
   * The scroll position in local space.
   * Programmatic writes land even on gesture-disabled axes (the vertical /
   * horizontal flags gate input, not the API) but never overscroll them.
   */
  public set scrollPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    if (this._initialized) {
      this.prepareProgrammaticPositionWrite()
      const scrollerLocalPosition = this.scrollerTransform.getLocalPosition()
      let newPosition = new vec3(position.x, position.y, scrollerLocalPosition.z)

      newPosition = this.applyOverscrollIfNeeded(newPosition)
      this.clampLockedAxes(newPosition)

      this.updateScrollerPosition(newPosition, false)

      if (this.state.gesture.isControlledExternally || this.effectiveSnapMode !== "none") {
        this.updateVelocityFromPosition(newPosition)
      }
      // The write repositions the view without a snap commit — track the
      // announced indices (a from-rest write never re-enters the snap path,
      // so nothing else would correct them).
      // Must remain the final operation: listeners may re-enter this setter,
      // and with no outer work afterward the nested position write wins.
      this.announceRestingSnapIndices(newPosition)
    } else {
      this._scrollPosition = position
      this.state.snap.pendingInitialPositionIsRaw = true
    }
  }

  /**
   * The scroll position in normalized space.
   * 0..1 on x (0 = content left/start, 1 = content right/end) if scrollDimensions.x is not -1,
   * otherwise the raw scroll position.x in local space.
   * 0..1 on y (0 = content top, 1 = content bottom) if scrollDimensions.y is not -1,
   * otherwise the raw scroll position.y in local space.
   * Values transiently extrapolate outside [0, 1] during elastic overscroll.
   * Once initialized, an axis whose content fits has no scroll range and reads 0,
   * even though it is at both ends (also during elastic overscroll). An "at the
   * end" check such as `n > 0.98` never passes there, so check overflow first.
   *
   * MIGRATION: differs from the pre-merge center-anchored ScrollWindow, whose
   * normalized space was -1..1 with 0 = centered (y: +1 = top). For consumers:
   * nNew = (1 - nOld) / 2 on y, nNew = (nOld + 1) / 2 on x (bounded
   * axes). A scrollbar binding maps sliderValue = 1 - n on y — the old
   * transforms (n / 2 + 0.5 and v * 2 - 1) are NOT identity here.
   */
  public get scrollPositionNormalized(): vec2 {
    const engine = this.state.engine
    const normalizedScrollPosition = vec2.zero()
    if (!this._initialized && !this.state.snap.pendingInitialPositionIsRaw) {
      // Pre-init reads mirror a pending normalized write (raw on unbounded axes).
      normalizedScrollPosition.x = this._initialScrollPositionNormalized.x
      normalizedScrollPosition.y = this._initialScrollPositionNormalized.y
      return normalizedScrollPosition
    }
    // Initialized reads — and pre-init reads of the raw "Scroll Position" seed,
    // converted best-effort with the current (possibly not final) geometry —
    // derive from the raw position below.
    // Non-scrollable axes (content fits or is smaller than the window) read as 0.
    if (this._scrollDimensions.x !== -1) {
      normalizedScrollPosition.x = isAxisScrollable(this._scrollDimensions.x, this._windowSize.x, engine.epsilon)
        ? normalizedFromPosition(this._scrollPosition.x, this.leftEdge, this.rightEdge, engine.epsilon)
        : 0
    } else {
      normalizedScrollPosition.x = this._scrollPosition.x
    }
    if (this._scrollDimensions.y !== -1) {
      normalizedScrollPosition.y = isAxisScrollable(this._scrollDimensions.y, this._windowSize.y, engine.epsilon)
        ? normalizedFromPosition(this._scrollPosition.y, this.topEdge, this.bottomEdge, engine.epsilon)
        : 0
    } else {
      normalizedScrollPosition.y = this._scrollPosition.y
    }
    return normalizedScrollPosition
  }

  /**
   * Sets the scroll position in normalized space (0 = top/left, 1 = bottom/right;
   * raw local-space values on unbounded axes). Before initialization the value is
   * stored as-is and converted once geometry is final — eager conversion would go
   * stale if the dimensions change before initialize().
   */
  public set scrollPositionNormalized(normalizedPosition: vec2) {
    this.setScrollPositionNormalized(normalizedPosition)
  }

  /**
   * Streams a normalized position from an external controller with a per-axis
   * velocity conversion. The correction is applied before smoothing, history,
   * and freshness checks; call while {@link isControlledExternally} is true.
   *
   * @param normalizedPosition - Reading-order position (0 = top/left, 1 = bottom/right).
   * @param velocityScale - Conversion from position velocity to ScrollWindow-local hand velocity.
   */
  public setExternalScrollPositionNormalized(normalizedPosition: vec2, velocityScale: vec2): void {
    this.setScrollPositionNormalized(normalizedPosition, velocityScale)
  }

  private setScrollPositionNormalized(normalizedPosition: vec2, velocityScale?: vec2): void {
    if (normalizedPosition === undefined) {
      return
    }
    // External controllers may reuse their scale vector. Capture its scalar
    // values before updateScrollerPosition dispatches reentrant listeners.
    const velocityScaleX = velocityScale?.x
    const velocityScaleY = velocityScale?.y
    if (this._initialized) {
      this.prepareProgrammaticPositionWrite()

      const scrollerLocalPosition = this.scrollerTransform.getLocalPosition()
      let newPosition = new vec3(
        this.positionFromNormalizedX(normalizedPosition.x),
        this.positionFromNormalizedY(normalizedPosition.y),
        scrollerLocalPosition.z
      )

      newPosition = this.applyOverscrollIfNeeded(newPosition)
      this.clampLockedAxes(newPosition)

      this.updateScrollerPosition(newPosition, false)

      if (this.state.gesture.isControlledExternally || this.effectiveSnapMode !== "none") {
        this.updateVelocityFromPosition(newPosition, velocityScaleX, velocityScaleY)
      }
      // Track the announced indices across the write (see scrollPosition).
      // Must remain the final operation so a listener's reentrant write wins.
      this.announceRestingSnapIndices(newPosition)
    } else {
      this._initialScrollPositionNormalized.x = normalizedPosition.x
      this._initialScrollPositionNormalized.y = normalizedPosition.y
      this.state.snap.pendingInitialPositionIsRaw = false
    }
  }

  /**
   * The size of the masked window viewport in local space
   * @returns vec2 of the current window size
   */
  public get windowSize(): vec2 {
    return this._windowSize
  }

  /**
   * The size of the masked window viewport in local space
   * @param size - The window size in local space. Negative or non-finite components are rejected.
   */
  public set windowSize(size: vec2) {
    if (size === undefined) {
      return
    }
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || size.x < 0 || size.y < 0) {
      log.w(`ignoring windowSize write with non-finite or negative component (${size.x}, ${size.y}).`)
      return
    }
    if (this._initialized) {
      this.setWindowSize(size)
    } else {
      this._windowSize = size
    }
  }

  /** Per-side inset subtracted from windowSize when sizing the interaction collider (mask/viewport unaffected). */
  public get colliderInset(): vec2 {
    return this.state.colliders.colliderInset
  }

  /** Set the per-side collider inset; re-applies the collider size if already initialized. */
  public set colliderInset(inset: vec2) {
    if (inset == null) {
      return
    }
    // Clamp non-negative — a negative inset would grow the collider beyond windowSize
    // into the parent Frame's margin-grab area, the opposite of the intent.
    this.state.colliders.colliderInset = new vec2(Math.max(inset.x, 0), Math.max(inset.y, 0))
    if (this._initialized) {
      // Only the collider depends on the inset — skip the screenTransform / edgeFade /
      // onSizeChangedEvent path so listeners don't re-layout for an unchanged layoutSize.
      this.applyColliderSize()
    }
  }

  /**
   * The size of the total scrollable area
   * @returns vec2 of the current scroll dimensions
   */
  public get scrollDimensions(): vec2 {
    return this._scrollDimensions
  }

  /**
   * The size of the total scrollable area
   * @param size - The scroll dimensions in local space. Use `-1` on either axis for unbounded scrolling on that axis.
   */
  public set scrollDimensions(size: vec2) {
    if (size === undefined) {
      return
    }
    const xOk = Number.isFinite(size.x) && (size.x >= 0 || size.x === -1)
    const yOk = Number.isFinite(size.y) && (size.y >= 0 || size.y === -1)
    if (!xOk || !yOk) {
      return
    }
    if (this._initialized) {
      this.setScrollDimensions(size)
    } else {
      this._scrollDimensions = size
    }
  }

  /**
   * The boundary within which child colliders will be enabled when an interactor hovers over the ScrollWindow.
   * Uses normalized positions from -1 to 1 on both axes.
   * For example, if we provide a Rect with Rect.create(-1, 1, -0.8, 1),
   * hovering the bottom 10% of the ScrollWindow will not enable the child ColliderComponents.
   * @returns The current enable child colliders boundary
   */
  public get enableChildCollidersBoundary(): Rect {
    return this.state.colliders.enableChildCollidersBoundary
  }

  /**
   * The boundary within which child colliders will be enabled when an interactor hovers over the ScrollWindow.
   * @param value - The boundary rect using normalized positions from -1 to 1
   */
  public set enableChildCollidersBoundary(value: Rect) {
    if (value === undefined) {
      return
    }
    this.state.colliders.enableChildCollidersBoundary = value
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /** Builds the scroll engine, then wires enable/disable/destroy/start/update lifecycle events. */
  public onAwake(): void {
    this.buildScrollEngine()
    this.createEvent("OnEnableEvent").bind(() => {
      if (this._initialized) {
        this.subscribeToEvents(true)
        this.invalidateCanvasBinding()
        this.managedComponents.forEach((component) => {
          if (!isNull(component) && component) {
            if (component === this.maskingComponent) {
              component.enabled = this._maskingEnabledDesired
            } else if (component === this._interactable) {
              component.enabled = this._interactableEnabledDesired
            } else if (component === this.rmv) {
              component.enabled = this._edgeFade
            } else {
              component.enabled = true
            }
          }
        })
      }
    })
    this.createEvent("OnDisableEvent").bind(() => {
      if (this._initialized) {
        // Flush any in-flight gesture at the moment of disruption so the
        // Disengaged event fires with correct timing. Without this, a gesture
        // active at disable time would leave `isDragging=true` and either fire
        // Disengaged late on re-enable (wrong timing) or never (if destroyed
        // while disabled — orphan Engaged with no paired Disengaged).
        if (this.state.gesture.isDragging || this._poke.gestureInterceptor.isActive) {
          this.cancelCurrentInteractor(ScrollGestureEndReason.Canceled, "ScrollWindow disabled mid-gesture")
        }
        this.subscribeToEvents(false)
        this.managedComponents.forEach((component) => {
          if (!isNull(component) && component) {
            component.enabled = false
          }
        })
        this.enableChildColliders(true)
      }
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      this.state.gesture.scrollTweenCancel()
      // Skip reparenting when an owner manages child lifecycle — would risk double-destroy.
      if (
        !this.state.colliders.skipColliderManagement &&
        this.scroller &&
        !isNull(this.scroller) &&
        !isNull(this.sceneObject)
      ) {
        try {
          // Rescue CONTENT children (not the managed content-origin node,
          // which is destroyed with the tree).
          const contentParent =
            this.contentOriginNode && !isNull(this.contentOriginNode) ? this.contentOriginNode : this.scroller
          contentParent.children.forEach((child) => {
            if (!isNull(child)) child.setParent(this.sceneObject)
          })
        } catch {
          // Parent mid-destruction; children will be destroyed with the tree.
        }
      }
      this.managedComponents.forEach((component) => {
        if (component && !isNull(component)) {
          component.destroy()
        }
      })
      this.managedComponents = []
      this.managedSceneObjects.forEach((sceneObject) => {
        if (sceneObject && !isNull(sceneObject)) {
          sceneObject.destroy()
        }
      })
      this.managedSceneObjects = []
    })
    this.createEvent("OnStartEvent").bind(() => this.initialize())
    this.createEvent("LateUpdateEvent").bind(() => this.update())
  }

  /**
   * Expands the inspector-driven scroll spec into this instance's engine state:
   * the flat physics config (selected by `feel`), the per-axis scrollers, and
   * the per-axis snap policies.
   *
   * The spec always requests a snapping mode (the mode union has no "none")
   * so the snap-policy params exist for runtime scrollSnapping/snapMode
   * switches — the physics config is snapMode/edgeMode-independent, so there
   * is zero drift. Runs as the first statement of onAwake so every later code
   * path can rely on the engine members being present.
   */
  private buildScrollEngine(): void {
    // Legacy-scene migration: instances serialized under the old three-option
    // snap surface can deserialize _snapMode as "none", bypassing the narrowed
    // union. Coerce to the equivalent new state (snapping off, default mode)
    // before building the spec — makeScroller("none") emits no snap params and
    // the engine requires them.
    if ((this._snapMode as SnapMode) === "none") {
      this._snapMode = "paging"
      this._scrollSnapping = false
    }
    const engine = this.state.engine
    const {config, snapPolicy} = makeScroller({
      ...SCROLL_WINDOW_PAGING_PRESET,
      snapMode: this._snapMode,
      edgeMode: this._edgeMode,
      feel: this._feel
    })
    engine.config = config
    // Non-null by construction: the spec above never requests "none".
    engine.snapParams = snapPolicy!
    engine.epsilon = config.epsilon
    this.state.scratch.snapSettleOptions.earlyExitEpsilon = config.epsilon
    engine.velocityBaseFrameTime = config.velocityBaseFrameTime
    engine.minimumScrollingVelocity = config.minimumScrollingVelocity
    engine.maxOvershootFactor = SCROLL_WINDOW_PAGING_PRESET.maxOverscrollFraction
    engine.horizontalScroller = new BaseScroller(config)
    engine.verticalScroller = new BaseScroller(config)
    engine.horizontalSnapPolicy = new SnapScrollPolicy(snapPolicy!.snapVelocityHandoffScale)
    engine.verticalSnapPolicy = new SnapScrollPolicy(snapPolicy!.snapVelocityHandoffScale)
  }

  /**
   * Initializes the ScrollWindow component.
   * This method runs once on creation and sets up all necessary components and event handlers.
   */
  public initialize(): void {
    if (this._initialized) return

    this.transform = this.sceneObject.getTransform()
    // Drive the frustum lazily off the camera + this window's transform; the
    // near-plane size is pushed in setWindowSize. The frustum then recomputes
    // on access (at most once per frame) — no per-frame rebuild needed.
    this.frustum.setCamera(this.cameraComponent)
    this.frustum.setTransform(this.transform)
    this.screenTransform =
      this.sceneObject.getComponent("ScreenTransform") || this.sceneObject.createComponent("ScreenTransform")
    this.screenTransform.position = this.transform.getLocalPosition()
    this.collider =
      this.sceneObject.getComponent("ColliderComponent") || this.sceneObject.createComponent("ColliderComponent")
    this.managedComponents.push(this.collider)
    this.maskingComponent =
      this.sceneObject.getComponent("MaskingComponent") || this.sceneObject.createComponent("MaskingComponent")
    // Apply the desired maskingEnabled / interactableEnabled state here, as
    // OnEnable does on every enable cycle. A write made before initialize had
    // no component to land on, so without this a mask asked off still renders
    // until the next enable cycle.
    this.maskingComponent.enabled = this._maskingEnabledDesired
    this.managedComponents.push(this.maskingComponent)
    this._interactable =
      this.sceneObject.getComponent(Interactable.getTypeName()) ||
      this.sceneObject.createComponent(Interactable.getTypeName())
    this._interactable.enabled = this._interactableEnabledDesired
    this.managedComponents.push(this._interactable)
    this._interactable.isScrollable = true
    this._interactable.targetingMode = TargetingMode.All

    this.setWindowSize(this._windowSize)

    this.collider.shape = this.state.colliders.colliderShape
    this.collider.fitVisual = false
    this.collider.debugDrawEnabled = this.debugRender

    this._interactable.enableInstantDrag = true

    const currentChildren = [...this.sceneObject.children]

    this.scroller = global.scene.createSceneObject("Scroller")
    this.managedSceneObjects.push(this.scroller)
    this.scroller.layer = this.sceneObject.layer
    this.scroller.setParent(this.sceneObject)
    this.scrollerTransform = this.scroller.getTransform()

    if (this._contentOrigin === "TopLeft") {
      this.contentOriginNode = global.scene.createSceneObject("ContentOrigin")
      this.managedSceneObjects.push(this.contentOriginNode)
      this.contentOriginNode.layer = this.sceneObject.layer
      this.contentOriginNode.setParent(this.scroller)
      this.applyContentOriginPosition()
    }

    const contentParent = this.contentOriginNode ?? this.scroller
    for (let i = 0; i < currentChildren.length; i++) {
      const thisChild = currentChildren[i]
      thisChild.setParent(contentParent)
    }

    // After the scroller, so the fade object is the last child (drawn above
    // content under Canvas hierarchy sorting).
    if (this._edgeFade) {
      this.createEdgeFade()
    }

    this.subscribeToEvents(this.enabled)

    // Resolve the authored initial position: normalized by default, raw when a
    // pre-init scrollPosition write should win (last write wins).
    if (!this.state.snap.pendingInitialPositionIsRaw) {
      this._scrollPosition.x = this.positionFromNormalizedX(this._initialScrollPositionNormalized.x)
      this._scrollPosition.y = this.positionFromNormalizedY(this._initialScrollPositionNormalized.y)
    }
    const initialPosition = new vec3(this._scrollPosition.x, this._scrollPosition.y, 0)
    if (this.effectiveSnapMode !== "none") {
      if (
        this._horizontal &&
        this._snapRegion.x > 0 &&
        (this._scrollDimensions.x === -1 || this._scrollDimensions.x > this._windowSize.x)
      ) {
        const pageIndex = this.getPageIndexFromPosition("x", this._scrollPosition.x)
        if (this._scrollDimensions.x !== -1) {
          // Reading-order frame: x pages anchor at the LEFT edge, direction -1.
          // Clamp the INDEX (not just the position) so a non-pitch-multiple span
          // rests on a real page and the snapIndex seed can't exceed the max.
          initialPosition.x = pagePositionForIndex(
            MathUtils.clamp(pageIndex, 0, maxValidPageIndex(this.leftEdge, this.rightEdge, this._snapRegion.x)),
            this.leftEdge,
            -1,
            this._snapRegion.x
          )
          initialPosition.x = MathUtils.clamp(initialPosition.x, this.rightEdge, this.leftEdge)
        } else {
          initialPosition.x = pagePositionForIndex(pageIndex, null, -1, this._snapRegion.x)
        }
      }

      if (
        this._vertical &&
        this._snapRegion.y > 0 &&
        (this._scrollDimensions.y === -1 || this._scrollDimensions.y > this._windowSize.y)
      ) {
        const pageIndex = this.getPageIndexFromPosition("y", this._scrollPosition.y)
        if (this._scrollDimensions.y !== -1) {
          initialPosition.y = pagePositionForIndex(
            MathUtils.clamp(pageIndex, 0, maxValidPageIndex(this.topEdge, this.bottomEdge, this._snapRegion.y)),
            this.topEdge,
            1,
            this._snapRegion.y
          )
          initialPosition.y = MathUtils.clamp(initialPosition.y, this.topEdge, this.bottomEdge)
        } else {
          initialPosition.y = pagePositionForIndex(pageIndex, null, 1, this._snapRegion.y)
        }
      }
    }

    if (initialPosition.x !== 0 || initialPosition.y !== 0) {
      // The default (normalized 0,0 = top-left) IS local (0, 0) in the
      // top-left-anchored frame — no move and no event. A non-default authored
      // position fires one scroll-position-updated event here, before
      // onInitialized, and lands on gesture-disabled axes too (clamped, never
      // overscrolled).
      this.clampLockedAxes(initialPosition)
      this.updateScrollerPosition(initialPosition, false)
    } else {
      // No move and no event — but snap-align (or normalized conversion) may
      // have resolved a non-zero seed to the rest pose, and in this frame
      // page 0 IS (0, 0): _scrollPosition must still mirror the resolved
      // position or scrollPosition/scrollPositionNormalized/getVisibleWindow*
      // report the stale seed until the first gesture writes through.
      this._scrollPosition.x = 0
      this._scrollPosition.y = 0
    }

    // Establish every position-derived anchor from the authoritative final
    // pose. In particular, pre-initialize external control skips the takeover
    // reset; without this seed its first sample would measure velocity from 0
    // and Detent would project from page/position 0. This intentionally leaves
    // pending motion untouched so a pre-initialize setVelocity() kick survives.
    const finalInitialPosition = this.scrollerTransform.getLocalPosition()
    this.seedPositionAnchors(finalInitialPosition)

    // Seed the announced snap indices from the final initial position without
    // firing the event (the reading-order baseline: page 0 at the top/left).
    this.state.snap.snapIndexX = this.getRestingPageIndex("x", finalInitialPosition.x)
    this.state.snap.snapIndexY = this.getRestingPageIndex("y", finalInitialPosition.y)

    this._initialized = true
    this.events.initialized.invoke()
  }

  // ─── Public Methods ──────────────────────────────────────────────────

  /**
   * Adds a SceneObject to this scroll window's scrollable content area.
   * The object is parented into the internal content container (the
   * "TopLeft" content-origin node when that mode is on, else the scroller).
   *
   * @param object - The SceneObject to add to the scroll window
   */
  public addObject(object: SceneObject): void {
    object.setParent(this.contentOriginNode ?? this.scroller ?? this.sceneObject)
    // Reparenting changes which Canvas (if any) governs the subtree, and
    // components cache that answer (e.g. ElementContent's content render-order
    // fallback resolves it once). Reparenting fires no OnEnableEvent, so
    // without this an ElementContent built outside a Canvas keeps its +1
    // content order inside a Canvas-backed window and escapes both the canvas
    // hierarchy sort and the edge fade. Duck-typed rather than importing the
    // component types — Calendar / NumberPicker / text inputs expose the same
    // method, and a type import here risks a require cycle.
    invalidateCanvasBindingsIn(object)
  }

  /** Places the TopLeft content-origin node at the viewport's top-left corner. */
  private applyContentOriginPosition(): void {
    if (!this.contentOriginNode) return
    this.contentOriginNode
      .getTransform()
      .setLocalPosition(new vec3(this._windowSize.x * -0.5, this._windowSize.y * 0.5, 0))
  }

  /**
   * Is the interactor still engaged with this ScrollWindow's scope?
   *
   * For HandInteractor: uses the line-segment-crosses-plane geometric check
   * (see `evaluatePlaneSideEngagement`). The "engagement plane" is captured at
   * gesture-start from the initial collision point + ScrollWindow's normal,
   * and stays fixed in world space for the entire gesture. The user is
   * considered still engaged as long as the knuckle→tip line still straddles
   * that plane (with a small hysteresis band for hand-tracker noise).
   *
   * Why this geometric check rather than PIP's spherecast hit set:
   *
   * 1. Lateral motion off ScrollWindow's XY bounds doesn't end the gesture.
   *    The plane is infinite in XY, so a flick that sends the finger past the
   *    visible scroll surface still keeps the gesture alive — matching the
   *    design intent that a hard flick should not lose its momentum.
   * 2. PIP's spherecast envelope shrinks mid-gesture when `_currentTrigger`
   *    drops to None (e.g., after the original poke-target's collider is
   *    exited during scroll). The shrunk envelope could then miss the thin
   *    ScrollWindow back-plane collider, falsely ending the gesture. Geometric
   *    plane-piercing doesn't depend on the spherecast at all.
   * 3. The plane normal is captured at gesture-start (not re-read each frame),
   *    so the criterion is invariant under parent-transform rotation
   *    mid-gesture.
   *
   * Pre-engagement (`_initialPokePlanePoint === null`): falls back to PIP's
   * spherecast-touching check, which is the natural pre-engagement semantic
   * (we haven't anchored a plane yet).
   *
   * For non-Hand interactors (Mouse, Mobile, Sync): they don't use the
   * physical path (`useStateMachine` is false for them), so this branch is
   * only reached in odd corner cases. Falls back to the cross-interactor
   * `isHoveringInteractableHierarchy`.
   */
  private isFingerStillEngaged(interactor: Interactor): boolean {
    if (interactor instanceof HandInteractor) {
      if (
        interactor.activeTargetingMode === TargetingMode.Direct &&
        (interactor.currentTrigger & InteractorTriggerType.Pinch) !== 0
      ) {
        // A pinch is an explicit trigger: while it is held the gesture stays
        // engaged (IK ends it on release or hand loss). The knuckle->tip
        // plane test below models a poking finger; an in-air pinch-drag never
        // straddles the panel plane, so routing pinches through it ended
        // every direct-pinch scroll after the grace frames -- a pinch-drag
        // starting on a child interactable could not scroll at all. Gate on the
        // Pinch trigger being actively held (not just activeTargetingMode ===
        // Direct): on a Poke release currentTrigger goes None and
        // activeTargetingMode falls back to Direct, which would otherwise keep a
        // finished poke gesture engaged forever (never ending via the plane
        // test) and freeze the scroll.
        return true
      }
      if (this._poke._initialPokePlanePoint === null || this._poke._initialPlaneNormal === null) {
        // Pre-engagement or plane not yet captured — fall back to the
        // spherecast-touching check. This branch fires on the first tick
        // after triggerStart (where _initialPokePlanePoint gets set inside
        // `onTriggerStart`) only if onTriggerStart's NO_INTERSECTION branch
        // ran (rare).
        return interactor.isPhysicallyTouchingHierarchy(this._interactable)
      }
      const knuckle = interactor.indexKnucklePosition
      const tip = interactor.indexTipPosition
      if (knuckle === null || tip === null) {
        // Hand-tracking lost or PIP unavailable. Existing system-wide behavior
        // is to end on hand-loss; mirror that here.
        return false
      }
      return evaluatePlaneSideEngagement(
        this._poke._initialPokePlanePoint,
        this._poke._initialPlaneNormal,
        knuckle,
        tip,
        ENGAGEMENT_PLANE_HYSTERESIS_CM
      )
    }
    return interactor.isHoveringInteractableHierarchy(this._interactable)
  }

  /**
   * Is this interactor's targeting mode "indirect" — i.e., raycast-style at-a-distance
   * input where IK's drag threshold should govern engagement rather than our state
   * machine's deadzone?
   *
   * - HandInteractor in indirect targeting mode → true.
   * - HandInteractor in poke / direct pinch → false (needs deadzone to filter
   *   finger-arc wobble; uses state machine).
   * - MouseInteractor, MobileInteractor, etc. → true (no swept envelope; IK's
   *   threshold is the natural engagement signal).
   */
  private isIndirectGesture(interactor: Interactor): boolean {
    if (interactor instanceof HandInteractor) {
      return interactor.activeTargetingMode === TargetingMode.Indirect
    }
    return true
  }

  /**
   * Prime engagement state on the engage frame. Captures the scroll anchor
   * (`startPosition`, `interactorOffset`) so the first frame is zero-displacement
   * by construction, cancels any in-flight tween, and cancels competing child
   * triggers so the gesture is decisively ScrollWindow's. Shared between the
   * state-machine path (called on `tick.enteredEngaged`) and the indirect path
   * (called on the first `onDragUpdate`).
   */
  private primeEngagement(interactorPos: vec3, triggerEvent: InteractableEventArgs | null): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    gesture.scrollTweenCancel()
    gesture.startPosition = this.scrollerTransform.getLocalPosition()
    gesture.interactorOffset = interactorPos
    engine.horizontalScroller!.beginDrag(gesture.startPosition.x, interactorPos.x)
    engine.verticalScroller!.beginDrag(gesture.startPosition.y, interactorPos.y)
    // resetDragState may have run several dwell frames earlier while a
    // preserved snap latch kept settling. Anchor snap projection to the page
    // at actual engagement start, not the tentative trigger-start page.
    engine.horizontalSnapPolicy!.setStartAnchor(
      this.getPageIndexFromPosition("x", gesture.startPosition.x),
      gesture.startPosition.x
    )
    engine.verticalSnapPolicy!.setStartAnchor(
      this.getPageIndexFromPosition("y", gesture.startPosition.y),
      gesture.startPosition.y
    )
    gesture.interactorUpdated = true
    gesture.isDragging = true
    this.clearSnapTarget("x")
    this.clearSnapTarget("y")
    if (triggerEvent !== null) {
      this.cancelChildInteraction(triggerEvent)
    }
  }

  /**
   * Per-frame scroll math while engaged. Shared between state-machine and indirect
   * paths. Reads `interactorPos` (the projected intersection in local space) and
   * drives the axis scrollers' drag positions, overscroll resistance, the public
   * scroll-drag event, and the velocity trackers that seed the eventual fling.
   */
  private applyScrollDelta(interactorPos: vec3): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    const scratch = this.state.scratch
    // A tween started mid-gesture (programmatic tweenTo) loses to live input.
    gesture.scrollTweenCancel()
    gesture.dragAmount.x = interactorPos.x - gesture.interactorOffset.x
    gesture.dragAmount.y = interactorPos.y - gesture.interactorOffset.y
    let newPosition = scratch.dragPosition
    newPosition.x = engine.horizontalScroller!.getDragPosition(interactorPos.x)
    newPosition.y = engine.verticalScroller!.getDragPosition(interactorPos.y)
    newPosition.z = 0
    newPosition = this.applyOverscrollIfNeeded(newPosition)
    this.updateScrollerPosition(newPosition)
    // Allocate only when subscribed, matching origin/main's retain-safe contract.
    if (this.events.scrollDrag.hasListeners) {
      this.events.scrollDrag.invoke({
        startPosition: new vec2(gesture.startPosition.x, gesture.startPosition.y),
        dragAmount: new vec2(gesture.dragAmount.x, gesture.dragAmount.y)
      })
    }
    // Observers can rebase content while either event is dispatched. Sample
    // the published pose in that same frame as the translated velocity baseline.
    this.updateVelocityFromPosition(this._scrollPosition)
  }

  /**
   * Central termination point. Used by both:
   * - the state machine's `enteredEnded` transition (retract / hand-lost
   *   detected from the LateUpdate poll), and
   * - the IK event classifier (`onEndCandidate`) when it decides an end is real.
   *
   * Lifecycle event dispatch is delegated to `dispatchScrollEndEvent` (which
   * uses the pure `classifyScrollEnd` for the truth table). If `endReason` /
   * `endMessage` are omitted, no event fires — used by internal resets that
   * aren't real gesture ends.
   *
   * @param applyFling - true to hand the release velocity to the fling physics
   *   (engaged scroll release); false for cancellations or quick intercept-
   *   then-retract gestures (all in-flight motion is killed instead).
   */
  private endActiveGesture(applyFling: boolean, endReason?: ScrollGestureEndReason, endMessage?: string): void {
    const engine = this.state.engine
    if (applyFling) {
      engine.horizontalScroller!.endDrag()
      engine.verticalScroller!.endDrag()
      // endDrag latches hasPendingFlingVelocity unconditionally, but update()'s
      // friction/snap arm only runs for ENABLED axes — a disabled axis would
      // keep hasMotion true forever, blocking the rest early-return and
      // withholding onScrollEnd until the next gesture.
      if (!this._horizontal) engine.horizontalScroller!.clearPendingFlingVelocity()
      if (!this._vertical) engine.verticalScroller!.clearPendingFlingVelocity()
    } else {
      engine.horizontalScroller!.cancelMotion()
      engine.verticalScroller!.cancelMotion()
    }
    const captured = this.resetGestureState()
    if (endReason !== undefined && endMessage !== undefined) {
      this.dispatchScrollEndEvent(captured, {reason: endReason, message: endMessage})
    }
  }

  /**
   * Shared reset used by `endActiveGesture` and `cancelCurrentInteractor`.
   * Captures the pre-reset engagement signals — the interceptor's `priorState`
   * (physical-path Intercepting/Engaged transitions) AND `wasDragging`
   * (primeEngagement-set; unified across physical and indirect paths). Both
   * are needed because indirect gestures never run the interceptor — they
   * engage via `onInteractableDragUpdate` → `primeEngagement` which sets
   * `isDragging` but leaves the interceptor at Idle. Does not touch retained
   * drag values (velocity/dragAmount/interactorOffset) — caller decides whether
   * to fling (endActiveGesture) or zero them (cancelCurrentInteractor).
   */
  private resetGestureState(): {priorState: GestureState; wasDragging: boolean} {
    const priorState = this._poke.gestureInterceptor.state
    const wasDragging = this.state.gesture.isDragging
    this.state.gesture.activeInteractor = null
    this.state.gesture.isDragging = false
    this.state.gesture.interactorUpdated = false
    this._poke.lastTriggerStartEvent = null
    this._poke.originalPokeTarget = null
    this._poke.gestureStartWorld = null
    this._poke.useStateMachine = false
    this._poke._initialPokePlanePoint = null
    this._poke._initialPlaneNormal = null
    this._poke._prevIntersectionWorld = null
    this._poke._prevSignedDistance = null
    this._poke._lastAppliedInteractorPos = null
    this._poke._wasMaskedAxisX = false
    this._poke._wasMaskedAxisY = false
    this._poke.gestureInterceptor.reset()
    return {priorState, wasDragging}
  }

  // Fires the appropriate public lifecycle event at gesture termination.
  // Decision logic lives in the pure `classifyScrollEnd` (in
  // ScrollGestureInterceptor.ts) so the truth table is unit-testable. Invariant:
  // once `wasDragging` is set (via primeEngagement), only Disengaged can fire —
  // Rejected is exclusively a physical-path pre-engagement signal.
  private dispatchScrollEndEvent(
    captured: {priorState: GestureState; wasDragging: boolean},
    arg: ScrollGestureEndArg
  ): void {
    const kind = classifyScrollEnd(captured.priorState, captured.wasDragging)
    if (kind === "disengaged") {
      this.events.scrollDisengaged.invoke(arg)
    } else if (kind === "rejected") {
      this.events.scrollRejected.invoke(arg)
    }
  }

  /**
   * Per-tick projection sample for the physical (poke / direct pinch) path.
   * Computes everything the interceptor needs: lateral distance from origin,
   * per-frame lateral delta (for anti-hook), forward velocity (for the
   * forward-velocity gate), and the local-space interactor position for the
   * scroll-position math. Updates `_prevSignedDistance` as a side-effect so
   * the next frame's forward velocity can be computed.
   */
  private sampleInteractorProjection(interactor: Interactor): {
    hasProjection: boolean
    interactorPos: vec3 | null
    intersectionWorld: vec3 | null
    lateralDistanceFromStartCm: number
    forwardVelocityCmPerSec: number
    lateralDeltaCm: {x: number; y: number}
  } {
    const intersectionWorld =
      interactor instanceof HandInteractor
        ? interactor.physicalPositionPlaneIntersection(this._interactable)
        : interactor.raycastPlaneIntersection(this._interactable)

    if (intersectionWorld === null) {
      return {
        hasProjection: false,
        interactorPos: null,
        intersectionWorld: null,
        lateralDistanceFromStartCm: 0,
        forwardVelocityCmPerSec: 0,
        lateralDeltaCm: {x: 0, y: 0}
      }
    }

    // Distance against the cm-typed deadzone — computed in world space to be
    // invariant to the SceneObject hierarchy's scale.
    const lateralDistanceFromStartCm =
      this._poke.gestureStartWorld !== null ? intersectionWorld.distance(this._poke.gestureStartWorld) : 0
    // Local-space position drives scrollerTransform (which lives in local space).
    const interactorPos = this.transform.getInvertedWorldTransform().multiplyPoint(intersectionWorld)

    // Per-frame lateral delta in plane-local axes (right/up of the ScrollWindow transform).
    let lateralDeltaCm = {x: 0, y: 0}
    if (this._poke._prevIntersectionWorld !== null) {
      const worldDelta = intersectionWorld.sub(this._poke._prevIntersectionWorld)
      lateralDeltaCm = {x: worldDelta.dot(this.transform.right), y: worldDelta.dot(this.transform.up)}
    }

    // Forward velocity from the fingertip-to-plane signed distance — HandInteractor only.
    let forwardVelocityCmPerSec = 0
    if (interactor instanceof HandInteractor) {
      const currentSignedDist = interactor.physicalSignedDistanceToPlane(this._interactable)
      if (currentSignedDist !== null && this._poke._prevSignedDistance !== null) {
        const dt = getDeltaTime()
        if (dt > 0) {
          forwardVelocityCmPerSec = (currentSignedDist - this._poke._prevSignedDistance) / dt
        }
      }
      this._poke._prevSignedDistance = currentSignedDist
    }

    return {
      hasProjection: true,
      interactorPos,
      intersectionWorld,
      lateralDistanceFromStartCm,
      forwardVelocityCmPerSec,
      lateralDeltaCm
    }
  }

  /**
   * Self-driven scroll loop. Called once per LateUpdate from this.update(). Polls the
   * current interactor projection onto the ScrollWindow plane, feeds it (plus the
   * signed distance from the plane) into the gesture interceptor, and reacts to the
   * state-machine transitions: engage (cancel children, prime scroll state, start
   * driving scroller), end (apply fling, clear interactor, reset machine).
   *
   * The point of this loop is to make scroll continuity independent of IK's
   * frame-by-frame spherecast result. Once a gesture is captured, we keep scrolling
   * even if IK's hit set transiently loses the original Interactable due to fast
   * lateral motion — we only end on real retract or hand-lost.
   */
  private updateGestureInterceptor() {
    // Only the physical (poke / direct pinch) path uses the state machine;
    // indirect gestures are driven by the onDragUpdate event handler.
    if (!this._poke.useStateMachine || !this._poke.gestureInterceptor.isActive) return
    // Defensive: out-of-band cancellation (scrollingPaused setter, explicit
    // cancel) already cleared activeInteractor and reset the interceptor on
    // the normal paths — just unwind without fling.
    if (this.state.gesture.activeInteractor === null) {
      this._poke.gestureInterceptor.reset()
      return
    }

    const interactor = this.state.gesture.activeInteractor
    const proj = this.sampleInteractorProjection(interactor)

    // Geometric "still engaged" signal; 5-frame grace inside the state
    // machine absorbs single-frame glitches.
    const pokeStillTouching = this.isFingerStillEngaged(interactor)

    const stateBeforeTick = this._poke.gestureInterceptor.state
    const tick = this._poke.gestureInterceptor.tick({
      hasProjection: proj.hasProjection,
      lateralDistanceFromStartCm: proj.lateralDistanceFromStartCm,
      pokeStillTouching,
      forwardVelocityCmPerSec: proj.forwardVelocityCmPerSec,
      lateralDeltaCm: proj.lateralDeltaCm
    })

    // Re-anchor when the forward-velocity gate is active so that on release,
    // lateral distance is measured from "landing" rather than from triggerStart.
    if (tick.reCaptureOrigin && proj.intersectionWorld !== null) {
      this._poke.gestureStartWorld = proj.intersectionWorld
    }

    if (tick.enteredEngaged && proj.interactorPos !== null) {
      // Physical-path Engaged event. Counterpart for the indirect path lives
      // in onInteractableDragUpdate's first-drag-tick branch. Keep both in sync
      // when refactoring engagement semantics.
      this.primeEngagement(proj.interactorPos, this._poke.lastTriggerStartEvent)
      this._poke._lastAppliedInteractorPos = proj.interactorPos
      const thresholdCm = this._poke.gestureInterceptor.lateralDeadzoneCm
      this.events.scrollEngaged.invoke({
        thresholdCm,
        message: `lateral motion crossed the ${thresholdCm.toFixed(1)} cm threshold`
      })
    }

    if (this._poke.gestureInterceptor.state === GestureState.Engaged && proj.interactorPos !== null) {
      // Anti-hook mask: when applyAxis rejects an axis, substitute the previous
      // applied coordinate so dragAmount sees zero motion (preserves position,
      // keeps the fling-velocity bank from picking up reversed direction).
      //
      // Mask-recovery offset adjustment: when the mask FLIPS from true → false
      // on an axis (filter recovers), the finger has accumulated motion during
      // the masked frames that we deliberately ignored. Without absorbing that
      // lost motion into the gesture anchors, the recovery frame would apply the
      // entire accumulated displacement as a single-frame dragAmount jump —
      // feeding an exaggerated velocity sample into the fling-velocity bank.
      // `interactorOffset` keeps dragAmount continuous; re-anchoring the axis
      // scroller (beginDrag from the current pose) keeps its drag position and
      // velocity baseline continuous. The scroller's velocity ring is cleared by
      // the re-anchor — acceptable, since the masked frames held it at the
      // pre-reversal samples the mask existed to discard.
      if (this._poke._lastAppliedInteractorPos !== null) {
        const gesture = this.state.gesture
        const engine = this.state.engine
        if (this._poke._wasMaskedAxisX && tick.applyAxis.x) {
          gesture.interactorOffset.x += proj.interactorPos.x - this._poke._lastAppliedInteractorPos.x
          engine.horizontalScroller!.beginDrag(this.scrollerTransform.getLocalPosition().x, proj.interactorPos.x)
        }
        if (this._poke._wasMaskedAxisY && tick.applyAxis.y) {
          gesture.interactorOffset.y += proj.interactorPos.y - this._poke._lastAppliedInteractorPos.y
          engine.verticalScroller!.beginDrag(this.scrollerTransform.getLocalPosition().y, proj.interactorPos.y)
        }
      }
      this._poke._wasMaskedAxisX = !tick.applyAxis.x
      this._poke._wasMaskedAxisY = !tick.applyAxis.y

      const maskedInteractorPos =
        this._poke._lastAppliedInteractorPos !== null
          ? new vec3(
              tick.applyAxis.x ? proj.interactorPos.x : this._poke._lastAppliedInteractorPos.x,
              tick.applyAxis.y ? proj.interactorPos.y : this._poke._lastAppliedInteractorPos.y,
              proj.interactorPos.z
            )
          : proj.interactorPos
      this.applyScrollDelta(maskedInteractorPos)
      this._poke._lastAppliedInteractorPos = maskedInteractorPos
    }

    // Update prevIntersectionWorld at the END of the tick so the next frame's
    // lateralDelta = (next_intersection − this_intersection).
    if (proj.intersectionWorld !== null) {
      this._poke._prevIntersectionWorld = proj.intersectionWorld
    }

    if (tick.enteredEnded) {
      const {reason, message} = classifyTickEndReason(
        proj.hasProjection,
        stateBeforeTick,
        this._poke.gestureInterceptor.lateralDeadzoneCm
      )
      // Apply fling only if we actually engaged. Quick intercept-then-retract
      // (button pokes) end without engagement — no velocity to apply.
      this.endActiveGesture(/* applyFling */ this.state.gesture.isDragging, reason, message)
    }
  }

  /**
   * Helper function to tween scroll
   * @param position - final position
   * @param time - duration of tweened scroll in milliseconds
   */
  public tweenTo(position: vec2, time: number): void {
    if (!this._initialized) return
    const gesture = this.state.gesture
    const engine = this.state.engine
    gesture.scrollTweenCancel()
    engine.horizontalScroller!.cancelMotion()
    engine.verticalScroller!.cancelMotion()
    // The tween owns the motion now: a latch committed by an in-flight snap
    // would otherwise strand — paging withholds the scroll-end event until the
    // next drag, and detent springs the view off the tween destination back to
    // the stale pre-tween target.
    this.clearSnapTarget("x")
    this.clearSnapTarget("y")
    this.clearEdgeLanding()
    const scrollerLocalPosition = this.scrollerTransform.getLocalPosition()
    const startX = scrollerLocalPosition.x
    const startY = scrollerLocalPosition.y
    const startZ = scrollerLocalPosition.z
    // Clamp the end target once. Locked axes never tween into overscroll
    // (their never-rest-out-of-bounds invariant — see clampLockedAxes).
    // Clamped-family edges clamp ENABLED axes too, so the tween target is the
    // edge itself rather than an unreachable out-of-bounds coordinate.
    const endTarget = new vec3(position.x, position.y, 0)
    this.clampLockedAxes(endTarget)
    if (this.edgeClamped) {
      const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(endTarget)
      endTarget.x = boundsCheck.clamped.x
      endTarget.y = boundsCheck.clamped.y
    }
    const endX = endTarget.x
    const endY = endTarget.y

    gesture.isTweeningScroll = true
    animate({
      duration: time * 0.001,
      update: (t) => {
        const lerp = this.state.scratch.tweenLerp
        lerp.x = startX + (endX - startX) * t
        lerp.y = startY + (endY - startY) * t
        lerp.z = startZ
        this.updateScrollerPosition(lerp, false)
      },
      ended: () => {
        gesture.isTweeningScroll = false
        this.syncScrollEndState()
      },
      cancelled: () => {
        gesture.isTweeningScroll = false
      },
      cancelSet: gesture.scrollTweenCancel,
      easing: "ease-in-out-quad"
    })
  }

  /**
   * Gets the viewable-window AABB in scroller-local content space at zero
   * depth. The corners are centered on `-scrollPosition`: bottom-left is
   * `-scrollPosition - windowSize/2`, and top-right is
   * `-scrollPosition + windowSize/2`. At the authored rest pose
   * (`scrollPosition = 0`) this is `[-windowSize/2, +windowSize/2]`.
   *
   * With `contentOrigin = "TopLeft"` the corners are reported in the shifted
   * content frame: at rest x spans `[0, W]` and y spans `[-H, 0]`.
   *
   * MIGRATION: compared with the classic center-anchored frame, the same
   * physical viewport pose on a bounded axis returns raw corners shifted by
   * `+(scrollDimensions.x-windowSize.x)/2` on x and
   * `-(scrollDimensions.y-windowSize.y)/2` on y. Relative item-vs-window AABB
   * tests carry over when both operands use the same scroller-local frame;
   * retained or otherwise absolute corner values must be re-based.
   *
   * @returns VisibleWindow object containing bottomLeft and topRight corners in local space
   */
  public getVisibleWindow(): VisibleWindow {
    const visibleWindow: VisibleWindow = {
      bottomLeft: vec2.zero(),
      topRight: vec2.zero()
    }
    this.getVisibleWindowInto(visibleWindow)
    return visibleWindow
  }

  /**
   * Writes the {@link getVisibleWindow} scroller-local AABB into a caller-owned
   * buffer to avoid allocations. The bounds are centered on `-scrollPosition`.
   *
   * MIGRATION: for the same physical viewport pose on a bounded axis, absolute
   * corners from the classic frame shift by
   * `+(scrollDimensions.x-windowSize.x)/2` on x and
   * `-(scrollDimensions.y-windowSize.y)/2` on y. Relative comparisons in the
   * same scroller-local frame carry over; absolute values must be re-based.
   *
   * @param out - The buffer to write the visible window bounds into.
   */
  public getVisibleWindowInto(out: VisibleWindow): void {
    if (this._contentOrigin === "TopLeft") {
      // Content frame is shifted by the corner anchor (-W/2, +H/2): the same
      // physical rect reads as x [0..W], y [-H..0] at rest.
      out.bottomLeft.x = -this._scrollPosition.x
      out.bottomLeft.y = -this._scrollPosition.y - this._windowSize.y
      out.topRight.x = -this._scrollPosition.x + this._windowSize.x
      out.topRight.y = -this._scrollPosition.y
      return
    }
    out.bottomLeft.x = -this._scrollPosition.x - this._windowSize.x * 0.5
    out.bottomLeft.y = -this._scrollPosition.y - this._windowSize.y * 0.5
    out.topRight.x = -this._scrollPosition.x + this._windowSize.x * 0.5
    out.topRight.y = -this._scrollPosition.y + this._windowSize.y * 0.5
  }

  /**
   * Gets the viewable window in normalized content space at zero depth: the
   * {@link getVisibleWindow} corners divided by scrollDimensions/2 per axis,
   * so the full content spans 2 normalized units and the window spans
   * 2·windowSize/scrollDimensions. Zero is the content point at the viewport
   * center of the authored rest view — at rest a scrollable axis reads
   * [−W/D, +W/D]; scrolling down moves the y corners NEGATIVE (reaching
   * [W/D − 2, 3W/D − 2] at the bottom), scrolling right moves the x corners
   * POSITIVE (mirrored) — the output is NOT bounded to [−1, 1]. Meant for
   * RELATIVE visibility tests: an item at scroller-local position p is
   * visible on an axis iff p/(scrollDimensions/2) lies between the corners.
   * Unbounded (−1) and near-zero-scrollDimensions axes read as 0 on both
   * corners.
   *
   * Note: the math is carried verbatim from the classic center-anchored
   * ScrollWindow, where the same division spanned exactly −1..1 over the
   * scroll range. In the top-left-anchored frame the absolute values shift by
   * ±((D−W)/2)/(D/2) = ±(D−W)/D (y negative, x positive); only relative
   * item-vs-window comparisons carry over.
   *
   * @returns VisibleWindow object containing bottomLeft and topRight corners in normalized content space
   */
  public getVisibleWindowNormalized(): VisibleWindow {
    const engine = this.state.engine
    const visibleWindow: VisibleWindow = this.getVisibleWindow()
    // Guard divides: scrollDimensions of 0 or sentinel -1 would leak NaN/Infinity.
    const halfX = this._scrollDimensions.x * 0.5
    const halfY = this._scrollDimensions.y * 0.5
    if (Math.abs(halfX) > engine.epsilon && this._scrollDimensions.x !== -1) {
      visibleWindow.bottomLeft.x /= halfX
      visibleWindow.topRight.x /= halfX
    } else {
      visibleWindow.bottomLeft.x = 0
      visibleWindow.topRight.x = 0
    }
    if (Math.abs(halfY) > engine.epsilon && this._scrollDimensions.y !== -1) {
      visibleWindow.bottomLeft.y /= halfY
      visibleWindow.topRight.y /= halfY
    } else {
      visibleWindow.bottomLeft.y = 0
      visibleWindow.topRight.y = 0
    }
    return visibleWindow
  }

  /**
   * Gets the current scroll velocity in local units per second: per axis, the
   * velocity of whichever driver is moving the content — the settle spring
   * while the axis is spring-driven (snap settle, clamped edge landing,
   * elastic out-of-bounds recovery), else the friction (coast) fling. Reads
   * zero at rest and during drags (release velocity becomes visible once the
   * fling begins). Matches the classic ScrollWindow, whose single shared
   * spring backed every autonomous phase.
   *
   * @returns The current velocity as a vec3
   */
  public getVelocity(): vec3 {
    return new vec3(this.getAxisVelocity("x"), this.getAxisVelocity("y"), 0)
  }

  /**
   * Velocity of the driver currently moving one axis. Spring-driven phases
   * win over the fling: the snap handoff and the edge-landing latch both
   * CLEAR the fling as they seed the spring, and during out-of-bounds
   * recovery the fling holds the deliberately frozen release velocity — raw
   * flingVelocity would read zero (or point the wrong way) through visibly
   * animated motion.
   */
  private getAxisVelocity(axis: "x" | "y"): number {
    const engine = this.state.engine
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    if (this.state.edgeLanding[axis] !== null || snapPolicy.hasCommittedTarget) {
      return axisScroller.springVelocity
    }
    if (this._initialized && !this.edgeClamped) {
      const position = this.scrollerTransform.getLocalPosition()[axis]
      if (Math.abs(position - this.getClampedAxisPosition(axis, position)) > engine.epsilon) {
        return axisScroller.springVelocity
      }
    }
    return axisScroller.flingVelocity
  }

  /**
   * Sets the scroll velocity for programmatic scrolling animations.
   *
   * @param velocity - The velocity to set in local space units per second
   */
  public setVelocity(velocity: vec2): void {
    const engine = this.state.engine
    const gesture = this.state.gesture
    gesture.scrollTweenCancel()
    this.clearEdgeLanding()
    if (this._initialized) {
      const currentPosition = this.scrollerTransform.getLocalPosition()
      this.reseedSnapAxis("x", currentPosition.x)
      this.reseedSnapAxis("y", currentPosition.y)
    }
    engine.horizontalScroller!.setFlingVelocity(velocity.x, Math.abs(velocity.x) > engine.epsilon)
    engine.verticalScroller!.setFlingVelocity(velocity.y, Math.abs(velocity.y) > engine.epsilon)
    if (!this._horizontal) engine.horizontalScroller!.clearPendingFlingVelocity()
    if (!this._vertical) engine.verticalScroller!.clearPendingFlingVelocity()
    // Exempt the next snap commit from the drag-noise deadzone: the reseed
    // above anchors the projection on the CURRENT page, so a from-rest kick
    // has zero displacement and the below-deadzone branch would swallow it
    // (target = start page, handoff sign mismatch clears the fling) — making
    // this API a no-op whenever snapping is on. Mirrors the pending latch:
    // set only for axes whose kick is significant and enabled.
    const snap = this.state.snap
    snap.programmaticKickX = this._horizontal && Math.abs(velocity.x) > engine.epsilon
    snap.programmaticKickY = this._vertical && Math.abs(velocity.y) > engine.epsilon
  }

  // ─── Interaction Handlers ────────────────────────────────────────────

  /** Gates child colliders by the hover boundary when an interactor enters the window. */
  private onInteractableHoverEnter(event: InteractorEvent): void {
    if (this.scrollingPaused) return
    const boundary = this.state.colliders.enableChildCollidersBoundary
    const intersection = event.interactor.raycastPlaneIntersection(this._interactable)
    if (intersection) {
      const localIntersection = this.screenTransform.worldPointToLocalPoint(intersection)
      if (
        localIntersection.x < boundary.left ||
        localIntersection.x > boundary.right ||
        localIntersection.y < boundary.bottom ||
        localIntersection.y > boundary.top
      ) {
        event.stopPropagation()
      } else {
        this.enableChildColliders(true)
      }
    } else {
      this.enableChildColliders(false)
    }
  }

  /** Re-applies the hover-boundary collider gating as the interactor moves. */
  private onInteractableHoverUpdate(event: InteractorEvent): void {
    if (this.scrollingPaused) return
    const boundary = this.state.colliders.enableChildCollidersBoundary
    const intersection = event.interactor.raycastPlaneIntersection(this._interactable)
    if (intersection) {
      const localIntersection = this.screenTransform.worldPointToLocalPoint(intersection)
      if (
        localIntersection.x < boundary.left ||
        localIntersection.x > boundary.right ||
        localIntersection.y < boundary.bottom ||
        localIntersection.y > boundary.top
      ) {
        event.stopPropagation()
      } else {
        this.enableChildColliders(true)
      }
    } else {
      this.enableChildColliders(false)
    }
  }

  /** Disables child colliders once no interactor hovers the window. */
  private onInteractableHoverExit(): void {
    this.enableChildColliders(false)
  }

  /**
   * IK event-dispatch notes for the handlers below.
   *
   * Each event fires in three phases on every subscriber along the path:
   * TrickleDown (ancestors before target), Target (target itself), BubbleUp
   * (ancestors after target). Handlers below select a phase deliberately:
   *
   * - Hover handlers: phase-agnostic (run in all phases). Main's pattern; the
   *   stopPropagation call inside is keyed on out-of-bounds geometry, not phase.
   *
   * - triggerStart: TrickleDown branch carries intentional child-suppression
   *   during any non-Idle gesture state (Intercepting OR Engaged); non-TrickleDown
   *   branch does the actual seeding.
   *
   * - End events (triggerEnd/triggerEndOutside/triggerCanceled): when state !=
   *   Idle and PIP swapped target to a child mid-gesture, stopPropagation in
   *   TrickleDown to kill the child's own triggerEnd — exactly the
   *   "click-doesn't-activate" outcome we want for a swap target, since the
   *   user's intent was scroll, not tap. We still call onEndCandidate from the
   *   TrickleDown branch so our gesture-end bookkeeping runs. IK's
   *   `validateAndClearConnection` clears the connection on the first matching
   *   call so BubbleUp on the same ancestor won't double-fire.
   *
   *   For the non-swap path (event.target is ScrollWindow itself, or gesture is
   *   Idle), behavior is unchanged: process in whichever phase fires.
   */
  private onInteractableTriggerStart(event: InteractorEvent): void {
    // Child-triggerStart suppression during ANY non-Idle gesture state
    // (Intercepting OR Engaged): when PIP swaps target to a child (finger
    // swept past one into another) while a gesture is in flight, stopPropagation
    // in TrickleDown so the child never sees its own triggerStart at Target.
    // Paired with the same guard on the end handlers below — together they
    // prevent the new child from activating at retract when the user's intent
    // was scroll, not tap.
    if (event.propagationPhase === "TrickleDown") {
      if (this.shouldSuppressChildEventDuringGesture(event)) {
        event.stopPropagation()
      }
      return
    }

    if (this.scrollingPaused) return

    // Defer to drag-consuming children (Slider, TextInput, etc.).
    if (event.target.sceneObject !== this.sceneObject) {
      const interactedElement = getElement(event.target.sceneObject)
      if (interactedElement?.isDraggable && !interactedElement.inactive) return
    }

    const gesture = this.state.gesture
    // A different interactor was active — cancel its gesture first.
    if (gesture.activeInteractor && gesture.activeInteractor !== event.interactor) {
      this.cancelCurrentInteractor(ScrollGestureEndReason.InteractorSwapped, "active interactor cancelled")
    }

    gesture.activeInteractor = event.interactor

    // Branch by interaction mode. Indirect (HandInteractor far-field, Mouse, Mobile)
    // bypasses the state machine — onInteractableDragUpdate drives engagement via IK's
    // own indirectDragThreshold. Physical (poke / direct pinch) uses the state machine.
    const indirect = this.isIndirectGesture(event.interactor)
    if (indirect) {
      this._poke.useStateMachine = false
      this._poke.lastTriggerStartEvent = event
      this.resetDragState()
      return
    }

    // Physical path. Seed the interceptor only when fresh — a TriggerStart while
    // Intercepting/Engaged means IK swapped targets mid-gesture; preserve the origin.
    this._poke.useStateMachine = true
    if (this._poke.gestureInterceptor.state === GestureState.Idle) {
      this._poke.lastTriggerStartEvent = event
      // Pin the original target so its own retract still activates after the
      // state machine enters Intercepting. Stays fixed across drift swaps.
      this._poke.originalPokeTarget = event.target
      this.resetDragState()

      // Capture gesture origin in WORLD space (cm scalar invariant under scene scale).
      const intersection = event.interactor.raycastPlaneIntersection(this._interactable)
      if (intersection !== null) {
        this._poke.gestureStartWorld = intersection
        // Anchor the engagement plane at the FINGERTIP, not the back-plane intersection:
        // a child protruding in front of the back plane would otherwise produce dT > 0
        // on tick 0 and lose engagement immediately.
        let pokePlaneAnchor: vec3 = intersection
        if (event.interactor instanceof HandInteractor) {
          const tip = event.interactor.indexTipPosition
          if (tip !== null) pokePlaneAnchor = tip
        }
        this._poke._initialPokePlanePoint = pokePlaneAnchor
        this._poke._initialPlaneNormal = this.transform.forward
        this._poke.gestureInterceptor.start()
      }
    } else {
      // Drift swap mid-Intercepting/Engaged: refresh lastTriggerStartEvent so
      // engagement cancels the child the finger is currently on (not the historical
      // one). Anchor stays fixed — drift shouldn't restart dwell.
      if (this._poke.lastTriggerStartEvent !== null && event.target !== this._poke.lastTriggerStartEvent.target) {
        this._poke.lastTriggerStartEvent = event
      }
    }
  }

  /**
   * Unified classifier for IK gesture-end events. Called from the 4 end handlers
   * below. Distinguishes:
   *   1. Cancel (hand lost, deregister, secondary trigger): always end.
   *   2. Pinch release: definitive — PIP CASE 3 fires only when !isPinching().
   *   3. Poke end: could be real retract or spurious spherecast hit-loss during
   *      fast lateral motion. Defer to isFingerStillEngaged; if the finger is still
   *      inside the swept envelope, let the state-machine tick decide on retract.
   */
  private onEndCandidate(event: InteractorEvent, source: string, isCancel: boolean): void {
    const gesture = this.state.gesture
    if (gesture.activeInteractor !== event.interactor) return

    if (this.scrollingPaused) {
      this.endActiveGesture(/* applyFling */ false, ScrollGestureEndReason.Paused, "scrolling paused mid-gesture")
      return
    }

    if (isCancel) {
      this.endActiveGesture(gesture.isDragging, ScrollGestureEndReason.Canceled, "interaction canceled by IK")
      return
    }

    // Indirect path: IK's drag lifecycle is the authoritative end signal.
    if (!this._poke.useStateMachine) {
      const indirectReason =
        source === "triggerEndOutside"
          ? ScrollGestureEndReason.EndedOutside
          : ScrollGestureEndReason.IndirectInputReleased
      const indirectMessage =
        source === "triggerEndOutside" ? "input ended outside the interactable" : "indirect input released"
      this.endActiveGesture(gesture.isDragging, indirectReason, indirectMessage)
      return
    }

    // Physical path: state machine may already be done. Audited as currently
    // unreachable — every reset path (endActiveGesture, cancelCurrentInteractor)
    // goes through resetGestureState which clears activeInteractor in lockstep
    // with the interceptor. Defensive clear retained against a future out-of-
    // band interceptor reset that bypasses resetGestureState.
    if (!this._poke.gestureInterceptor.isActive) {
      gesture.activeInteractor = null
      return
    }

    const prevTrig = event.interactor.previousTrigger ?? 0
    const wasPinch = (prevTrig & InteractorTriggerType.Pinch) !== 0
    if (wasPinch) {
      this.endActiveGesture(gesture.isDragging, ScrollGestureEndReason.PinchReleased, "pinch released")
      return
    }

    // Poke end — defer to spherecast cache. If the finger is still inside the swept
    // envelope, this is a spurious end; let the tick decide on retract.
    if (this.isFingerStillEngaged(event.interactor)) return
    this.endActiveGesture(gesture.isDragging, ScrollGestureEndReason.FingerLifted, "finger lifted off the panel")
  }

  /**
   * Predicate for the paired TrickleDown suppression: true when a child Interactable
   * event should be killed because it represents in-flight gesture activity, not
   * a clean tap on the original target. Caller stopPropagation()'s to kill the
   * child's Target-phase dispatch, and (for end events) still runs onEndCandidate
   * so our gesture-end bookkeeping fires.
   *
   * Cases collapsed (unified across physical + indirect paths):
   *
   * - Committed to scroll — physical Engaged OR indirect isDragging: suppress all
   *   children. User has committed to scroll on either path; no child tap should
   *   fire. The indirect path never advances the interceptor's state machine
   *   (`useStateMachine = false`), so `isDragging` is the primary signal there;
   *   `primeEngagement` sets it on both paths.
   *
   * - Intercepting, swap-target (target !== originalPokeTarget): suppress. The user
   *   drifted across an Interactable boundary mid-gesture — strong scroll intent,
   *   the new child should never tap.
   *
   * - Intercepting, original target, finger still on plane: suppress. This is a
   *   lateral exit from the original collider while the gesture is still in flight
   *   (PIP fires TriggerEnd when finger leaves the maintain-radius envelope, even
   *   though the gesture isn't done). Without this branch, the original target
   *   taps on lateral exit and then scroll engages a few frames later. Distinguishes
   *   from a normal-tap retract via `isFingerStillEngaged`: still-on-plane ⇒
   *   in-flight, off-plane ⇒ retract.
   *
   * - Intercepting, original target, finger off plane: ALLOW (normal-tap retract).
   *
   * - Idle AND !isDragging: ALLOW (no gesture in flight).
   */
  private shouldSuppressChildEventDuringGesture(event: InteractorEvent): boolean {
    const gesture = this.state.gesture
    const state = this._poke.gestureInterceptor.state
    // Physical: state !== Idle. Indirect: isDragging (state stays Idle throughout).
    if (state === GestureState.Idle && !gesture.isDragging) return false
    if (event.interactor !== gesture.activeInteractor) return false
    if (event.target.sceneObject === this.sceneObject) return false
    // Committed to scroll: physical Engaged OR indirect drag threshold crossed.
    if (state === GestureState.Engaged || gesture.isDragging) return true
    // Intercepting (physical, pre-engagement):
    if (this._poke.originalPokeTarget === null) return false
    if (event.target !== this._poke.originalPokeTarget) return true
    // Original target during Intercepting. isFingerStillEngaged can no longer
    // distinguish tap from scroll for a pinch (it now returns true for a held
    // pinch, see below), and `Intercepting` only means "not fully dwelled" --
    // the deadzone may already have been crossed. For a pinch release (keyed on
    // previousTrigger, since currentTrigger has already gone None by TriggerEnd),
    // gate on whether the gesture EVER crossed the deadzone: crossed => scroll
    // intent, suppress the child's tap even though the state machine hasn't
    // promoted to Engaged yet (dwell incomplete, or released this same frame
    // before the LateUpdate tick); never crossed => a stationary tap, allow it
    // so the child fires. (A poke keeps the plane-based lateral-exit distinction
    // below; a poke never sets the Pinch bit.)
    if (
      event.interactor instanceof HandInteractor &&
      ((event.interactor.previousTrigger ?? 0) & InteractorTriggerType.Pinch) !== 0
    ) {
      return this._poke.gestureInterceptor.everCrossedDeadzone
    }
    // Poke: distinguish lateral exit (still on plane, suppress) from genuine
    // retract (off plane, allow normal tap).
    return this.isFingerStillEngaged(event.interactor)
  }

  private onInteractableTriggerCanceled(event: InteractorEvent): void {
    if (event.propagationPhase === "TrickleDown" && this.shouldSuppressChildEventDuringGesture(event)) {
      this.onEndCandidate(event, "triggerCanceled", /* isCancel */ true)
      event.stopPropagation()
      return
    }
    this.onEndCandidate(event, "triggerCanceled", /* isCancel */ true)
  }

  private onInteractableTriggerEnd(event: InteractorEvent): void {
    if (event.propagationPhase === "TrickleDown" && this.shouldSuppressChildEventDuringGesture(event)) {
      this.onEndCandidate(event, "triggerEnd", /* isCancel */ false)
      event.stopPropagation()
      return
    }
    this.onEndCandidate(event, "triggerEnd", /* isCancel */ false)
  }

  private onInteractableTriggerEndOutside(event: InteractorEvent): void {
    if (event.propagationPhase === "TrickleDown" && this.shouldSuppressChildEventDuringGesture(event)) {
      this.onEndCandidate(event, "triggerEndOutside", /* isCancel */ false)
      event.stopPropagation()
      return
    }
    this.onEndCandidate(event, "triggerEndOutside", /* isCancel */ false)
  }

  /**
   * Indirect-mode drag driver. Physical (poke / direct pinch) ignores this — it's
   * driven from the LateUpdate tick via the state machine. For indirect, IK fires
   * onDragUpdate once its indirectDragThreshold is crossed; we use the first firing
   * as the engagement signal and subsequent firings as per-frame scroll input.
   */
  private onInteractableDragUpdate(event: InteractorEvent): void {
    // Skip TrickleDown to avoid double-applying scroll deltas per dispatch.
    if (event.propagationPhase === "TrickleDown") return
    if (this._poke.useStateMachine) return
    if (this.scrollingPaused) return
    const gesture = this.state.gesture
    if (gesture.activeInteractor !== event.interactor) return

    const intersection = event.interactor.raycastPlaneIntersection(this._interactable)
    if (intersection === null) return
    const interactorPos = this.transform.getInvertedWorldTransform().multiplyPoint(intersection)

    if (!gesture.interactorUpdated) {
      // First drag event — engage. IK's drag threshold already filtered sub-threshold motion.
      this.primeEngagement(interactorPos, event)
      // Indirect-path Engaged event. Counterpart Disengaged fires from
      // endActiveGesture → dispatchScrollEndEvent based on `wasDragging`. The
      // physical-path Engaged event fires from `updateGestureInterceptor` when
      // the state machine transitions to Engaged. `thresholdCm` is omitted —
      // IK's `indirectDragThreshold` already gated us; no per-ScrollWindow
      // deadzone applies on the indirect path.
      this.events.scrollEngaged.invoke({
        message: "indirect drag threshold crossed"
      })
    }
    this.applyScrollDelta(interactorPos)
  }

  private onInteractableDragEnd(event: InteractorEvent): void {
    if (this.state.gesture.activeInteractor !== event.interactor) return
    // NOTE: Do NOT call event.stopPropagation() here. IK's Interactable.triggerEnd
    // invokes onDragEnd via dragEndInternal — i.e. dragEnd fires from WITHIN the
    // outer triggerEnd dispatch, sharing the dispatcher event's propagationStopped
    // flag (the {...eventArgs} spread copies the closure). Calling stopPropagation
    // here flips that flag and kills the outer triggerEnd's Target + BubbleUp —
    // meaning the child Interactable's onTriggerEnd at Target never fires, and the
    // child's Element never invokes triggerUp. Nested-ScrollWindow double-handling
    // is prevented by onEndCandidate's existing activeInteractor guard (outer's
    // activeInteractor is null since it didn't claim the gesture).
    this.onEndCandidate(event, "dragEnd", /* isCancel */ false)
  }

  // ─── Update / Physics ────────────────────────────────────────────────

  /** Per-frame driver: ticks the gesture interceptor, settles springs, steps friction/snap physics, syncs the end event. */
  private update(): void {
    // Drive the gesture interceptor first so any engage/end transitions land before
    // the physics pass below sees the updated isDragging / scrollerTransform state.
    this.updateGestureInterceptor()

    // Frustum maintenance runs every LateUpdate, independent of scroll-settle
    // state, so the optional pre-warm and debug draw honor their "every frame"
    // contract. Both are gated by opt-in flags (default off) and the frustum's
    // own lazy change-detection, so the default path stays cheap.
    if (this.updateFrustum) {
      this.frustum.refresh()
    }
    if (this.debugRender) {
      this.frustum.render()
    }

    if (this.scrollingPaused) return

    const gesture = this.state.gesture
    const engine = this.state.engine

    if (gesture.isControlledExternally) {
      return
    }

    if (gesture.isTweeningScroll) {
      this.syncScrollEndState()
      return
    }

    if (!gesture.isDragging) {
      const hasVelocity =
        engine.horizontalScroller!.hasMotion(engine.epsilon) || engine.verticalScroller!.hasMotion(engine.epsilon)

      if (!hasVelocity) {
        const cScrollPosition = this.scrollerTransform.getLocalPosition()
        const isOutOfBounds = !this.edgeClamped && this.isOutOfBounds(cScrollPosition)

        const hasCommittedSnapTarget =
          engine.horizontalSnapPolicy!.hasCommittedTarget || engine.verticalSnapPolicy!.hasCommittedTarget

        // Detent never rests between detents: falling through kicks the snap
        // path, which commits the nearest detent and springs onto it.
        if (!isOutOfBounds && !hasCommittedSnapTarget && this.isRestingOnDetents(cScrollPosition)) {
          this.syncScrollEndState()
          return
        }
      }
    }

    if (this._horizontal || this._vertical) {
      // Deferral scope: snap-index announces from inside this pass (commits,
      // plus anything a reentrant scroll-position subscriber triggers) fire
      // from flushSnapIndexAnnounce below, after the pass's final position
      // write — see announceSnapIndexValues. The block has no early returns,
      // so the flag cannot leak past the frame.
      this.state.snap.deferAnnounces = true
      // The friction/snap arm runs for elastic and clamped edges; only the
      // out-of-bounds recovery spring stays elastic-only.
      if (!gesture.isDragging) {
        let cScrollPosition = this.scrollerTransform.getLocalPosition()
        const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(cScrollPosition)
        // Per-axis routing: an out-of-bounds axis (elastic only) runs the
        // recovery spring INSTEAD of its friction/snap arm, while the other
        // axis keeps its normal motion. A whole-frame either/or here would
        // freeze the in-bounds axis's fling — undecayed — for the entire
        // recovery and then replay it at full strength, and would strand a
        // mid-settle snap latch. Clamped targets are captured as scalars:
        // the clamped scratch vec is reused by nested calls below.
        const clampedX = boundsCheck.clamped.x
        const clampedY = boundsCheck.clamped.y
        const xNeedsRecovery = !this.edgeClamped && Math.abs(cScrollPosition.x - clampedX) > engine.epsilon
        const yNeedsRecovery = !this.edgeClamped && Math.abs(cScrollPosition.y - clampedY) > engine.epsilon

        let shouldUpdatePosition = false

        // Recovery deliberately ignores the axis-enable flags — it is bounds
        // enforcement, not input, and a LOCKED axis can be left out of bounds
        // by a resize (see the respectAxisLocks note on the write below).
        if (xNeedsRecovery) {
          cScrollPosition.x = this.stepOutOfBoundsRecovery("x", cScrollPosition.x, clampedX)
          shouldUpdatePosition = true
        } else if (this._horizontal) {
          if (this.effectiveSnapMode !== "none" && this._snapRegion.x > 0) {
            const snapPosition = this.processSnapScrolling("x", cScrollPosition)
            if (snapPosition !== null) {
              cScrollPosition.x = snapPosition.x
              shouldUpdatePosition = true
            }
          } else {
            const result = this.processFrictionScrolling("x", cScrollPosition, boundsCheck.clamped)
            cScrollPosition = result.position
            shouldUpdatePosition = shouldUpdatePosition || result.shouldUpdate
          }
        } else {
          this.sweepDisabledAxisOrphanedSpring("x")
        }
        if (yNeedsRecovery) {
          cScrollPosition.y = this.stepOutOfBoundsRecovery("y", cScrollPosition.y, clampedY)
          shouldUpdatePosition = true
        } else if (this._vertical) {
          if (this.effectiveSnapMode !== "none" && this._snapRegion.y > 0) {
            const snapPosition = this.processSnapScrolling("y", cScrollPosition)
            if (snapPosition !== null) {
              cScrollPosition.y = snapPosition.y
              shouldUpdatePosition = true
            }
          } else {
            const result = this.processFrictionScrolling("y", cScrollPosition, boundsCheck.clamped)
            cScrollPosition = result.position
            shouldUpdatePosition = shouldUpdatePosition || result.shouldUpdate
          }
        } else {
          this.sweepDisabledAxisOrphanedSpring("y")
        }

        if (shouldUpdatePosition) {
          // respectAxisLocks=false: the recovery spring is bounds enforcement,
          // not input. A LOCKED axis can be left out of bounds by a resize (its
          // in-bounds guarantee — clampLockedAxes — only runs at write time);
          // the lock-respecting default would revert the corrected component
          // every frame, leaving the axis overscrolled forever with the spring
          // churning, and isScrollSettledForEndEvent withholding onScrollEnd
          // component-wide. The friction/snap arms run for — and write — only
          // ENABLED axes, so bypassing the locks is an identity for every
          // non-recovery component.
          this.updateScrollerPosition(cScrollPosition, false)
        }
      }
      this.state.snap.deferAnnounces = false
    } else {
      this.sweepDisabledAxisOrphanedSpring("x")
      this.sweepDisabledAxisOrphanedSpring("y")
    }

    // The pass is over and the frame's position is final — a subscriber
    // reacting to the snap-index event (e.g. writing scrollPosition) now runs
    // with nothing left in flight to clobber it.
    this.flushSnapIndexAnnounce()
    this.syncScrollEndState()
  }

  /**
   * Disabled-axis no-route cleanup: recovery ignores axis locks, so a locked
   * axis can carry spring velocity until recovery is deselected. With no
   * recovery, landing, or snap latch selected, that velocity is orphaned and
   * would keep hasMotion true even though no arm can consume it.
   */
  private sweepDisabledAxisOrphanedSpring(axis: "x" | "y"): void {
    const engine = this.state.engine
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    if (this.state.edgeLanding[axis] !== null || snapPolicy.hasCommittedTarget) return
    if (axisScroller.springVelocity !== 0) {
      axisScroller.springVelocity = 0
    }
  }

  /** Advances one axis of friction (momentum) scrolling by a frame. */
  private processFrictionScrolling(
    axis: "x" | "y",
    currentPosition: vec3,
    clampedPosition: vec3
  ): {position: vec3; shouldUpdate: boolean} {
    const engine = this.state.engine
    const isHorizontal = axis === "x"
    const axisScroller = isHorizontal ? engine.horizontalScroller! : engine.verticalScroller!
    const axisPosition = isHorizontal ? currentPosition.x : currentPosition.y
    const clampedAxisPosition = isHorizontal ? clampedPosition.x : clampedPosition.y

    // The friction arm's spring is live only during an edge landing, so any
    // residual spring velocity here without one is orphaned — left by an
    // out-of-bounds recovery that stopped being selected before it landed
    // (edge-mode switched to clamped mid-bounce, or a resize re-contained the
    // overscrolled position). Nothing on this route ever evaluates or decays
    // it, so it would hold hasMotion() true forever and withhold the
    // scroll-end event until the next gesture. (The snap arm needs no twin:
    // its commit handoff overwrites the spring seed unconditionally.)
    if (this.state.edgeLanding[axis] === null && axisScroller.springVelocity !== 0) {
      axisScroller.springVelocity = 0
    }

    if (this.isFlingBlockedAtEdge(axis, axisPosition, axisScroller.flingVelocity)) {
      axisScroller.clearPendingFlingVelocity()
      return {position: currentPosition, shouldUpdate: false}
    }

    // Continue an in-flight clamped-edge landing: the settle spring eases the
    // remaining distance onto the edge (velocity-continuous — no freeze, no
    // late snap, and mid-content friction is never touched).
    const activeLanding = this.state.edgeLanding[axis]
    if (activeLanding !== null) {
      const springPosition = axisScroller.evaluateSpringPosition(axisPosition, activeLanding)
      let landedPosition = springPosition
      if (axisScroller.isSpringSettled(springPosition, activeLanding)) {
        this.state.edgeLanding[axis] = null
        axisScroller.springVelocity = 0
        landedPosition = activeLanding
      }
      return this.frictionStepResult(isHorizontal, currentPosition, landedPosition)
    }

    const step = axisScroller.stepFriction(axisPosition, clampedAxisPosition)

    if (!step.shouldUpdate) {
      return {position: currentPosition, shouldUpdate: false}
    }

    let landedPosition = step.position
    if (this.edgeClamped && this._scrollDimensions[axis] !== -1) {
      const nearEdge = isHorizontal ? this.rightEdge : this.topEdge
      const farEdge = isHorizontal ? this.leftEdge : this.bottomEdge
      const minEdge = Math.min(nearEdge, farEdge)
      const maxEdge = Math.max(nearEdge, farEdge)
      if (step.position < minEdge || step.position > maxEdge) {
        // The coast would cross a clamped edge this frame: hand the remaining
        // motion to the settle spring, seeded from the live fling velocity
        // with the same handoff scale the snap system uses, so the arrival
        // feels like elastic's spring landing — without crossing the edge.
        const target = step.position < minEdge ? minEdge : maxEdge
        this.state.edgeLanding[axis] = target
        axisScroller.springVelocity = step.velocity * engine.snapParams!.snapVelocityHandoffScale
        axisScroller.clearPendingFlingVelocity()
        const springPosition = axisScroller.evaluateSpringPosition(axisPosition, target)
        // The seeded spring may transiently overshoot — never cross the edge.
        landedPosition = MathUtils.clamp(springPosition, minEdge, maxEdge)
        if (axisScroller.isSpringSettled(springPosition, target)) {
          this.state.edgeLanding[axis] = null
          axisScroller.springVelocity = 0
          landedPosition = target
        }
      }
    }

    return this.frictionStepResult(isHorizontal, currentPosition, landedPosition)
  }

  /** Packs one axis's friction/landing result into the shared frictionStep scratch. */
  private frictionStepResult(
    isHorizontal: boolean,
    currentPosition: vec3,
    landedPosition: number
  ): {position: vec3; shouldUpdate: boolean} {
    // Scratch write is safe when currentPosition already aliases this buffer
    // (the y pass after an x update): the copies below are identity writes.
    const out = this.state.scratch.frictionStep
    out.x = currentPosition.x
    out.y = currentPosition.y
    out.z = 0
    if (isHorizontal) {
      out.x = landedPosition
    } else {
      out.y = landedPosition
    }
    return {position: out, shouldUpdate: true}
  }

  /**
   * Advances one axis of elastic out-of-bounds recovery by a frame: springs
   * the position toward the clamped bounds, landing — and zeroing the spring,
   * whose residual velocity would otherwise hold hasMotion true — once the
   * output is back within epsilon of in-bounds. Runs INSTEAD of the axis's
   * friction/snap arm; the axis's own fling state is deliberately left
   * untouched, exactly as before: an outward fling is discarded by
   * isFlingBlockedAtEdge once the arm resumes, an inward one coasts on.
   */
  private stepOutOfBoundsRecovery(axis: "x" | "y", currentAxisPosition: number, clampedAxisPosition: number): number {
    const engine = this.state.engine
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    const springPosition = axisScroller.evaluateSpringPosition(currentAxisPosition, clampedAxisPosition)
    const clampedSpringPosition = this.getClampedAxisPosition(axis, springPosition)
    if (Math.abs(springPosition - clampedSpringPosition) <= engine.epsilon) {
      axisScroller.springVelocity = 0
      return clampedSpringPosition
    }
    return springPosition
  }

  /**
   * Cancels every in-flight clamped-edge landing when a direct takeover
   * invalidates all landing targets (drag start, programmatic writes, tweens,
   * velocity kicks, edge-mode changes, or geometry changes). Snap-route
   * switches are intentionally handled per-axis at processSnapScrolling entry:
   * only an axis actually entering the snap arm should drop its landing, while
   * route-neutral toggles let the friction landing continue to the edge.
   */
  private clearEdgeLanding(): void {
    this.clearEdgeLandingForAxis("x")
    this.clearEdgeLandingForAxis("y")
  }

  /** Per-axis clearEdgeLanding: drops the landing latch and its residual spring velocity. */
  private clearEdgeLandingForAxis(axis: "x" | "y"): void {
    const landing = this.state.edgeLanding
    if (landing[axis] === null) return
    landing[axis] = null
    const engine = this.state.engine
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    axisScroller.springVelocity = 0
  }

  /**
   * Advances one axis of page-snap scrolling by a frame (commit target, then spring-settle).
   * Returns a borrowed position scratch when the caller should write, or null when no write is needed.
   */
  private processSnapScrolling(axis: "x" | "y", currentPosition: vec3): vec3 | null {
    const engine = this.state.engine
    const isHorizontal = axis === "x"
    const axisScroller = isHorizontal ? engine.horizontalScroller! : engine.verticalScroller!
    const snapPolicy = isHorizontal ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    const snapSize = this._snapRegion[axis]
    const currentAxisPosition = isHorizontal ? currentPosition.x : currentPosition.y

    // The snap arm owns this axis, so any clamped-edge landing here is
    // orphaned by definition (the routes are exclusive): a landing latched by
    // the friction arm survives a runtime route switch (scrollSnapping toggled
    // on, snapRegion set positive mid-landing) because the arm that consumes
    // it stops running. Left latched, the next clearEdgeLanding — any resize —
    // would zero this axis's settle spring mid-glide, stranding a committed
    // paging latch behind update()'s early-rest gate and withholding the
    // scroll-end event. Clearing at entry makes the invariant self-healing
    // for every route-switch path; the commit's velocity handoff below
    // overwrites the spring seed anyway.
    this.clearEdgeLandingForAxis(axis)

    // Read before the handoff below consumes the pending fling.
    const velocity = axisScroller.flingVelocity

    if (!snapPolicy.hasCommittedTarget) {
      const hasBounds = this._scrollDimensions[axis] !== -1
      // Reading-order frame: pages anchor at the top edge (y) / LEFT edge (x),
      // and x page indices increase as P DECREASES.
      const direction = isHorizontal ? -1 : 1
      const startEdge = hasBounds ? (isHorizontal ? this.leftEdge : this.topEdge) : null
      const endEdge = hasBounds ? (isHorizontal ? this.rightEdge : this.bottomEdge) : null
      // A partial terminal span can round to the next grid index even though
      // that page lies beyond the bounded range (for example span 25, pitch
      // 10: round(2.5) = 3 while maxValidPageIndex = 2). Normalize both cap
      // anchors before projection; clamping only the final target is too late
      // because an invalid release anchor can already exclude a valid target.
      const boundedMaxPageIndex = hasBounds
        ? isAxisScrollable(this._scrollDimensions[axis], this._windowSize[axis], engine.epsilon)
          ? maxValidPageIndex(startEdge!, endEdge!, snapSize)
          : 0
        : null
      const startPageIndex =
        boundedMaxPageIndex === null
          ? snapPolicy.startingPageIndex
          : MathUtils.clamp(snapPolicy.startingPageIndex, 0, boundedMaxPageIndex)
      const pagePosition = (pageIndex: number): number =>
        pagePositionForIndex(pageIndex, startEdge, direction, snapSize)

      // One-shot setVelocity exemption — consumed by this commit whether or
      // not it ends up mattering, so a stale flag can never alter a later
      // gesture's deadzone.
      const snap = this.state.snap
      const isProgrammaticKick = isHorizontal ? snap.programmaticKickX : snap.programmaticKickY
      if (isHorizontal) {
        snap.programmaticKickX = false
      } else {
        snap.programmaticKickY = false
      }

      const rawCurrentPageIndex = this.getPageIndexFromPosition(axis, currentAxisPosition)
      const currentPageIndex =
        boundedMaxPageIndex === null
          ? rawCurrentPageIndex
          : MathUtils.clamp(rawCurrentPageIndex, 0, boundedMaxPageIndex)
      // Convert bounded x into the reading-order frame used by page indices.
      // Unbounded axes retain V1's raw-position page frame, so no sign flip.
      const readingDirection = hasBounds ? direction : 1
      const projectionVelocity = velocity * readingDirection
      const projectedDistance = axisScroller.getProjectedFlingDistance(Math.abs(velocity))
      const deadzone = snapSize * engine.snapParams!.deadzoneFraction
      let targetPageIndex: number
      if (this.effectiveSnapMode === "detent" && !axisScroller.hasPendingFlingVelocity) {
        // Detent idle re-snap: commit the nearest detent directly — projecting
        // against a possibly stale anchor could yank the view to a far page.
        targetPageIndex = currentPageIndex
      } else if (this.effectiveSnapMode === "detent" && !isProgrammaticKick) {
        // Detent gestures project from the gesture start, matching NumberPicker:
        // once the deadzone is crossed, a slow release advances in the drag
        // direction, while a fast release counts projected travel from the
        // start instead of adding it on top of the nearest release page. This
        // removes the half-pitch discontinuity where nearly identical releases
        // could previously resolve to the start page or skip an extra detent.
        targetPageIndex = projectSnapPageFromStart({
          startPageIndex,
          releasePageIndex: currentPageIndex,
          currentPosition: currentAxisPosition * readingDirection,
          startPosition: snapPolicy.startingPosition * readingDirection,
          velocity: projectionVelocity,
          minFlingVelocity: engine.minimumScrollingVelocity,
          projectedDistance,
          pitch: snapSize,
          deadzone,
          // The projection cap limits fling-contributed steps while preserving
          // detents the finger physically crossed (projectSnapPageFromStart's
          // pagesFromDrag branch), matching the existing Detent contract.
          maxProjectedPages: this.resolvedMaxSnapSteps
        })
      } else {
        const projection = {
          currentPageIndex,
          currentPagePosition: pagePosition(currentPageIndex) * readingDirection,
          startPageIndex,
          currentPosition: currentAxisPosition * readingDirection,
          startPosition: snapPolicy.startingPosition * readingDirection,
          // Position and velocity share the reading-order frame here. Bounded x
          // flips both; unbounded axes retain the raw V1 page frame.
          velocity: projectionVelocity,
          minFlingVelocity: engine.minimumScrollingVelocity,
          projectedDistance,
          pitch: snapSize,
          // Deadzone is one-quarter of a page; movement below it snaps back to
          // the starting page. A programmatic kick has no gesture displacement
          // to measure, so it passes an always-exceeded deadzone instead —
          // fast kicks take the fling branch, sub-threshold kicks settle on
          // the current page (never the snap-back branch).
          deadzone: isProgrammaticKick ? -1 : deadzone
        }
        if (this.effectiveSnapMode === "detent") {
          // Programmatic Detent kicks use current-position projection so a
          // zero-displacement setVelocity() is not swallowed by the gesture
          // deadzone. Keep their established Detent cap independent of the
          // Paging-only cap mode, including when recovery delays the commit
          // long enough for the start and current indices to diverge.
          targetPageIndex = projectSnapPageFromCurrent({
            ...projection,
            maxPagesFromStart: detentMaxPagesFromStart(startPageIndex, currentPageIndex, this.resolvedMaxSnapSteps)
          })
        } else if (this._pagingSnapCapMode === "gestureStart") {
          targetPageIndex = projectSnapPageFromCurrent({
            ...projection,
            // Compatibility contract: cap the final target around the
            // gesture start, exactly as maxSnapOne did.
            maxPagesFromStart: this.resolvedMaxSnapSteps
          })
        } else {
          targetPageIndex = projectSnapPageFromCurrent({
            ...projection,
            // Explicit opt-in: anchor the cap at the release page so the
            // cap itself does not truncate drag travel. Projection may
            // still move backward when the release fling opposes the drag.
            maxPagesFromRelease: this.resolvedMaxSnapSteps
          })
        }
      }

      if (boundedMaxPageIndex !== null) {
        // Non-scrollable axes (content <= window) have only page 0 —
        // maxValidPageIndex's |span| would read the INVERTED edges as real
        // pages, letting a deadzone-exempt programmatic kick commit a target
        // the settle spring can never reach (the axis is pinned to 0), which
        // would strand the latch and withhold the scroll-end event forever.
        // Mirrors the isAxisScrollable guard at every sibling index consumer.
        targetPageIndex = MathUtils.clamp(targetPageIndex, 0, boundedMaxPageIndex)
      }

      const targetPos = this.commitSnapTarget(axis, targetPageIndex, pagePosition(targetPageIndex))
      axisScroller.springVelocity = snapPolicy.consumeSnapVelocityHandoff(
        axisScroller,
        targetPos,
        currentAxisPosition,
        snapSize / engine.velocityBaseFrameTime
      )
    }

    const step = isHorizontal ? this.state.scratch.snapSettleX : this.state.scratch.snapSettleY
    snapPolicy.stepSettleInto(
      axisScroller,
      currentAxisPosition,
      engine.epsilon,
      engine.minimumScrollingVelocity * 0.05,
      step,
      this.state.scratch.snapSettleOptions
    )

    if (step.settled) {
      this.clearSnapTarget(axis)
      axisScroller.clearPendingFlingVelocity()
    }

    if (step.alreadyAtTarget) {
      return null
    }

    // Distinct from frictionStep: a mixed frame (friction x, snap y) reads the
    // friction output while writing this buffer.
    const out = this.state.scratch.snapStep
    out.x = currentPosition.x
    out.y = currentPosition.y
    out.z = 0
    if (isHorizontal) {
      out.x = step.position
    } else {
      out.y = step.position
    }

    return out
  }

  // Mutates `newPosition` in place — don't pass a vec3 you intend to reuse afterward.
  // respectAxisLocks: gesture/physics callers (default) freeze axes whose
  // vertical/horizontal flag is off; programmatic callers pass false — the axis
  // flags gate input, not the API.
  private updateScrollerPosition(newPosition: vec3, respectAxisLocks: boolean = true): vec3 {
    const currentPos = this.scrollerTransform.getLocalPosition()
    if (this.edgeClamped) {
      // Clamp writes to the CLAMPED bounds (not the raw edges): on a
      // non-scrollable bounded axis (content <= window) the edges invert and a
      // raw-edge compare would reject every value including the rest pose 0.
      const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(newPosition)
      const epsilon = this.state.engine.epsilon
      if (this._scrollDimensions.y !== -1 && Math.abs(newPosition.y - boundsCheck.clamped.y) > epsilon) {
        newPosition.y = boundsCheck.clamped.y
      }
      if (this._scrollDimensions.x !== -1 && Math.abs(newPosition.x - boundsCheck.clamped.x) > epsilon) {
        newPosition.x = boundsCheck.clamped.x
      }
    }
    if (respectAxisLocks) {
      if (!this._horizontal) newPosition.x = currentPos.x
      if (!this._vertical) newPosition.y = currentPos.y
    }
    newPosition.z = 0
    this.scrollerTransform.setLocalPosition(newPosition)

    this._scrollPosition.x = newPosition.x
    this._scrollPosition.y = newPosition.y

    if (this._edgeFade) {
      this.updateEdgeFadeStrength()
    }

    const scrollPosUpdated = this.state.scratch.scrollPosUpdated
    scrollPosUpdated.x = newPosition.x
    scrollPosUpdated.y = newPosition.y
    this.events.scrollPositionUpdated.invoke(scrollPosUpdated)
    return newPosition
  }

  /** Recover the raw drag pose using the axis scroller's resistance curve. */
  private getUnresistedDragPosition(axis: "x" | "y", position: number): number {
    if (this.edgeClamped) return position
    const clamped = this.getClampedAxisPosition(axis, position)
    const displacement = position - clamped
    const engine = this.state.engine
    const maxOverscroll = this._windowSize[axis] * engine.maxOvershootFactor
    const scroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    return clamped + scroller.calculateUnresistedDisplacement(displacement, maxOverscroll)
  }

  /**
   * Applies rubber-band overscroll resistance when `position` is out of bounds.
   * Returns `position` untouched when in bounds; otherwise returns the shared
   * `scratch.overscroll` buffer — callers must not retain either across ticks.
   */
  private applyOverscrollIfNeeded(position: vec3): vec3 {
    if (!this.edgeClamped) {
      const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(position)
      if (boundsCheck.isOutOfBounds) {
        const engine = this.state.engine
        const out = this.state.scratch.overscroll
        out.x = engine.horizontalScroller!.applyOverscroll(
          position.x,
          {min: boundsCheck.clamped.x, max: boundsCheck.clamped.x},
          this._windowSize.x * engine.maxOvershootFactor
        )
        out.y = engine.verticalScroller!.applyOverscroll(
          position.y,
          {min: boundsCheck.clamped.y, max: boundsCheck.clamped.y},
          this._windowSize.y * engine.maxOvershootFactor
        )
        out.z = 0
        return out
      }
    }
    return position
  }

  /**
   * Maps a local-space position to its nearest snap-page index on one axis in
   * the reading-order frame: page 0 at the top edge (y) / LEFT edge (x), with
   * x indices increasing as the raw position DECREASES.
   */
  private getPageIndexFromPosition(axis: "x" | "y", currentPosition: number): number {
    const pitch = this._snapRegion[axis]
    if (pitch <= 0) return 0
    if (this._scrollDimensions[axis] === -1) {
      return pageIndexFromPosition(currentPosition, null, axis === "x" ? -1 : 1, pitch)
    }
    return axis === "x"
      ? pageIndexFromPosition(currentPosition, this.leftEdge, -1, pitch)
      : pageIndexFromPosition(currentPosition, this.topEdge, 1, pitch)
  }

  /** Feeds the current position into both axis scrollers' velocity trackers. */
  private updateVelocityFromPosition(newPosition: vec2 | vec3, velocityScaleX?: number, velocityScaleY?: number): void {
    const engine = this.state.engine
    const deltaTime = getDeltaTime()
    const currentTimeMs = getTime() * 1000
    const scaleX = velocityScaleX === undefined ? 1 : velocityScaleX
    const scaleY = velocityScaleY === undefined ? 1 : velocityScaleY
    engine.horizontalScroller!.updateVelocityFromPosition(newPosition.x, deltaTime, currentTimeMs, scaleX)
    engine.verticalScroller!.updateVelocityFromPosition(newPosition.y, deltaTime, currentTimeMs, scaleY)
  }

  /**
   * Returns true when a fling on `axis` points into an edge it cannot move past.
   * Exact-at-edge outward flings are intentionally blocked even in elastic mode:
   * a fresh bounce requires overscroll displacement first, while an at-edge
   * outward velocity is commonly stale momentum left after elastic recovery.
   * stepOutOfBoundsRecovery relies on this to discard that stale fling once the
   * axis resumes its friction arm; allowing edge-exact bounces would need a
   * fresh-user-fling signal distinct from post-recovery leftovers.
   */
  private isFlingBlockedAtEdge(axis: "x" | "y", position: number, velocity: number): boolean {
    const engine = this.state.engine
    if (Math.abs(velocity) <= engine.epsilon || this._scrollDimensions[axis] === -1) {
      return false
    }

    if (this._scrollDimensions[axis] <= this._windowSize[axis]) {
      return true
    }

    const nearEdge = axis === "x" ? this.rightEdge : this.topEdge
    const farEdge = axis === "x" ? this.leftEdge : this.bottomEdge
    const minEdge = Math.min(nearEdge, farEdge)
    const maxEdge = Math.max(nearEdge, farEdge)

    return (
      (position <= minEdge + engine.epsilon && velocity < 0) || (position >= maxEdge - engine.epsilon && velocity > 0)
    )
  }

  /**
   * Gives programmatic position writes ownership of the next frame. External
   * controllers stream position samples, so preserve velocity history for their
   * release handoff while still dropping stale snap/edge latches.
   */
  private prepareProgrammaticPositionWrite(): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    gesture.scrollTweenCancel()
    this.clearEdgeLanding()
    if (!gesture.isControlledExternally) {
      engine.horizontalScroller!.cancelMotion()
      engine.verticalScroller!.cancelMotion()
    }
    this.clearSnapTarget("x")
    this.clearSnapTarget("y")
    // The position write supersedes any un-consumed setVelocity kick.
    this.state.snap.programmaticKickX = false
    this.state.snap.programmaticKickY = false
  }

  /**
   * Seeds every position-derived gesture, velocity-sampling, and snap-policy
   * anchor without altering pending motion. Initialization uses this narrower
   * primitive so a pre-initialize setVelocity() remains intact; resetDragState
   * performs its motion cleanup separately before calling it.
   */
  private seedPositionAnchors(position: vec3): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    const positionX = position.x
    const positionY = position.y
    gesture.startPosition = new vec3(positionX, positionY, position.z)
    engine.horizontalScroller!.startPosition = positionX
    engine.verticalScroller!.startPosition = positionY
    engine.horizontalScroller!.lastPosition = positionX
    engine.verticalScroller!.lastPosition = positionY
    engine.horizontalSnapPolicy!.setStartAnchor(this.getPageIndexFromPosition("x", positionX), positionX)
    engine.verticalSnapPolicy!.setStartAnchor(this.getPageIndexFromPosition("y", positionY), positionY)
  }

  /** Resets per-gesture drag bookkeeping and re-seeds the snap anchors. */
  private resetDragState(): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    gesture.interactorOffset = vec3.zero()
    gesture.interactorUpdated = false
    gesture.dragAmount.x = 0
    gesture.dragAmount.y = 0

    engine.horizontalScroller!.clearVelocityHistory()
    engine.verticalScroller!.clearVelocityHistory()
    engine.horizontalScroller!.clearPendingFlingVelocity()
    engine.verticalScroller!.clearPendingFlingVelocity()
    engine.horizontalScroller!.springVelocity = 0
    engine.verticalScroller!.springVelocity = 0
    // Springs already zeroed above — just drop any in-flight edge landing.
    this.state.edgeLanding.x = null
    this.state.edgeLanding.y = null

    // Keep any committed snap target alive here: resetDragState also runs for
    // tentative taps that never engage, and clearing a paging latch mid-settle
    // would strand the content off-grid. Real scroll takeovers clear the latch
    // in primeEngagement(), once the gesture has actually engaged.
    this.seedPositionAnchors(this.scrollerTransform.getLocalPosition())
    // A fresh gesture owns the motion — its release must face the real deadzone.
    this.state.snap.programmaticKickX = false
    this.state.snap.programmaticKickY = false
  }

  /** Flushes velocity accumulated while externally controlled into the fling physics. */
  private applyAccumulatedVelocity(): void {
    const engine = this.state.engine
    const currentTimeMs = getTime() * 1000
    engine.horizontalScroller!.applyAccumulatedVelocity(currentTimeMs)
    engine.verticalScroller!.applyAccumulatedVelocity(currentTimeMs)
    if (!this._horizontal) engine.horizontalScroller!.clearPendingFlingVelocity()
    if (!this._vertical) engine.verticalScroller!.clearPendingFlingVelocity()
  }

  // The scroll frame is TOP-LEFT ANCHORED: the scroller rests at local (0, 0)
  // showing the authored view (the content's top-left), and scrolling through
  // the content moves it toward bottomEdge / rightEdge. Unlike the classic
  // ScrollWindow (centered content box, edges at ±(D−W)/2), the page origin
  // here is position-invariant under content resize — dimension changes never
  // shift content under the finger, so no anchor compensation exists.

  /** Scroller-local Y of the topmost scroll position — the content origin (0). */
  private get topEdge(): number {
    return 0
  }

  /** Scroller-local Y of the bottommost scroll position. */
  private get bottomEdge(): number {
    return this._scrollDimensions.y - this._windowSize.y
  }

  /** Scroller-local X of the leftmost scroll position — the content origin (0). */
  private get leftEdge(): number {
    return 0
  }

  /** Scroller-local X of the rightmost scroll position. */
  private get rightEdge(): number {
    return -(this._scrollDimensions.x - this._windowSize.x)
  }

  /** Clamps `scrollPos` to the scroll bounds (into the shared clamped-bounds scratch) and flags overshoot. */
  private getClampedBoundsAndCheckOutOfBounds(scrollPos: vec3): {
    clamped: vec3
    isOutOfBounds: boolean
  } {
    const engine = this.state.engine
    const clampedX =
      this._scrollDimensions.x === -1
        ? scrollPos.x
        : this._scrollDimensions.x > this._windowSize.x
          ? MathUtils.clamp(scrollPos.x, this.rightEdge, this.leftEdge)
          : 0

    const clampedY =
      this._scrollDimensions.y === -1
        ? scrollPos.y
        : this._scrollDimensions.y > this._windowSize.y
          ? MathUtils.clamp(scrollPos.y, this.topEdge, this.bottomEdge)
          : 0

    const clamped = this.state.scratch.clampedBounds
    clamped.x = clampedX
    clamped.y = clampedY
    clamped.z = 0

    // Z is excluded — the scroller is 2D and Z drift would trap update() in the overshoot path forever.
    const isOutOfBounds =
      Math.abs(scrollPos.x - clampedX) > engine.epsilon || Math.abs(scrollPos.y - clampedY) > engine.epsilon

    return {clamped, isOutOfBounds}
  }

  /** Per-axis scalar clamp (same rules as getClampedBoundsAndCheckOutOfBounds) — no scratch use. */
  private getClampedAxisPosition(axis: "x" | "y", position: number): number {
    const dims = this._scrollDimensions[axis]
    if (dims === -1) return position
    if (dims <= this._windowSize[axis]) return 0
    return axis === "x"
      ? MathUtils.clamp(position, this.rightEdge, this.leftEdge)
      : MathUtils.clamp(position, this.topEdge, this.bottomEdge)
  }

  /** Allocation-free out-of-bounds test (same clamp rules as getClampedBoundsAndCheckOutOfBounds). */
  private isOutOfBounds(scrollPos: vec3): boolean {
    const engine = this.state.engine
    const clampedX =
      this._scrollDimensions.x === -1
        ? scrollPos.x
        : this._scrollDimensions.x > this._windowSize.x
          ? MathUtils.clamp(scrollPos.x, this.rightEdge, this.leftEdge)
          : 0
    if (Math.abs(scrollPos.x - clampedX) > engine.epsilon) return true
    const clampedY =
      this._scrollDimensions.y === -1
        ? scrollPos.y
        : this._scrollDimensions.y > this._windowSize.y
          ? MathUtils.clamp(scrollPos.y, this.topEdge, this.bottomEdge)
          : 0
    return Math.abs(scrollPos.y - clampedY) > engine.epsilon
  }

  /** True when no drag, tween, motion, snap latch, overshoot, or owed detent re-snap keeps the scroll live. */
  private isScrollSettledForEndEvent(): boolean {
    const gesture = this.state.gesture
    const engine = this.state.engine
    if (gesture.isTweeningScroll) {
      return false
    }
    if (gesture.isDragging) {
      return false
    }
    if (engine.horizontalScroller!.hasMotion(engine.epsilon) || engine.verticalScroller!.hasMotion(engine.epsilon)) {
      return false
    }
    if (engine.horizontalSnapPolicy!.hasCommittedTarget || engine.verticalSnapPolicy!.hasCommittedTarget) {
      return false
    }
    const cScrollPosition = this.scrollerTransform.getLocalPosition()
    if (!this.edgeClamped && this.isOutOfBounds(cScrollPosition)) {
      return false
    }
    // Detent: the scroll never counts as ended while resting off-index — an
    // autonomous re-snap is still owed (from ANY syncScrollEndState call site).
    if (!this.isRestingOnDetents(cScrollPosition)) {
      return false
    }
    return true
  }

  /** Edge-detects settled state and fires the scroll-end event on the not-settled → settled transition. */
  private syncScrollEndState(): void {
    if (!this._initialized) {
      return
    }
    const gesture = this.state.gesture
    const isSettled = this.isScrollSettledForEndEvent()
    if (!gesture.wasScrollSettled && isSettled) {
      // Snap indices announce at COMMIT time; motion that ends WITHOUT a
      // commit (interrupted snap, tween destination, blocked velocity kick)
      // rests wherever it stopped, so correct the announced indices from the
      // rest position first — scroll-end subscribers must read a fresh
      // snapIndex. A normal snap settle rests exactly on the committed page
      // and dedupes to silence; detent additionally never reaches this
      // settle off-index (isScrollSettledForEndEvent withholds it).
      this.announceRestingSnapIndices(this.scrollerTransform.getLocalPosition())
      this.events.scrollEnd.invoke()
    }
    gesture.wasScrollSettled = isSettled
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /** Enables or disables every descendant collider (except this component's own), honoring Element state. */
  private enableChildColliders(enable: boolean): void {
    const colliders = this.state.colliders
    if (colliders.skipColliderManagement) return
    if (colliders.lastChildCollidersEnabled === enable && colliders.childCollidersCache !== null) return

    let childColliders = colliders.childCollidersCache
    if (childColliders === null) {
      childColliders = findAllComponentsInSelfOrChildren(this.sceneObject, "ColliderComponent")
      colliders.childCollidersCache = childColliders

      // Drop element-cache entries for colliders no longer in the subtree.
      const currentColliders = new Set(childColliders)
      for (const cachedCollider of colliders.colliderToElementMap.keys()) {
        if (!currentColliders.has(cachedCollider)) {
          colliders.colliderToElementMap.delete(cachedCollider)
        }
      }
    }

    for (let i = 0; i < childColliders.length; i++) {
      const collider = childColliders[i]
      if (isNull(collider)) continue
      if (collider === this.collider) continue

      let element = colliders.colliderToElementMap.get(collider)

      if (element === undefined) {
        element = getElement(collider.sceneObject.getParent())
        if (element && element.collider) {
          colliders.colliderToElementMap.set(element.collider, element)
        }
      }

      if (element && element.collider === collider) {
        collider.enabled = enable && element.enabled && !element.inactive
      } else {
        collider.enabled = enable
      }
    }
    colliders.lastChildCollidersEnabled = enable
  }

  /**
   * Drops the active interactor and gesture state and kills in-flight motion,
   * firing the appropriate Disengaged/Rejected lifecycle event.
   *
   * Caller must specify the reason + message — there is no sensible default
   * across the call sites (paused, disabled, external-control, interactor-
   * swap). A default would invite future callers to silently fire the wrong
   * reason.
   */
  private cancelCurrentInteractor(endReason: ScrollGestureEndReason, endMessage: string): void {
    const gesture = this.state.gesture
    const engine = this.state.engine
    const captured = this.resetGestureState()
    // Cancel paths zero drag-state (no fling); endActiveGesture leaves the
    // release velocity to the scrollers instead.
    gesture.interactorUpdated = false
    gesture.dragAmount.x = 0
    gesture.dragAmount.y = 0
    gesture.interactorOffset = vec3.zero()
    this.dispatchScrollEndEvent(captured, {reason: endReason, message: endMessage})
    // Restore child colliders to the idle-enabled state. The previous behaviour
    // (`enableChildColliders(false)`) relied on a follow-up hover-enter to re-
    // enable. For cancel paths without a follow-up hover (scrollingPaused,
    // isControlledExternally takeover, no-active-hover-at-cancel), children
    // stayed permanently un-clickable until something else re-hovered. Restore
    // to true so the paused/external-control state has interactable children
    // by default — the dispatch-phase suppression during an active scroll is
    // the real mechanism that prevents child mis-activation; the collider gate
    // was redundant for that and was actively blocking legitimate post-cancel
    // interactivity.
    this.enableChildColliders(true)
    gesture.scrollTweenCancel()

    engine.horizontalScroller!.cancelMotion()
    engine.verticalScroller!.cancelMotion()

    if (!this.edgeClamped) {
      const currentPosition = this.scrollerTransform.getLocalPosition()
      const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(currentPosition)
      if (boundsCheck.isOutOfBounds) {
        this.updateScrollerPosition(boundsCheck.clamped)
      }
    }

    // Re-seed the snap anchors from the rest pose — a programmatic setVelocity()
    // right after the cancel would otherwise snap relative to a stale page.
    const currentPosition = this.scrollerTransform.getLocalPosition()
    this.reseedSnapAxis("x", currentPosition.x)
    this.reseedSnapAxis("y", currentPosition.y)
  }

  /** Cancels any in-flight trigger on descendant interactables once a scroll drag takes over. */
  private cancelChildInteraction(e: InteractableEventArgs): void {
    // Route TriggerCanceled to the actual interaction target via the dispatcher,
    // with `origin: this._interactable` as the exclusion node. The dispatcher walks
    // `target → ancestors below ScrollWindow` only (typically 1-3 interactables),
    // not the entire descendant tree. Previous O(n) implementation
    // (findAllComponentsInSelfOrChildren) caused a visible engagement-frame hitch
    // for ScrollWindows holding feeds of dozens-to-hundreds of items.
    // Skip no-op: if ScrollWindow itself is the target, dispatching with
    // target=this._interactable would route TriggerCanceled back to our own
    // subscriber and tear down the gesture we just primed.
    if (e.target === this._interactable) return
    InteractionManager.getInstance().dispatchEvent({
      interactor: e.interactor,
      target: e.target,
      eventName: "TriggerCanceled",
      origin: this._interactable
    })
  }

  /** Applies the window viewport size to anchors, mask material, collider, frustum, and size event. */
  private setWindowSize(size: vec2): void {
    this._windowSize = size
    this.screenTransform.anchors.left = this._windowSize.x * -0.5
    this.screenTransform.anchors.right = this._windowSize.x * 0.5
    this.screenTransform.anchors.bottom = this._windowSize.y * -0.5
    this.screenTransform.anchors.top = this._windowSize.y * 0.5
    if (this._edgeFade) {
      this.refreshEdgeFade()
    }
    this.applyColliderSize()
    // Feed the near-plane size to the frustum (local space; it scales by world
    // scale at refresh). This is the only place the frustum needs sizing.
    this.frustum.setSize(this._windowSize)
    // The TopLeft content origin is the viewport corner — it moves with size.
    this.applyContentOriginPosition()
    this.events.sizeChanged.invoke(this.layoutSize)
    // The scroll edges derive from windowSize too (bottomEdge = D − W,
    // rightEdge = −(D − W)), so a viewport GROW shrinks the range: mirror
    // setScrollDimensions' tail. Gated on initialized — initialize() routes
    // through here before the scroller exists, and pre-init there is nothing
    // to re-clamp.
    if (this._initialized) {
      this.reclampSnapAxisAfterResize("x")
      this.reclampSnapAxisAfterResize("y")
      // The edges moved — an in-flight landing would ease onto a stale target.
      this.clearEdgeLanding()
      if (this.edgeClamped) {
        const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(this.scrollerTransform.getLocalPosition())
        if (boundsCheck.isOutOfBounds) {
          this.updateScrollerPosition(boundsCheck.clamped, false)
        }
      }
      // Elastic + every axis gesture-disabled: the recovery spring never runs.
      this.clampBackIfUnrecoverable()
      this.syncScrollEndState()
    }
  }

  /**
   * Re-apply the interaction collider size from windowSize and colliderInset. Doesn't touch the
   * screenTransform, mask material, or fire onSizeChangedEvent — call setWindowSize for those.
   * Depth is kept thin (0.5 cm) so the auto-collider doesn't envelop child UI colliders sitting
   * at local Z≈0 — a poke would otherwise commit to the parent surface and starve child targets.
   */
  private applyColliderSize(): void {
    const colliders = this.state.colliders
    const colliderX = Math.max(this._windowSize.x - colliders.colliderInset.x * 2, 0)
    const colliderY = Math.max(this._windowSize.y - colliders.colliderInset.y * 2, 0)
    colliders.colliderShape.size = new vec3(colliderX, colliderY, 0.5)
    this.collider.shape = colliders.colliderShape
  }

  /** Creates (or reuses) the edge-fade band visual with a cloned fade-mask material. */
  private createEdgeFade(): void {
    // The fade lives on its own child object, created after the scroller so it
    // sits last in the hierarchy: Canvas sorts by hierarchy order by default,
    // and an RMV on the ScrollWindow object itself would be drawn before (and
    // hidden under) the content.
    if (!this.fadeObject) {
      this.fadeObject = global.scene.createSceneObject("ScrollWindowEdgeFade")
      this.managedSceneObjects.push(this.fadeObject)
      this.fadeObject.layer = this.sceneObject.layer
      this.fadeObject.setParent(this.sceneObject)
      // Explicit ±1 anchors pin the fade to the parent rect's edges (anchors
      // are normalized to the parent), so the fade tracks the window's true
      // rect under Canvas and layout resizing alike.
      const fadeScreenTransform = this.fadeObject.createComponent("ScreenTransform")
      fadeScreenTransform.anchors.left = -1
      fadeScreenTransform.anchors.right = 1
      fadeScreenTransform.anchors.bottom = -1
      fadeScreenTransform.anchors.top = 1
    }
    this.rmv = this.fadeObject.getComponent("RenderMeshVisual") || this.fadeObject.createComponent("RenderMeshVisual")
    // The enable/disable machinery special-cases the fade rmv by identity —
    // it must be in managedComponents for OnDisable/OnEnable to manage it.
    this.managedComponents.push(this.rmv)
    this.material = this.material.clone()
    // Depth-tested, so the fade can be occluded by anything genuinely in front
    // of it — an overlapping panel, a TextInputField docked forward to the
    // keyboard. It previously ran with depthTest off and a renderOrder derived
    // as max(content) + 1, which made it unsortable against everything outside
    // this window: nothing could ever draw over it, at any distance.
    //
    // The reason depth was off was that content sitting forward of the window
    // plane rejects a coplanar fade. EDGE_FADE_DEPTH_BIAS solves that in the
    // depth comparison rather than by displacing the fade, so it stays
    // geometrically coplanar with the window (no parallax) while still covering
    // its content. Never writes depth: the fade's transparent ramp would
    // otherwise punch a hole in whatever is behind it.
    //
    // Same combination the EdgeFade component uses to sort correctly —
    // depthTest on, depthWrite off, renderOrder inherited rather than escalated
    // — with a depth bias standing in for its hairline z offset.
    this.material.mainPass.depthTest = true
    this.material.mainPass.depthWrite = false
    this.material.mainPass.polygonOffset = EDGE_FADE_DEPTH_BIAS
    this.rmv.mainMaterial = this.material
    // The fade shader's alpha saturates to 0 everywhere further than
    // cornerRadius + softness from the window border, so band strips render
    // pixel-identically to a full-window quad while skipping the interior's
    // overdraw (each overlapped layer re-shades every pixel under it).
    this.fadeMeshBuilder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "texture0", components: 2}
    ])
    this.fadeMeshBuilder.topology = MeshTopology.Triangles
    this.fadeMeshBuilder.indexType = MeshIndexType.UInt16
    this.refreshEdgeFade()
    this.rmv.mesh = this.fadeMeshBuilder.getMesh()
  }

  /** Runtime edge-fade toggle; creates the visual lazily on first enable. */
  private enableEdgeFade(enable: boolean): void {
    this._edgeFade = enable
    if (enable && !this.rmv) {
      this.createEdgeFade()
    }
    if (this.rmv) {
      this.rmv.enabled = enable
      // Window size / corner radius may have changed while the fade was disabled.
      if (enable) {
        this.refreshEdgeFade()
      }
    }
  }

  // Sync the fade material's uniforms and rebuild the fade-band strips for the
  // current window size / corner radius / scroll axes. Positions span ±0.5
  // with z=0 (Unit Plane convention), uv = position + 0.5; the unlit fade
  // shader needs no normals.
  private refreshEdgeFade(): void {
    const builder = this.fadeMeshBuilder
    if (!builder) {
      return
    }
    const radius = this.maskingComponent.cornerRadius
    this.material.mainPass.windowSize = this._windowSize
    this.material.mainPass.radius = radius
    this.material.mainPass.fadeColor = this._edgeFadeColor
    this.applyEdgeFadeRenderOrder()

    const softnessValue = this.material.mainPass.softness
    const softness = typeof softnessValue === "number" ? softnessValue : EDGE_FADE_DEFAULT_SOFTNESS
    const inset = radius + softness
    this.edgeFadeRamp = inset
    const insetFractionX = this._windowSize.x > 0 ? Math.min(inset / this._windowSize.x, 0.5) : 0.5
    const insetFractionY = this._windowSize.y > 0 ? Math.min(inset / this._windowSize.y, 0.5) : 0.5

    // One strip per side that can ever fade (scrollable axis); sides on
    // non-scroll axes emit no geometry at all. Top/bottom strips span the full
    // width (covering the corners); left/right strips fill the remainder. A
    // window with neither axis set keeps all four strips for visual parity.
    const vertical = this._vertical || !this._horizontal
    const horizontal = this._horizontal || !this._vertical
    const strips: number[][] = []
    if (vertical) {
      strips.push([-0.5, 0.5 - insetFractionY, 0.5, 0.5], [-0.5, -0.5, 0.5, -0.5 + insetFractionY])
    }
    if (horizontal) {
      const yMin = vertical ? -0.5 + insetFractionY : -0.5
      const yMax = vertical ? 0.5 - insetFractionY : 0.5
      strips.push([-0.5, yMin, -0.5 + insetFractionX, yMax], [0.5 - insetFractionX, yMin, 0.5, yMax])
    }

    const vertices: number[] = []
    const indices: number[] = []
    for (let i = 0; i < strips.length; i++) {
      const [x0, y0, x1, y1] = strips[i]
      const base = i * 4
      vertices.push(
        x0,
        y0,
        0,
        x0 + 0.5,
        y0 + 0.5,
        x1,
        y0,
        0,
        x1 + 0.5,
        y0 + 0.5,
        x1,
        y1,
        0,
        x1 + 0.5,
        y1 + 0.5,
        x0,
        y1,
        0,
        x0 + 0.5,
        y1 + 0.5
      )
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    if (builder.getIndicesCount() > 0) {
      builder.eraseIndices(0, builder.getIndicesCount())
    }
    if (builder.getVerticesCount() > 0) {
      builder.eraseVertices(0, builder.getVerticesCount())
    }
    builder.appendVerticesInterleaved(vertices)
    builder.appendIndices(indices)
    if (builder.isValid()) {
      builder.updateMesh()
    }

    this.updateEdgeFadeStrength(true)
  }

  /**
   * Re-resolves the edge fade's render order against the Canvas that currently
   * governs this window. The order is computed live from findGoverningCanvas but
   * was only re-applied from the renderOrder setter and refreshEdgeFade, so a
   * window reparented into (or out of) a Hierarchy Canvas kept the previous
   * answer until its size, radius or axis next changed. Same protocol as every
   * other canvas-aware component: the CanvasController walker calls this on any
   * subtree a host reparents (Dropdown items, addObject content), and the
   * OnEnable handler calls it so an enable cycle after a raw reparent heals too.
   */
  public invalidateCanvasBinding(): void {
    this.applyEdgeFadeRenderOrder()
  }

  // The fade no longer climbs above every content visual (the old
  // max(content) + 1 made it un-drawable-over by ANY unrelated UI, since
  // renderOrder outranks depth). Instead:
  //
  //   - Under a Hierarchy Canvas: the window's own order. Content offsets are
  //     suppressed there too (see Visual.contentRenderOrderOffset), so the
  //     whole window is one bucket and hierarchy order draws the fade last.
  //   - Otherwise: window order + EDGE_FADE_CONTENT_ORDER_HEADROOM, so the fade
  //     clears companion content that raised itself contentRenderOrderOffset
  //     above its host. Depth-testing keeps it occludable by outside UI.
  //
  // An explicit non-zero _renderOrder input is exact — no headroom — for
  // callers that need the fade in a specific band.
  private applyEdgeFadeRenderOrder(): void {
    if (!this.rmv) {
      return
    }
    if (this._renderOrder !== 0) {
      this.rmv.renderOrder = this._renderOrder
      return
    }
    this.rmv.renderOrder = findGoverningCanvas(this.sceneObject) ? 0 : EDGE_FADE_CONTENT_ORDER_HEADROOM
  }

  // fadeStrength = (top, bottom, left, right). A side's fade dissolves as the
  // scroller approaches that end (ramp = one fade-band height) and is 0 on
  // non-scroll axes; -1 scroll dimensions (unbounded) never dissolve. The
  // scroll frame is TOP-LEFT anchored: topEdge/leftEdge = 0 mean the top/left
  // end of content is in view; bottomEdge = D−W, rightEdge = −(D−W). A
  // non-scrollable bounded axis inverts its edges, which clamps both of that
  // axis's strengths to 0 (no fade — nothing to scroll).
  private updateEdgeFadeStrength(force: boolean = false): void {
    if (!this.fadeMeshBuilder) {
      return
    }
    const ramp = Math.max(this.edgeFadeRamp, EDGE_FADE_RAMP_MIN)
    let top = 0
    let bottom = 0
    let left = 0
    let right = 0
    // Mirror refreshEdgeFade's strip fallback: a window with neither axis set
    // keeps a static fade on all sides (parity with the pre-strip full quad).
    const vertical = this._vertical || !this._horizontal
    const horizontal = this._horizontal || !this._vertical
    if (vertical) {
      if (!this._vertical || this._scrollDimensions.y === -1) {
        top = bottom = 1
      } else {
        const y = this._scrollPosition.y
        top = MathUtils.clamp((y - this.topEdge) / ramp, 0, 1)
        bottom = MathUtils.clamp((this.bottomEdge - y) / ramp, 0, 1)
      }
    }
    if (horizontal) {
      if (!this._horizontal || this._scrollDimensions.x === -1) {
        left = right = 1
      } else {
        // x = leftEdge (0) means the LEFT end of content is in view;
        // x = rightEdge (negative) the right end.
        const x = this._scrollPosition.x
        left = MathUtils.clamp((this.leftEdge - x) / ramp, 0, 1)
        right = MathUtils.clamp((x - this.rightEdge) / ramp, 0, 1)
      }
    }
    const last = this.lastEdgeFadeStrength
    if (
      !force &&
      Math.abs(last.x - top) < EDGE_FADE_STRENGTH_EPSILON &&
      Math.abs(last.y - bottom) < EDGE_FADE_STRENGTH_EPSILON &&
      Math.abs(last.z - left) < EDGE_FADE_STRENGTH_EPSILON &&
      Math.abs(last.w - right) < EDGE_FADE_STRENGTH_EPSILON
    ) {
      return
    }
    last.x = top
    last.y = bottom
    last.z = left
    last.w = right
    this.material.mainPass.fadeStrength = last
  }

  /**
   * Applies the scrollable-area size and invalidates the child-collider cache.
   * The scroll frame is top-left anchored (the page origin sits at 0), so a
   * resize never shifts content under the finger and needs no anchor
   * compensation — the only cleanup is re-clamping a committed snap latch
   * stranded outside the new page range by a shrink.
   * @param size - The new scrollable-area size (-1 per axis = unbounded).
   */
  private setScrollDimensions(size: vec2): void {
    this._scrollDimensions = size
    if (!this._initialized) return
    const colliders = this.state.colliders
    // Content size changed; invalidate child-collider cache.
    if (!colliders.skipColliderManagement) {
      colliders.childCollidersCache = null
      colliders.lastChildCollidersEnabled = null
    }
    this.events.scrollDimensionsUpdated.invoke(this._scrollDimensions)
    // Content changed — refresh the fade's end-of-scroll strengths (edges
    // moved). No render-order work here any more: the fade takes the window's
    // own order, so there is nothing to re-derive when content changes. That
    // also retires a deferred subtree walk which had to be pushed to LateUpdate
    // because VirtualizedLayout calls this from its slot-bind path mid-scroll.
    if (this._edgeFade) {
      this.updateEdgeFadeStrength()
    }
    this.reclampSnapAxisAfterResize("x")
    this.reclampSnapAxisAfterResize("y")
    // The edges moved — an in-flight landing would ease onto a stale target.
    this.clearEdgeLanding()
    // A shrink can strand the position past the new bounds. Elastic edges
    // recover via the out-of-bounds spring; clamped-family edges have no
    // recovery path (and would reject the very writes that could fix it), so
    // clamp back immediately.
    if (this.edgeClamped) {
      const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(this.scrollerTransform.getLocalPosition())
      if (boundsCheck.isOutOfBounds) {
        this.updateScrollerPosition(boundsCheck.clamped, false)
      }
    }
    // Elastic + every axis gesture-disabled: the recovery spring never runs.
    this.clampBackIfUnrecoverable()
    this.syncScrollEndState()
  }

  private reclampSnapAxisAfterResize(axis: "x" | "y"): void {
    const engine = this.state.engine
    const snap = this.state.snap
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!

    if (this.effectiveSnapMode === "none") {
      // Resize still owns stale-latch cleanup, but snap-index events are only
      // meaningful while snapping is active (paging/detent).
      this.clearSnapTarget(axis)
      return
    }

    const pitch = this._snapRegion[axis]
    const dims = this._scrollDimensions[axis]
    if (pitch <= 0) return

    // Page indices change frame across bounded/unbounded transitions. Preserve
    // the original Detent position anchor and re-derive its index on the new
    // grid so a resize cannot leave the projection pair half-rebased.
    snapPolicy.setStartAnchor(
      this.getPageIndexFromPosition(axis, snapPolicy.startingPosition),
      snapPolicy.startingPosition
    )

    const direction = axis === "x" ? -1 : 1

    if (dims === -1) {
      if (snapPolicy.hasCommittedTarget) {
        // Bounded->unbounded switches from a clamped bounded page frame to the
        // raw V1 frame, so re-derive the committed index twin from position.
        const committedIndex = axis === "x" ? snap.committedSnapIndexX! : snap.committedSnapIndexY!
        const committedPosition = snapPolicy.committedTargetPosition!
        const targetIndex = pageIndexFromPosition(committedPosition, null, direction, pitch)
        const targetPosition = pagePositionForIndex(targetIndex, null, direction, pitch)
        if (targetIndex !== committedIndex || targetPosition !== committedPosition) {
          this.commitSnapTarget(axis, targetIndex, targetPosition)
        }
        return
      }

      const axisPosition = this.scrollerTransform.getLocalPosition()[axis]
      this.announceSnapIndexForAxis(axis, this.getRestingPageIndex(axis, axisPosition))
      return
    }

    if (!isAxisScrollable(dims, this._windowSize[axis], engine.epsilon)) {
      // Axis no longer scrollable: only page 0 exists. Drop any committed target
      // (so the view can settle at 0) and pull the announced index back to 0.
      this.clearSnapTarget(axis)
      this.announceSnapIndexForAxis(axis, 0)
      return
    }

    const startEdge = axis === "x" ? this.leftEdge : this.topEdge
    const endEdge = axis === "x" ? this.rightEdge : this.bottomEdge
    const maxIndex = maxValidPageIndex(startEdge, endEdge, pitch)

    if (snapPolicy.hasCommittedTarget) {
      // Re-derive the twin from the latch POSITION, never by clamping the
      // stored index: positions are frame-independent, index twins are not.
      // A latch minted while the axis was UNBOUNDED lives in the raw-anchored
      // frame (x: rightward pages are NEGATIVE indices), so after an
      // unbounded→bounded dims change, clamping the old twin would yank the
      // view to page 0 (negative twin) or keep targeting a position outside
      // the new bounds forever (positive twin — the spring never settles and
      // the scroll-end event is withheld). For an axis that was already
      // bounded this recomputes bit-identical values (startEdge never moves
      // in the top-left frame), so a plain shrink re-commits exactly the
      // clamped page as before. The re-commit re-fires the snap-index event.
      const committedIndex = axis === "x" ? snap.committedSnapIndexX! : snap.committedSnapIndexY!
      const committedPosition = snapPolicy.committedTargetPosition!
      const targetIndex = MathUtils.clamp(
        pageIndexFromPosition(committedPosition, startEdge, direction, pitch),
        0,
        maxIndex
      )
      const targetPosition = pagePositionForIndex(targetIndex, startEdge, direction, pitch)
      if (targetIndex !== committedIndex || targetPosition !== committedPosition) {
        this.commitSnapTarget(axis, targetIndex, targetPosition)
      }
      return
    }

    // Settled (no committed target): re-derive the announced index from the
    // CURRENT position in the (possibly new) frame — the stored index may
    // have been minted in a foreign frame (see above), so clamping it as-is
    // would announce the wrong page. getRestingPageIndex clamps into the new
    // valid range; the announce dedupes to silence when nothing changed.
    const axisPosition = this.scrollerTransform.getLocalPosition()[axis]
    this.announceSnapIndexForAxis(axis, this.getRestingPageIndex(axis, axisPosition))
  }

  /** Boolean bridge for the physics paths; true when edges hard-stop instead of bouncing. */
  private get edgeClamped(): boolean {
    return this._edgeMode !== "elastic"
  }

  /**
   * The snap mode in effect: the authored mode while `scrollSnapping` is on,
   * else "none". Every runtime snap branch reads this, so the toggle and the
   * mode input can never disagree.
   */
  private get effectiveSnapMode(): SnapMode {
    return this._scrollSnapping ? this._snapMode : "none"
  }

  /** 0 on the max-snap-steps input means unlimited (Infinity to the projection clamp). */
  private get resolvedMaxSnapSteps(): number {
    return this._maxSnapStepsPerFling > 0 ? this._maxSnapStepsPerFling : Number.POSITIVE_INFINITY
  }

  /**
   * Converts a normalized x position (0 = left, 1 = right) to a raw scroller
   * position. Unbounded axes pass through raw; non-scrollable axes pin to 0
   * (with inverted edges a naive conversion would produce a garbage target).
   */
  private positionFromNormalizedX(normalized: number): number {
    const engine = this.state.engine
    if (this._scrollDimensions.x === -1) return normalized
    if (!isAxisScrollable(this._scrollDimensions.x, this._windowSize.x, engine.epsilon)) return 0
    return positionFromNormalized(normalized, this.leftEdge, this.rightEdge, engine.epsilon)
  }

  /**
   * Converts a normalized y position (0 = top, 1 = bottom) to a raw scroller
   * position. Unbounded axes pass through raw; non-scrollable axes pin to 0.
   */
  private positionFromNormalizedY(normalized: number): number {
    const engine = this.state.engine
    if (this._scrollDimensions.y === -1) return normalized
    if (!isAxisScrollable(this._scrollDimensions.y, this._windowSize.y, engine.epsilon)) return 0
    return positionFromNormalized(normalized, this.topEdge, this.bottomEdge, engine.epsilon)
  }

  /**
   * Locked axes accept programmatic writes but never overscroll — the
   * out-of-bounds recovery spring respects axis locks, so overscroll on a
   * locked axis would be permanent. Mutates and returns `position`.
   */
  private clampLockedAxes(position: vec3): vec3 {
    if (!this._horizontal && this._scrollDimensions.x !== -1) {
      position.x =
        this._scrollDimensions.x > this._windowSize.x ? MathUtils.clamp(position.x, this.rightEdge, this.leftEdge) : 0
    }
    if (!this._vertical && this._scrollDimensions.y !== -1) {
      position.y =
        this._scrollDimensions.y > this._windowSize.y ? MathUtils.clamp(position.y, this.topEdge, this.bottomEdge) : 0
    }
    return position
  }

  /**
   * Latches one axis's snap target: commits the position on the policy, records
   * the page-index twin (invariant: twin non-null ⇔ policy latched), and
   * announces the new snap index. Returns the committed position.
   */
  private commitSnapTarget(axis: "x" | "y", pageIndex: number, position: number): number {
    const engine = this.state.engine
    const snap = this.state.snap
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    const targetPosition = snapPolicy.commitTarget(position)
    if (axis === "x") {
      snap.committedSnapIndexX = pageIndex
    } else {
      snap.committedSnapIndexY = pageIndex
    }
    this.announceSnapIndices()
    return targetPosition
  }

  /**
   * Clears one axis's committed snap target, its page-index twin, and stops its
   * settle spring. Residual spring velocity would otherwise keep hasMotion true
   * and block settle detection after a mode/grid change. No-op when nothing is
   * latched.
   */
  private clearSnapTarget(axis: "x" | "y"): void {
    const engine = this.state.engine
    const snap = this.state.snap
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    if (!snapPolicy.hasCommittedTarget) return
    snapPolicy.clearTarget()
    if (axis === "x") {
      snap.committedSnapIndexX = null
    } else {
      snap.committedSnapIndexY = null
    }
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    axisScroller.springVelocity = 0
  }

  /**
   * Dedupes and fires the snap-index-changed event from the current committed /
   * announced indices. Commit-time semantics: settling adds no information, so
   * the settled index equals the committed one by construction.
   */
  private announceSnapIndices(): void {
    const snap = this.state.snap
    this.announceSnapIndexValues(
      snap.committedSnapIndexX ?? snap.snapIndexX,
      snap.committedSnapIndexY ?? snap.snapIndexY
    )
  }

  /** Updates the announced indices immediately, then dispatches now or queues until it is safe. */
  private announceSnapIndexValues(nextX: number, nextY: number): void {
    const snap = this.state.snap
    const didChange = nextX !== snap.snapIndexX || nextY !== snap.snapIndexY
    if (!didChange && !snap.announceOwed) return
    if (didChange) {
      snap.snapIndexX = nextX
      snap.snapIndexY = nextY
      snap.announceOwed = true
    }
    this.flushSnapIndexAnnounce()
  }

  /**
   * Drains the latest physics-deferred or reentrant snap-index change. Every
   * listener in one pass sees the original payload. Reentrant changes drain
   * synchronously up to the bounded redrain budget; excess feedback is cut off
   * while snapIndex retains the latest listener-written state.
   */
  private flushSnapIndexAnnounce(): void {
    const snap = this.state.snap
    if (!snap.announceOwed || snap.deferAnnounces || snap.isDispatchingAnnounce) return

    let remainingDispatches = 1 + MAX_SNAP_INDEX_ANNOUNCE_REDRAINS
    snap.isDispatchingAnnounce = true
    try {
      while (snap.announceOwed && !snap.deferAnnounces && remainingDispatches > 0) {
        remainingDispatches--
        snap.announceOwed = false
        const dispatchedX = snap.snapIndexX
        const dispatchedY = snap.snapIndexY
        snap.snapIndexScratch.x = dispatchedX
        snap.snapIndexScratch.y = dispatchedY
        try {
          this.events.snapIndexChanged.invoke(snap.snapIndexScratch)
        } finally {
          // A listener may write B and then return to the in-flight value A.
          // The intermediate write marks an announce as owed, but there is no
          // new final state to announce.
          if (snap.snapIndexX === dispatchedX && snap.snapIndexY === dispatchedY) {
            snap.announceOwed = false
          }
        }
      }

      if (snap.announceOwed && !snap.deferAnnounces) {
        snap.announceOwed = false
        log.e(
          "flushSnapIndexAnnounce: redrain budget exhausted; suppressing further synchronous onSnapIndexChanged feedback"
        )
      }
    } finally {
      snap.isDispatchingAnnounce = false
    }
  }

  /** Re-announces one axis's snap index, leaving the other axis's current index untouched. */
  private announceSnapIndexForAxis(axis: "x" | "y", index: number): void {
    const snap = this.state.snap
    this.announceSnapIndexValues(
      axis === "x" ? index : (snap.committedSnapIndexX ?? snap.snapIndexX),
      axis === "y" ? index : (snap.committedSnapIndexY ?? snap.snapIndexY)
    )
  }

  /**
   * Rest-position correction for the announced snap indices: announces the
   * valid page nearest `position` on each snappable axis. Motion that ends
   * WITHOUT a snap commit — an interrupted snap (tween, programmatic write,
   * mode change), a tween destination, or a direct position write — would
   * otherwise leave the last committed page announced forever: paging has no
   * idle re-snap to self-correct the way detent does. Dedupe makes this
   * silent whenever nothing changed (a normal snap settle rests exactly on
   * the committed page). No-op while snapping is not in effect.
   */
  private announceRestingSnapIndices(position: vec3): void {
    if (this.effectiveSnapMode === "none") return
    const snap = this.state.snap
    this.announceSnapIndexValues(
      snap.committedSnapIndexX ?? this.getRestingPageIndex("x", position.x),
      snap.committedSnapIndexY ?? this.getRestingPageIndex("y", position.y)
    )
  }

  /**
   * Valid page index nearest a rest position: clamped into the bounded page
   * range (mirroring reclampSnapAxisAfterResize — non-scrollable axes read as
   * page 0); pitch-less axes keep their current announced index (a nearest
   * page does not exist).
   */
  private getRestingPageIndex(axis: "x" | "y", position: number): number {
    const snap = this.state.snap
    const pitch = this._snapRegion[axis]
    if (pitch <= 0) return axis === "x" ? snap.snapIndexX : snap.snapIndexY
    const dims = this._scrollDimensions[axis]
    if (dims === -1) return this.getPageIndexFromPosition(axis, position)
    if (!isAxisScrollable(dims, this._windowSize[axis], this.state.engine.epsilon)) return 0
    const startEdge = axis === "x" ? this.leftEdge : this.topEdge
    const endEdge = axis === "x" ? this.rightEdge : this.bottomEdge
    return MathUtils.clamp(
      this.getPageIndexFromPosition(axis, position),
      0,
      maxValidPageIndex(startEdge, endEdge, pitch)
    )
  }

  /**
   * Detent idle gate: true when every snappable axis rests on a detent (or when
   * the snap mode is not "detent"). Uses the EXACT threshold pair the settle
   * path uses, so a settle can never immediately re-kick the snap.
   */
  private isRestingOnDetents(position: vec3): boolean {
    if (this.effectiveSnapMode !== "detent") return true
    return this.isAxisRestingOnDetent("x", position.x) && this.isAxisRestingOnDetent("y", position.y)
  }

  /** Per-axis detent rest check; unsnappable axes are vacuously resting. */
  private isAxisRestingOnDetent(axis: "x" | "y", position: number): boolean {
    const pitch = this._snapRegion[axis]
    const axisEnabled = axis === "x" ? this._horizontal : this._vertical
    if (!axisEnabled || pitch <= 0) return true
    const dims = this._scrollDimensions[axis]
    if (dims !== -1 && dims <= this._windowSize[axis]) return true
    const engine = this.state.engine
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    if (snapPolicy.hasCommittedTarget || axisScroller.hasPendingFlingVelocity) return false

    const hasBounds = dims !== -1
    const direction = axis === "x" ? -1 : 1
    const startEdge = hasBounds ? (axis === "x" ? this.leftEdge : this.topEdge) : null
    let pageIndex = this.getPageIndexFromPosition(axis, position)
    if (hasBounds) {
      const endEdge = axis === "x" ? this.rightEdge : this.bottomEdge
      pageIndex = MathUtils.clamp(pageIndex, 0, maxValidPageIndex(startEdge!, endEdge, pitch))
    }
    const target = pagePositionForIndex(pageIndex, startEdge, direction, pitch)
    return axisScroller.isSpringSettled(position, target, engine.epsilon, engine.minimumScrollingVelocity * 0.05)
  }

  /** Clears one axis's snap latch and re-seeds its page/position anchor on the current grid. */
  private reseedSnapAxis(axis: "x" | "y", currentPosition: number): void {
    this.clearSnapTarget(axis)
    const engine = this.state.engine
    const snapPolicy = axis === "x" ? engine.horizontalSnapPolicy! : engine.verticalSnapPolicy!
    snapPolicy.setStartAnchor(this.getPageIndexFromPosition(axis, currentPosition), currentPosition)
  }

  /**
   * Kills all in-flight motion state on a just-disabled axis: pending/coasting
   * fling, committed snap target, edge landing, and spring velocity. update()'s
   * friction/snap arms only run for ENABLED axes, so motion left latched on a
   * disabled axis could never be consumed — hasMotion would hold true forever,
   * withholding onScrollEnd until the next gesture, and the un-decayed fling
   * would replay at full strength if the axis were later re-enabled.
   */
  private quiesceDisabledAxis(axis: "x" | "y"): void {
    const engine = this.state.engine
    const axisScroller = axis === "x" ? engine.horizontalScroller! : engine.verticalScroller!
    this.clearSnapTarget(axis)
    this.state.edgeLanding[axis] = null
    if (axis === "x") {
      this.state.snap.programmaticKickX = false
    } else {
      this.state.snap.programmaticKickY = false
    }
    axisScroller.cancelMotion()
    // Disabling mid-overscroll can leave the axis where no recovery reaches it.
    this.clampBackIfUnrecoverable()
    // The disable may be the last thing holding settle false — fire the end
    // event now rather than one frame late (mirrors the scrollingPaused setter).
    this.syncScrollEndState()
  }

  /**
   * Immediate clamp-back for out-of-bounds positions the elastic recovery
   * spring can never fix: that spring runs from update()'s physics block,
   * which is gated on at least one gesture-enabled axis. With every axis
   * disabled, a position left past the bounds — by a resize, or by disabling
   * an axis mid-overscroll — would rest overscrolled forever, and
   * isScrollSettledForEndEvent would withhold onScrollEnd component-wide.
   * No-op in clamped-family modes (their mutation paths clamp on their own)
   * or while any axis remains enabled (the spring recovers those, animated).
   */
  private clampBackIfUnrecoverable(): void {
    if (this.edgeClamped || this._horizontal || this._vertical) return
    const boundsCheck = this.getClampedBoundsAndCheckOutOfBounds(this.scrollerTransform.getLocalPosition())
    if (boundsCheck.isOutOfBounds) {
      this.updateScrollerPosition(boundsCheck.clamped, false)
    }
  }

  /** Attaches or detaches the Interactable event handlers (idempotent per direction). */
  private subscribeToEvents(subscribe: boolean): void {
    const colliders = this.state.colliders
    if (colliders.isSubscribedToEvents === subscribe) return
    colliders.isSubscribedToEvents = subscribe
    if (subscribe) {
      // Physical path uses the LateUpdate tick + state machine; onDragUpdate is a no-op.
      // Indirect path is driven by onDragUpdate (inheriting IK's indirectDragThreshold).
      colliders.eventUnsubscribes = [
        this._interactable.onHoverEnter.add((event) => this.onInteractableHoverEnter(event)),
        this._interactable.onHoverUpdate.add((event) => this.onInteractableHoverUpdate(event)),
        this._interactable.onHoverExit.add(() => this.onInteractableHoverExit()),
        this._interactable.onInteractorTriggerStart.add((event) => this.onInteractableTriggerStart(event)),
        this._interactable.onTriggerCanceled.add((event) => this.onInteractableTriggerCanceled(event)),
        this._interactable.onTriggerEnd.add((event) => this.onInteractableTriggerEnd(event)),
        this._interactable.onTriggerEndOutside.add((event) => this.onInteractableTriggerEndOutside(event)),
        this._interactable.onDragUpdate.add((event) => this.onInteractableDragUpdate(event)),
        this._interactable.onDragEnd.add((event) => this.onInteractableDragEnd(event))
      ]
    } else {
      colliders.eventUnsubscribes.forEach((unsubscribe) => unsubscribe())
      colliders.eventUnsubscribes = []
    }
  }
}
