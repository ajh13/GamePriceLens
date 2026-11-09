import {Billboard} from "InteractionKit.lspkg/Components/Interaction/Billboard/Billboard"
import {Interactable, TargetingVisual} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractableManipulation} from "InteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import {InteractionPlane} from "InteractionKit.lspkg/Components/Interaction/InteractionPlane/InteractionPlane"
import {
  CursorMode,
  type InteractorCursor
} from "InteractionKit.lspkg/Components/Interaction/InteractorCursor/InteractorCursor"
import {FieldTargetingMode, HandInteractor} from "InteractionKit.lspkg/Core/HandInteractor/HandInteractor"
import {Interactor, InteractorInputType, TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import type {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {CursorControllerProvider} from "InteractionKit.lspkg/Providers/CursorControllerProvider/CursorControllerProvider"
import {easingFunctions} from "InteractionKit.lspkg/Utils/animate"
import Event, {type PublicApi, type unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import * as MotionChannels from "Motion.lspkg/Channels"
import {OpacityWriter} from "Motion.lspkg/Channels"
import {back} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {Timeline} from "Motion.lspkg/Timeline"
import {DropShadow} from "../../DropShadow"
import {getActiveMotionProfile} from "../../Motion/MotionTokens"
import {Intents} from "../../Motion/SpecIntents"
import {normalizeThemeName, SYSTEM_2_NAME, SYSTEM_2_VALUE, SYSTEM_3_NAME, SYSTEM_3_VALUE} from "../../Themes/Theme"
import {ThemeService} from "../../Themes/ThemeService"
import {VisibilityGroup} from "../../Utility/VisibilityGroup"
// Side-effect import — register UIKit Layout2D handlers. Frame doesn't
// extend Element, so it needs its own bootstrap reference.
import "../../UIKitBootstrap"
import {CanvasController} from "../../Utility/CanvasController"
import {RoundedRectangle} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {Button} from "../Button/Button"
import {ElementContent} from "../Content/ElementContent"
import type {Layoutable} from "../Layout2D/Layoutable"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {FrameConstants, type FrameConstantsType} from "./FrameConstants"
import {FramePanelVisual} from "./FramePanelVisual"
import {FrameRoundedRectVisual} from "./FrameRoundedRectVisual"
import {FrameVisual} from "./FrameVisual"
import ButtonHandler from "./modules/ButtonHandler"
import DepthBehavior from "./modules/DepthBehavior"
import DepthScaling from "./modules/DepthScaling"
import {
  computeInputModeFromPosition as computeInputModeFromPositionPure,
  dualGrabShouldTranslate,
  InputMode,
  isPositionInterior,
  isPositionInZone,
  mapInputModeToCursor as mapInputModeToCursorPure,
  selectCursorMode,
  type CursorMappingConfig,
  type FrameClassificationConfig
} from "./modules/FrameInputClassification"
import {
  shouldSettleDepthOnPoseTakeover,
  idleState as triggerIdleState,
  onTriggerEnd as triggerStateOnEnd,
  onTriggerStart as triggerStateOnStart,
  type TriggerState
} from "./modules/FrameTriggerStateMachine"
import HoverBehavior from "./modules/HoverBehavior"
import RightDrawer from "./modules/RightDrawer"
import SmoothFollow from "./modules/SmoothFollow"
import SnappingHandler from "./modules/SnappingHandler"
import TagAlong from "./modules/TagAlong"

const TAG = "Frame"
const log = new NativeLogger(TAG)

const FRAME_FOLLOW_ICON: Texture = requireAsset("Icons.lspkg/Iconography/System/follow.png") as Texture

// Consecutive frames an interactor must be off the frame's hover hierarchy
// before the per-frame reconciliation in updateCursorMode() reaps its cursor
// entry. ~100ms at 60fps — deliberately 2x HoverBehavior's 50ms debounce
// (which is ~3 frames) for headroom, so brief tracking flickers don't strobe
// the cursor to Auto.
const CURSOR_RECONCILE_OFF_FRAMES = 6

export type InputState = {
  hovered: boolean
  hierarchyHovered: boolean
  pinching: boolean
  position: vec3
  innerInteractableActive: boolean
}

export enum FrameAppearance {
  "Large" = "Large",
  "Small" = "Small"
}

type HitPosition = {
  localPosition: vec2
  normalizedPosition: vec2
}

/** Lazy event container — see the `_events` field. */
type FrameEvents = {
  snappingComplete: Event<void> | null
  followUpdate: Event<void> | null
  followingChange: Event<boolean> | null
  scalingUpdate: Event<void> | null
  scalingStart: Event<void> | null
  scalingEnd: Event<void> | null
  translationStart: Event<void> | null
  translationEnd: Event<void> | null
  hoverEnterInnerInteractable: Event<void> | null
  hoverExitInnerInteractable: Event<void> | null
  initialized: ReplayEvent<void> | null
  showVisual: Event<void> | null
  hideVisual: Event<void> | null
  sizeChanged: Event<vec3> | null
}

/** Derived per-interaction transition state — see the `_interactionState` field. */
type FrameInteractionState = {
  inputMode: InputMode
  scaling: boolean
  translating: boolean
  translatingLastFrame: boolean
  billboardStateApplied: boolean
  isInZone: boolean
  isInZoneLast: boolean
  pinchingLastFrame: boolean
  hoveringInnerInteractableLast: boolean
  hoveringContentLast: boolean
  wasInFarNearTransition: boolean
  forceTranslate: boolean
  allowScalingTopLeft: boolean
  allowScalingTopRight: boolean
  dragStart: vec3
  scalingSizeStart: vec2
  cursorMode: CursorMode
  trigger: TriggerState
  input: InputState
}

/** Follow / tag-along handles — see the `_follow` field. */
type FrameFollow = {
  button: Button | null
  smooth: SmoothFollow | null
  tagAlong: TagAlong | null
  cleanup: (() => void) | null
  // When true, the active follow behavior is temporarily paused without
  // changing the user-visible follow mode. Used by the focus frame to hold the
  // frame still while a field inside it is docked to the keyboard. See
  // suspendFollow()/resumeFollow().
  suspended: boolean
  // Outstanding suspend holders by key ("focusFrame", "spawn") — follow
  // resumes only when the last one lets go, and a repeat suspend from the
  // same holder is a no-op (the focus-frame contract requires idempotency).
  suspendOwners: string[]
}

/**
 * Component handles + infra refs — see the `_refs` field. The non-null fields
 * are assigned during onAwake/OnStart; they are typed non-null to preserve the
 * pre-grouping fields' non-null call sites (the `_refs` literal seeds them `null!`).
 */
type FrameRefs = {
  transform: Transform
  contentTransform: Transform
  content: SceneObject
  frameObject: SceneObject
  // Chrome subtree: hosts the frame's own body layers (shadow, drawer, body)
  // under a Canvas with Hierarchy sorting so their draw order is structural.
  // Content stays OUTSIDE the canvas so arbitrary 3D content keeps its normal
  // depth behavior.
  chrome: SceneObject
  drawerHost: SceneObject
  shadowHost: SceneObject
  shadow: DropShadow | null
  canvasController: CanvasController | null
  collider: ColliderComponent
  colliderShape: BoxShape
  interactable: Interactable
  manipulate: InteractableManipulation
  billboardComponent: Billboard
  buttonHandler: ButtonHandler
  rightDrawer: RightDrawer
  frameVisual: FrameVisual
  snappingHandler: SnappingHandler
  hoverBehavior: HoverBehavior
  interactionPlane: InteractionPlane
  interactionPlaneTransform: Transform | null
  managedSceneObjects: SceneObject[]
  managedComponents: Component[]
  axisBufferDegrees: vec3
  axisEasing: vec3
  cachedFrameParams: FrameConstantsType | null
  unsubscribes: unsubscribe[]
}

/** Layout / sizing state — see the `_layout` field. */
type FrameLayout = {
  margin: number
  ogMargin: number
  customCornerRadius: number | null
  originalInnerSize: vec2
  grabZones: vec4[]
  grabZoneOnly: boolean
  squeezeAmount: number
  totalSize: vec2
  interactablePadding: vec2
}

/** Visual / animation state — see the `_visual` field. */
type FrameVisualState = {
  opacity: number
  isVisible: boolean
  // Tracks the last value passed to frameVisual.setEnabled (the body RMV's
  // enabled state) so the shadow can mirror it — the visuals expose no getter.
  bodyEnabled: boolean
  hoverIntensity: number
}

/** Per-frame loop gating + lifecycle — see the `_loop` field. */
type FrameLoop = {
  deferLayout: boolean
  // Latched at the top of onStart, before any initialize* call. `initialized`
  // only flips at the end of that body, so the window between the two is where
  // init-only configuration (themeOverride) is already too late to apply.
  initializationStarted: boolean
  initialized: boolean
  updateEvent: SceneEvent | null
  lateUpdateEvent: SceneEvent | null
}

/** Optional depth clamping / distance scaling runtime state — see the `_depth` field. */
type FrameDepth = {
  behavior: DepthBehavior | null
  scaling: DepthScaling | null
  scalingSuspended: boolean
  // One-shot, armed on every enable edge (onStart + OnEnable), consumed by the
  // first lateUpdate tick after it. The immediate on-enable refresh sees the
  // pre-reposition pose when the app enables first and repositions second
  // within the same frame, so a re-summoned panel would keep the stale
  // distance's scale until its next grab. Not re-armed on a guarded drop: a
  // grab refreshes at release, suspension refreshes at resume, and a released
  // correction deliberately never origin-refreshes at settle.
  pendingEnableRefresh: boolean
}

/** Hit-test scratch — see the `_hit` field. */
type FrameHit = {
  invWorld: mat4 | null
  stamp: number
  result: HitPosition
}

/** Reused scratch for the pure FrameInputClassification helpers — see the `_scratch` field. */
type FrameScratch = {
  classification: FrameClassificationConfig
  cursorArgs: {
    interactor: Interactor
    manipulator: Interactor | null
    secondaryManipulator: Interactor | null
    manipulatorCursorMode: CursorMode
    position: vec3 | undefined
    innerInteractableActive: boolean
    classificationConfig: FrameClassificationConfig
    cursorMappingConfig: CursorMappingConfig
  }
}

const DEBUG_DRAW = false
const marginDebugColor = new vec4(0, 1, 1, 1)
const debugRed = new vec4(1, 0, 0, 1)

// Shared, never-mutated zero for the billboard axis-buffer on the translating
// branch (see updateBillboardState). Billboard stores by value (with an
// `.equal()` early-out), so one shared instance is safe to reuse.
const AXIS_BUFFER_ZERO = new vec3(0, 0, 0)

// Billboard easing (fraction of remaining angle eliminated per 33ms, exponential
// decay). Without this the Billboard defaults to instant (1,1,1), so re-grabbing
// a frame after walking around snaps the accumulated angular error in a single
// frame — and swings the body around the grab-point pivot. 0.5 converges in
// roughly a sixth of a second on grab while keeping drag tracking tight.
const BILLBOARD_AXIS_EASING = new vec3(0.5, 0.5, 1)

// Constants for the frame glow in near field interaction
const MINIMUM_CURSOR_RADIUS_FACTOR = 0.3
const LERP_CURSOR_RADIUS_FACTOR = 1 - MINIMUM_CURSOR_RADIUS_FACTOR

/**
 * @module Frame
 *
 * @description Frame component that provides a customizable UI frame with interaction capabilities.
 * It supports features like resizing, moving, billboarding, snapping, and interaction with buttons.
 * It can also follow the user's view and has options for hover behavior and interaction plane.
 */
@component
export class Frame extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. Frame is
   * `Layoutable` but doesn't extend Element, so the brand is declared
   * directly. See `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  @input
  @label("Theme")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Inherited", "Inherited"),
      new ComboBoxItem("System 2.0", "System2"),
      new ComboBoxItem("System 3.0", "System3")
    ])
  )
  private _themeOverride: string = "Inherited"

  // Runtime-created components receive their authored @input values after
  // onAwake. Keep an explicit runtime override separate so a composing
  // component can configure the Frame before its visual is created without
  // that value being replaced by input deserialization.
  private _runtimeThemeOverride: string | null = null

  /**
   * Initialization-only theme override used when the Frame visual is created.
   * Invalid values fall back to the inherited ThemeService theme.
   */
  public get themeOverride(): string {
    return this._runtimeThemeOverride ?? this.normalizeThemeOverride(this._themeOverride)
  }

  public set themeOverride(themeOverride: string) {
    this.setThemeOverride(themeOverride)
  }

  /**
   * Applies a theme override before Frame initialization begins.
   * @returns true when the override was accepted.
   */
  public setThemeOverride(themeOverride: string): boolean {
    const normalized = this.normalizeThemeOverride(themeOverride)
    const canonical = normalizeThemeName(themeOverride)
    const invalid =
      themeOverride !== "Inherited" &&
      themeOverride !== "Default" &&
      canonical !== SYSTEM_2_NAME &&
      canonical !== SYSTEM_3_NAME

    if (invalid) {
      log.w(`Unknown Frame theme override "${String(themeOverride)}"; using Inherited.`)
    }
    if (this._loop.initializationStarted) {
      if (normalized !== this.themeOverride) {
        log.w("Frame themeOverride cannot be changed after initialization has begun; ignoring the request.")
      }
      return false
    }

    this._runtimeThemeOverride = normalized
    this._refs.cachedFrameParams = null
    return true
  }

  // Returns the serialized identifier form so stored state matches scene data;
  // any accepted spelling (identifier, canonical, or pre-rename) maps onto it.
  private normalizeThemeOverride(themeOverride: string): string {
    switch (normalizeThemeName(themeOverride)) {
      case SYSTEM_2_NAME:
        return SYSTEM_2_VALUE
      case SYSTEM_3_NAME:
        return SYSTEM_3_VALUE
      default:
        return "Inherited"
    }
  }

  private resolveTheme() {
    const mgr = ThemeService.getInstance()
    const override = this.themeOverride
    return override !== "Inherited" ? (mgr.getTheme(override) ?? mgr.currentTheme) : mgr.currentTheme
  }

  private getFrameParams(): FrameConstantsType {
    if (this._refs.cachedFrameParams) return this._refs.cachedFrameParams
    // Shallow-merge theme overrides onto defaults so themes can supply a subset
    // (e.g. only colors) without having to replicate the full FrameConstants shape.
    const themeData = this.resolveTheme().componentData?.["Frame"] as Partial<FrameConstantsType> | undefined
    this._refs.cachedFrameParams = {...FrameConstants, ...(themeData ?? {})}
    return this._refs.cachedFrameParams
  }

  /** Factory — select the visual implementation based on the effective theme. */
  private createFrameVisual(): FrameVisual {
    if (this.resolveTheme().name === SYSTEM_3_NAME) {
      this.autoShowHide = false // see `autoShowHide` JSDoc for rationale
      return new FramePanelVisual()
    }
    return new FrameRoundedRectVisual(this.getFrameParams())
  }

  /**
   * When enabled, the frame automatically appears when hovered and hides when
   * not being interacted with. Disable to manually control frame visibility.
   *
   * System3 frames force this to `false` at init — the panel body stays
   * opaque and the drawer pops on hover via the drawer slide instead of
   * the classic full-frame fade. Set `frame.autoShowHide = true` after
   * init to opt into the classic body-fade behavior on a System3 frame
   * alongside the drawer slide.
   */
  @ui.group_start("Frame Settings")
  @hint("Controls the appearance, size, and interaction behavior of the frame.")
  @input
  @showIf("_themeOverride", "System2")
  @hint(
    "When enabled, the frame automatically appears when hovered and hides when not being interacted with. Disable \
to manually control frame visibility."
  )
  public autoShowHide: boolean = true

  /**
   * Play the Horizon Reveal (System 3.0 Spatial Spawning) when the frame
   * starts: it materializes from half its height above rest — 50% scale,
   * 83° X-hinge, quick lead fade. `spawn()` / `despawn()` play it manually.
   */
  @input
  @hint("Play the Horizon Reveal spawn animation when the frame starts.")
  private _spawnOnStart: boolean = false

  @input
  @showIf("_themeOverride", "System2")
  @widget(new ComboBoxWidget([new ComboBoxItem("Large", "Large"), new ComboBoxItem("Small", "Small")]))
  @hint(
    "Preset appearance configurations for the frame. <br><br> <code>Large</code> is useful for <i>far-field</i> interactons. <br><br> While, <code>Small</code> is useful for <i>near-field</i> interactions"
  )
  // Literal (not FrameAppearance.Large) so LS's meta generator can extract the
  // default — enum expressions serialize as "" and blank the Inspector dropdown.
  private _appearance: string = "Large"
  /**
   * The appearance actually used to size the frame. System3 has a single fixed
   * size — the Large/Small preset never applies there (the combo box is hidden
   * for System3, but guard the resolution too so a stray `_appearance` or a
   * `frame.appearance =` call can't change it). System2 honors the preset,
   * defaulting to Large if the @input holds an unknown value.
   */
  private get effectiveAppearance(): FrameAppearance {
    if (this.isPanelFrame) {
      return FrameAppearance.Large
    }
    if (this._appearance === FrameAppearance.Large || this._appearance === FrameAppearance.Small) {
      return this._appearance as FrameAppearance
    }
    return FrameAppearance.Large
  }
  public get appearance(): string {
    return this.effectiveAppearance
  }
  public set appearance(appearance: FrameAppearance) {
    this._appearance = appearance
    // Resolve through effectiveAppearance so System3 always applies its single
    // fixed config regardless of the requested preset.
    const config = this.getFrameParams().appearances[this.effectiveAppearance]
    if (config) {
      this.margin = config.margin
      this._refs.frameVisual.applyAppearance(config)
      // Re-apply any custom corner radius so it survives appearance changes.
      if (this._layout.customCornerRadius !== null) {
        this._refs.frameVisual.setCornerRadius(this._layout.customCornerRadius)
      }
      // Refresh the snap ghost to track the now-current applied radius
      // (covers both the customized and the appearance-default paths).
      this._refs.snappingHandler?.setGhostCornerRadius(this.cornerRadius)
      if (this._refs.shadow) {
        this._refs.shadow.cornerRadius = this.cornerRadius
      }
      this._refs.buttonHandler.resize()
      this._refs.rightDrawer.resize()
    }
    this.scaleFrame(true)
  }

  @input("vec2", "{32,32}")
  @hint("Size of the frames's inner content area. In local space centimeters.")
  private _innerSize: vec2 = new vec2(32, 32)
  /**
   * Size of the frames's inner content area.
   */
  public get innerSize(): vec2 {
    return this._innerSize
  }
  /**
   * Sets the inner content area size. If the new size has a different aspect ratio than the current
   * scale baseline, call {@link syncScaleBaseline} afterwards so interactive scaling computes
   * correct uniform scale factors relative to the new size.
   */
  public set innerSize(size: vec2) {
    this._innerSize = size
    this.recomputeTotalSize()
    this.scaleFrame(true)
  }

  @input("vec2", "{0,0}")
  @hint(
    "Extra padding that maintains a fixed size in centimeters regardless of frame scaling, useful for toolbars and \
fixed-size UI elements. In local space centimeters."
  )
  private _padding: vec2 = new vec2(0, 0)
  /**
   * Extra padding that maintains a fixed size in centimeters regardless of frame scaling, useful for toolbars and
   * fixed-size UI elements
   */
  public get padding(): vec2 {
    return this._padding
  }
  public set padding(padding: vec2) {
    this._padding = padding
    this.recomputeTotalSize()
    this.scaleFrame(true)
  }
  /**
   * Enables interactive scaling of the frame via corner handles.
   */
  @input
  @hint("Enables interactive scaling of the frame via corner handles.")
  private _allowScaling: boolean = true
  /**
   * Allows the container to scale width and height independently.
   * When enabled, scaling is non-uniform and each axis is clamped
   * to its configured min/max size limits.
   */
  @input
  @hint("Allows independent width/height scaling, clamped to min/max sizes.")
  @showIf("_allowScaling")
  public allowNonUniformScaling: boolean = false
  /**
   * Automatically scales child content when the frame is resized to maintain proportions.
   */
  @input
  @hint("Automatically scales child content when the frame is resized to maintain proportions.")
  public autoScaleContent: boolean = true
  /**
   * When enabled, Z-axis scaling of content will match X-axis scaling during frame resizing.
   */
  @input
  @hint("When enabled, Z-axis scaling of content will match X-axis scaling during frame resizing.")
  public relativeZ: boolean = true
  /**
   * When enabled, allows interaction with content inside the frame and hides the frames's glow for visual
   * clarity.
   */
  @input
  @hint("When enabled, only the margin is interactive for controlling the frame.")
  private _onlyInteractOnMargin: boolean = false
  /**
   * Runtime-only request for a border-only body that does not touch interaction
   * gating. See the `hideBody` accessor.
   */
  private _hideBody: boolean = false
  /**
   * Enables moving the frame.
   */
  @input
  @hint("Enables moving the frame.")
  public allowTranslation: boolean = true
  /**
   * When enabled, creates a transparent center in the frame, allowing content behind the frame to be visible.
   */
  @input
  @hint("When enabled, creates a transparent center in the frame, allowing content behind the frame to be visible.")
  private _cutOutCenter: boolean = false
  public get cutOutCenter(): boolean {
    return this._cutOutCenter
  }
  public set cutOutCenter(cutOut: boolean) {
    this._cutOutCenter = cutOut
    this._refs.frameVisual.setCutOutCenter(this._cutOutCenter)
    this.refreshShadowEnabled()
  }
  /**
   * Softness of the transparent-center cutout edge, in local centimeters. Higher is softer; the shader keeps a small minimum to avoid aliasing. Only affects visuals that support a cutout (System3 panel).
   */
  @input
  @hint(
    "Softness of the transparent-center cutout edge, in local centimeters. Higher is softer; the shader keeps a small minimum to avoid aliasing."
  )
  private _cutOutFeather: number = 0.1
  public get cutOutFeather(): number {
    return this._cutOutFeather
  }
  public set cutOutFeather(feather: number) {
    this._cutOutFeather = feather
    this._refs.frameVisual.setCutOutFeather(this._cutOutFeather)
  }
  /**
   * When enabled, renders a soft drop shadow behind the frame body. Styled by
   * the theme's Frame parameters (shadowColor / shadowOffset / shadowBlur /
   * shadowSpread). Hidden automatically while `cutOutCenter` is active — a
   * solid shadow would show through the transparent center.
   */
  @input
  @hint("When enabled, renders a soft drop shadow behind the frame body.")
  private _hasShadow: boolean = false
  public get hasShadow(): boolean {
    return this._hasShadow
  }
  public set hasShadow(value: boolean) {
    if (value === undefined || value === this._hasShadow) {
      return
    }
    this._hasShadow = value
    if (isNull(this._refs.shadowHost) || !this._refs.shadowHost) {
      return // pre-init: applied when initializeVisuals builds the chrome
    }
    if (value) {
      this.buildShadow()
    }
    this.refreshShadowEnabled()
  }
  @ui.group_end
  @ui.label("")
  @ui.group_start("Min/Max Size")
  @hint("Sets the minimum and maximum dimensions that the frame can be resized to.")
  /**
   * Minimum dimensions that the frame can be resized to. In local space centimeters.
   */
  @input("vec2", "{10,10}")
  @hint("Minimum dimensions that the frame can be resized to. In local space centimeters.")
  private _minimumSize: vec2 = new vec2(10, 10)
  /**
   * Maximum dimensions that the frame can be resized to. In local space centimeters.
   */
  @input("vec2", "{150,150}")
  @hint("Maximum dimensions that the frame can be resized to. In local space centimeters.")
  private _maximumSize: vec2 = new vec2(150, 150)
  @ui.group_end
  @ui.label("")
  @ui.group_start("Billboarding")
  @hint("Controls how the frame automatically rotates to face the camera/user.")
  /**
   * Enables the frame to automatically rotate to face the camera/user.
   */
  @input
  @hint("Enables the frame to automatically rotate to face the camera/user.")
  private useBillboarding: boolean = true
  /**
   * When enabled, the frame rotates around the X-axis to face the user, but only during movement/translation
   * unless xAlways is also enabled.
   */
  @input
  @showIf("useBillboarding")
  @hint(
    "When enabled, the frame rotates around the X-axis to face the user, but only during movement/translation \
unless xAlways is also enabled."
  )
  private xOnTranslate: boolean = true
  /**
   * When enabled, the frame continuously rotates around the X-axis to face the user, regardless of movement.
   */
  @input
  @showIf("xOnTranslate")
  @hint("When enabled, the frame continuously rotates around the X-axis to face the user, regardless of movement.")
  private xAlways: boolean = false
  /**
   * A buffered degrees (both positive and negative) on the x-axis before the frame billboards to face the user.
   */
  @input
  @showIf("xAlways")
  @hint("A buffered degrees on the x-axis before the frame billboards to face the user.")
  private xBufferDegrees: number = 0
  /**
   * When enabled, the frame rotates around the Y-axis to face the user, but only during movement/translation
   * unless yAlways is also enabled.
   */
  @input
  @showIf("useBillboarding")
  @hint(
    "When enabled, the frame rotates around the Y-axis to face the user, but only during movement/translation \
unless yAlways is also enabled."
  )
  private yOnTranslate: boolean = true
  /**
   * When enabled, the frame continuously rotates around the Y-axis to face the user, regardless of movement.
   */
  @input
  @showIf("yOnTranslate")
  @hint("When enabled, the frame continuously rotates around the Y-axis to face the user, regardless of movement.")
  private yAlways: boolean = false
  /**
   * A buffered degrees (both positive and negative) on the y-axis before the frame billboards to face the user.
   */
  @input
  @showIf("yAlways")
  @hint("A buffered degrees on the y-axis before the frame billboards to face the user.")
  private yBufferDegrees: number = 0
  @ui.group_end
  @ui.label("")
  @ui.group_start("Snapping")
  @hint("Controls how the frame snaps to other frames or world features when moved.")
  /**
   * Enables frame snapping functionality for automatic alignment to other frames or world features when
   * moved.
   */
  @input
  @hint(
    "Enables frame snapping functionality for automatic alignment to other frames or world features when \
moved."
  )
  private useSnapping: boolean = false
  /**
   * Enables snapping to other frames when moving. Not supported together with
   * the Depth Clamping / Depth Scaling behaviors, which are disabled while
   * this is active.
   */
  @input
  @showIf("useSnapping")
  @hint(
    "Enables snapping to other frames when moving. Not supported together with Depth Clamping/Scaling, \
which are disabled while this is active."
  )
  private itemSnapping: boolean = false
  /**
   * Enables snapping to physical surfaces in the real-world environment when moving.
   */
  @input
  @showIf("useSnapping")
  @hint("Enables snapping to physical surfaces in the real-world environment when moving.")
  private worldSnapping: boolean = false
  @ui.group_end
  @ui.label("")
  @ui.group_start("Tag-Along")
  @showIf("_showFollowButton", false)
  @hint("Controls the tag-along behavior of the frame.")

  /**
   * Replaces smooth follow with tag-along: the frame stays still during
   * small head movements and recenters after larger turns.
   */
  @input
  @label("Use Tag-Along Mode")
  @hint(
    "Replaces smooth follow with tag-along: the frame stays still during small head movements \
and recenters after larger turns."
  )
  private _useTagAlong: boolean = false

  /**
   * Whether the tag-along follow mode is active.
   * Can be toggled at runtime — replacing the active follow behavior while
   * keeping the follow button and per-frame update gating consistent.
   */
  public get useTagAlong(): boolean {
    return this._useTagAlong
  }

  public set useTagAlong(enabled: boolean) {
    if (this._useTagAlong === enabled) return
    this._useTagAlong = enabled

    if (!this._loop.initialized) return

    if (enabled) {
      this.setFollowing(true)
      this.createTagAlongBehavior()
    } else {
      this.setFollowBehavior(null)
      if (this.useFollowBehavior) {
        this.setUseFollow(true)
      } else {
        this.setFollowing(false)
      }
    }
  }

  @input
  @showIf("_useTagAlong")
  @label("Follow Distance")
  @hint("Distance (cm) at which the frame repositions in front of the user.")
  @widget(new SliderWidget(20, 200, 1))
  private _tagAlongDistance: number = 110

  /**
   * Distance (cm) at which the tag-along repositions in front of the user.
   * Updates propagate to the active TagAlong instance immediately.
   */
  public get tagAlongDistance(): number {
    return this._tagAlongDistance
  }

  public set tagAlongDistance(distance: number) {
    this._tagAlongDistance = distance
    if (this._follow.tagAlong) {
      this._follow.tagAlong.followDistance = distance
    }
  }

  @ui.group_end
  @ui.label("")
  @ui.group_start("Follow Behavior")
  @showIf("_useTagAlong", false)
  @hint("Controls whether the frame automatically follows the user's view when moving around.")
  @input
  @hint("Shows a button that allows users to toggle whether the frame follows their view as they move.")
  private _showFollowButton: boolean = false

  @input
  @label("Use Focus Frame")
  @hint(
    "When enabled, a text field inside this frame moves the whole frame toward the system \
keyboard while editing, pausing the frame's follow behavior until editing ends."
  )
  private _useFocusFrame: boolean = true
  /**
   * Whether this frame participates in the focus frame — i.e. may be moved toward the
   * keyboard (as the whole panel) when a text field inside it is edited.
   */
  public get useFocusFrame(): boolean {
    return this._useFocusFrame
  }
  public set useFocusFrame(use: boolean) {
    this._useFocusFrame = use
  }
  /**
   * Shows a button that allows users to toggle whether the frame follows their view as they move.
   */
  public get showFollowButton(): boolean {
    return this._showFollowButton
  }
  public set showFollowButton(show: boolean) {
    this._showFollowButton = show
    const followButtonBefore = this.followButton
    if (this.isPanelFrame) {
      // System3 — follow lives in the right drawer.
      if (show && !this._follow.button) {
        this._follow.button = this._refs.rightDrawer.addItem({
          icon: FRAME_FOLLOW_ICON,
          isToggle: true,
          name: "FrameFollowButton",
          onTriggerUp: () => {
            this._interactionState.input.pinching = false
          }
        })
      }
      if (this._follow.button) {
        // Route through setItemEnabled so the drawer's layout collapses
        // around the remaining enabled items rather than leaving a gap.
        this._refs.rightDrawer.setItemEnabled(this._follow.button, show)
      }
    } else {
      // System2 — follow is a single button managed by ButtonHandler.
      this._refs.buttonHandler.enableFollowButton(show)
    }
    // Wire the toggle handler when the button is newly created. Subsequent
    // setter calls re-use the same Button instance so the listener stays
    // attached. Without this, setting showFollowButton = true at runtime
    // (after initializeHandlers) leaves the button without its toggle.
    if (!followButtonBefore && this.followButton) {
      this.followButton.onTriggerUp.add(() => {
        this.setFollowing(!this.following)
      })
    }
  }

  /**
   * Add a custom button to the right drawer. Returns the created Button so
   * callers can wire their own listeners or toggle state.
   */
  public addRightDrawerButton(config: {
    icon: Texture
    isToggle?: boolean
    onTriggerUp: () => void
    name?: string
  }): Button {
    return this._refs.rightDrawer.addItem(config)
  }

  /**
   * Toggle a drawer button's enabled state. The drawer's layout collapses
   * around the remaining enabled items so there's no dead vertical gap.
   * Prefer this over `button.sceneObject.enabled = ...` directly — the
   * raw SceneObject toggle bypasses the drawer's layout pass.
   * Returns true if the button was found in the drawer.
   */
  public setRightDrawerButtonEnabled(button: Button, enabled: boolean): boolean {
    return this._refs.rightDrawer.setItemEnabled(button, enabled)
  }

  /**
   * Remove a drawer button entirely. The drawer destroys the SceneObject
   * and collapses layout around remaining items; if this was the last
   * item, the drawer subtree disables. Prefer this over destroying the
   * Button's SceneObject directly — the raw destroy leaves a stale item
   * entry in the drawer's internal list.
   */
  public removeRightDrawerButton(button: Button): void {
    this._refs.rightDrawer.removeItem(button)
  }

  /**
   * Local-space x-coordinate of the rightmost extent of the frame's
   * interactive footprint (body + right-side affordances). Use this to
   * anchor adjacent UI without overlapping the System3 drawer when it's
   * expanded. Falls back to `totalSize.x / 2` when no drawer affordance
   * exists (System2 frames, or System3 with no enabled drawer items).
   */
  public get rightOuterEdge(): number {
    if (this.isPanelFrame) {
      const bounds = this._refs.rightDrawer.getBounds()
      if (bounds) return bounds.center.x + bounds.size.x / 2
    }
    return this.totalSize.x * 0.5
  }

  /**
   * Local-space x-coordinate of the leftmost extent of the frame's
   * interactive footprint. Today equals `-totalSize.x / 2` — the close
   * button half-overlaps the body's left edge, so it doesn't extend the
   * interactive footprint outward.
   */
  public get leftOuterEdge(): number {
    return -this.totalSize.x * 0.5
  }

  /**
   * Bounding box of the right drawer in frame-local space. Returns null
   * on System2 frames or when the drawer has no enabled items. Use this
   * when tooltip/popup placement needs the drawer's vertical extent too,
   * not just the rightmost edge. The bounds reflect the visible-state
   * (slid-out) position, not the current animated frame.
   */
  public getRightDrawerBounds(): {center: vec3; size: vec2} | null {
    if (!this.isPanelFrame) return null
    return this._refs.rightDrawer.getBounds()
  }

  /**
   * When enabled, creates a follow behavior that keeps the frame in front of the user's view.
   */
  @input
  @label("Use Built-In Follow Behavior")
  @showIf("_showFollowButton")
  @hint("When enabled, creates a follow behavior that keeps the frame in front of the user's view.")
  private useFollowBehavior: boolean = false

  /**
   * Enables tilt mode, which switches the follow behavior to gaze-tracking
   * when the user looks up or down beyond the configured thresholds.
   */
  @input
  @showIf("useFollowBehavior")
  @label("Use Tilt Mode")
  @hint(
    "Enables tilt mode, which switches the follow behavior to gaze-tracking \
when the user looks up or down beyond the configured thresholds."
  )
  private _useTiltMode: boolean = false

  /**
   * Camera pitch angle (degrees) looking UP at which gaze-tracking activates.
   */
  @input
  @showIf("_useTiltMode")
  @label("Tilt Up Threshold (degrees)")
  @hint("Camera pitch angle looking up at which gaze-tracking activates.")
  @widget(new SliderWidget(0, 90, 1))
  private _tiltUpThreshold: number = 25

  /**
   * Camera pitch angle (degrees) looking DOWN at which gaze-tracking activates.
   */
  @input
  @showIf("_useTiltMode")
  @label("Tilt Down Threshold (degrees)")
  @hint("Camera pitch angle looking down at which gaze-tracking activates.")
  @widget(new SliderWidget(0, 90, 1))
  private _tiltDownThreshold: number = 35

  /**
   * Controls whether the frame actively follows the user's view. Setting this defines the initial state.
   */
  @input
  @showIf("useFollowBehavior")
  @hint("Turns on the following. If this is set to true, it will begin following the user immediately.")
  private _following: boolean = false
  public get following(): boolean {
    return this._following
  }

  public get useTiltMode(): boolean {
    return this._useTiltMode
  }
  public set useTiltMode(enabled: boolean) {
    this._useTiltMode = enabled
    this.syncSmoothFollowTiltConfig()
  }

  public get tiltUpThreshold(): number {
    return this._tiltUpThreshold
  }
  public set tiltUpThreshold(degrees: number) {
    this._tiltUpThreshold = degrees
    this.syncSmoothFollowTiltConfig()
  }

  public get tiltDownThreshold(): number {
    return this._tiltDownThreshold
  }
  public set tiltDownThreshold(degrees: number) {
    this._tiltDownThreshold = degrees
    this.syncSmoothFollowTiltConfig()
  }
  @ui.group_end
  @ui.label("")
  @ui.group_start("Depth Clamping")
  @hint("Constrains the grabbed point's camera-forward depth while the frame is translated.")
  @input
  @label("Enable Depth Clamping")
  @hint(
    "Keeps the grabbed point between the configured near and far depths during user translation. \
Has no effect while Allow Translation is off (unless Force Translate is on). \
Not supported together with Item Snapping."
  )
  private _useDepthClamping: boolean = false
  /**
   * Whether user translation is constrained to the configured camera-forward
   * depth range. Enabling during an active grab — including re-enabling
   * after a mid-grab disable — takes effect on the next grab; disabling
   * applies immediately (an in-flight correction is canceled synchronously,
   * holding the displayed pose, and the next translation update rejoins the
   * unconstrained grab position). Not supported together with item snapping:
   * enabling is ignored (with a warning) while itemSnapping is active.
   */
  public get useDepthClamping(): boolean {
    return this._useDepthClamping
  }
  public set useDepthClamping(enabled: boolean) {
    if (enabled && this.itemSnappingActive) {
      log.w("useDepthClamping ignored: depth clamping is not supported together with item snapping.")
      return
    }
    if (this._useDepthClamping === enabled) return
    this._useDepthClamping = enabled
    this.applyDepthClampingConfigurationChange()
  }

  @input
  @showIf("_useDepthClamping")
  @label("Minimum Depth (cm)")
  @hint("Closest camera-forward depth allowed for the grabbed point, in centimeters.")
  private _minimumDepth: number = 35
  public get minimumDepth(): number {
    return this._minimumDepth
  }
  public set minimumDepth(depth: number) {
    // Same-value writes stay silent (matching the boolean setters): notifying
    // would retarget a released correction against the current camera pose
    // and, mid-recovery, keep resetting the duration-handoff window.
    if (this._minimumDepth === depth) return
    this._minimumDepth = depth
    this.applyDepthClampingConfigurationChange()
  }

  @input
  @showIf("_useDepthClamping")
  @label("Maximum Depth (cm)")
  @hint("Farthest camera-forward depth allowed for the grabbed point, in centimeters.")
  private _maximumDepth: number = 110
  public get maximumDepth(): number {
    return this._maximumDepth
  }
  public set maximumDepth(depth: number) {
    if (this._maximumDepth === depth) return
    this._maximumDepth = depth
    this.applyDepthClampingConfigurationChange()
  }

  @ui.group_end
  @ui.label("")
  @ui.group_start("Depth Scaling")
  @hint(
    "Uniformly scales the Frame from its authored local scale as its camera-forward depth changes. \
Independent of Allow Scaling (the corner-resize gesture)."
  )
  @input
  @label("Enable Depth Scaling")
  @hint(
    "Updates scale when the Frame moves; camera-only movement does not resize a stationary Frame. \
Not supported together with Item Snapping."
  )
  private _useDepthScaling: boolean = false
  /**
   * Whether Frame uniformly scales along its configured camera-forward depth
   * curve. Enabling during an active grab — including re-enabling after a
   * mid-grab disable — takes effect when that grab releases; disabling
   * applies immediately. Not supported together with item snapping: enabling
   * is ignored (with a warning) while itemSnapping is active.
   */
  public get useDepthScaling(): boolean {
    return this._useDepthScaling
  }
  public set useDepthScaling(enabled: boolean) {
    if (enabled && this.itemSnappingActive) {
      log.w("useDepthScaling ignored: depth scaling is not supported together with item snapping.")
      return
    }
    if (this._useDepthScaling === enabled) return
    this._useDepthScaling = enabled
    this._depth.behavior?.onScalingConfigurationChanged()
    this.syncDepthBehavior()
    this.refreshDepthScaling()
  }

  @input
  @showIf("_useDepthScaling")
  @label("Minimum Depth (cm)")
  @hint("Near endpoint of the depth scaling curve, in centimeters.")
  private _depthScalingMinimumDepth: number = 35
  public get depthScalingMinimumDepth(): number {
    return this._depthScalingMinimumDepth
  }
  public set depthScalingMinimumDepth(depth: number) {
    this._depthScalingMinimumDepth = depth
    this.refreshDepthScaling()
  }

  @input
  @showIf("_useDepthScaling")
  @label("Maximum Depth (cm)")
  @hint("Far endpoint of the depth scaling curve, in centimeters.")
  private _depthScalingMaximumDepth: number = 110
  public get depthScalingMaximumDepth(): number {
    return this._depthScalingMaximumDepth
  }
  public set depthScalingMaximumDepth(depth: number) {
    this._depthScalingMaximumDepth = depth
    this.refreshDepthScaling()
  }

  @input
  @showIf("_useDepthScaling")
  @label("Minimum Scale")
  @hint("Uniform scale factor at or nearer than the minimum depth.")
  private _depthScalingMinimumScale: number = 0.5
  public get depthScalingMinimumScale(): number {
    return this._depthScalingMinimumScale
  }
  public set depthScalingMinimumScale(scale: number) {
    this._depthScalingMinimumScale = scale
    this.refreshDepthScaling()
  }

  @input
  @showIf("_useDepthScaling")
  @label("Maximum Scale")
  @hint("Uniform scale factor at or farther than the maximum depth.")
  private _depthScalingMaximumScale: number = 1
  public get depthScalingMaximumScale(): number {
    return this._depthScalingMaximumScale
  }
  public set depthScalingMaximumScale(scale: number) {
    this._depthScalingMaximumScale = scale
    this.refreshDepthScaling()
  }

  @ui.group_end
  @ui.label("")
  @ui.group_start("Close Button")
  @hint("Controls whether a close button is displayed in the corner of the frame.")
  @input
  @hint("Shows a button that allows users to close or dismiss the frame.")
  private _showCloseButton: boolean = false
  /**
   * Shows a button that allows users to close or dismiss the frame.
   */
  public get showCloseButton(): boolean {
    return this._showCloseButton
  }
  public set showCloseButton(show: boolean) {
    this._showCloseButton = show
    this._refs.buttonHandler.enableCloseButton(this._showCloseButton)
  }

  /**
   * Withholds the close affordance while a composing component's policy says it
   * must not appear, without disturbing the {@link showCloseButton} request.
   * The request is re-derived when suppression lifts, so a consumer write made
   * during the window lands then rather than being lost — and cannot punch the
   * window open, the way an ungated setter would.
   *
   * Frame itself never suppresses; this exists for owners whose compact
   * modes have no room for a sub-centimeter target sitting on its own
   * grab area.
   */
  public setCloseButtonSuppressed(suppressed: boolean): void {
    this._refs.buttonHandler.setCloseButtonSuppressed(suppressed)
  }
  @ui.group_end
  @ui.group_start("Interaction Plane")
  @hint("Settings for an interaction plane that extends around the frame.")
  /**
   * Enables an Interaction Plane that creates a near-field targeting zone around the frame that improves
   * precision when interacting with buttons and UI elements using hand tracking.
   */
  @input
  @hint(
    "Enables an Interaction Plane that creates a near-field targeting zone around the frame that improves \
precision when interacting with buttons and UI elements using hand tracking."
  )
  private _enableInteractionPlane: boolean = true
  private _runtimeInteractionPlaneEnabled: boolean | null = null
  /** Set while a composing component suppresses frame-owned interaction. */
  private _interactionSuppressed: boolean = false

  /**
   * Suppresses this Frame's OWN interaction components — the collider,
   * Interactable, manipulation, billboard, and interaction plane it created and
   * tracks. Content a consumer parented under the frame is deliberately NOT
   * touched: the frame does not own those flags, and a snapshot/restore of them
   * cannot distinguish a suppression write from a consumer's own write, so it
   * would clobber deliberate application state.
   *
   * Restoring re-derives each component's live policy rather than replaying a
   * snapshot, which is what makes repeated or interleaved suppression safe.
   * No-ops while the frame is disabled — its own OnEnable handler owns that
   * transition and re-derives the same policy.
   */
  public setInteractionSuppressed(suppressed: boolean): void {
    if (this._interactionSuppressed === suppressed) return
    this._interactionSuppressed = suppressed
    if (!this.enabled || !this.sceneObject.isEnabledInHierarchy) return
    this.applyInteractionSuppression()
  }

  public get interactionSuppressed(): boolean {
    return this._interactionSuppressed
  }

  /** Writes the current suppression state onto the frame-owned components. */
  private applyInteractionSuppression(): void {
    this._refs.managedComponents.forEach((component) => {
      if (isNull(component) || !component) return
      if (this._interactionSuppressed) {
        component.enabled = false
        return
      }
      component.enabled = component === this._refs.interactionPlane ? this.interactionPlaneEnabled : true
    })
  }

  /** Enables or disables the Frame-owned near-field interaction plane. */
  public get interactionPlaneEnabled(): boolean {
    return this._runtimeInteractionPlaneEnabled ?? this._enableInteractionPlane
  }

  public set interactionPlaneEnabled(enabled: boolean) {
    // The request is always stored; only the live write is gated. Suppression
    // and disable both re-derive from this field when they restore
    // (applyInteractionSuppression), so a request made during either window
    // lands intact once the frame owns its interaction again — and neither
    // window can be punched open by a write that only meant to change policy.
    this._runtimeInteractionPlaneEnabled = enabled
    if (this._refs.interactionPlane && !isNull(this._refs.interactionPlane)) {
      this._refs.interactionPlane.enabled =
        enabled && !this._interactionSuppressed && this.enabled && this.sceneObject.isEnabledInHierarchy
    }
  }

  @input
  @showIf("_enableInteractionPlane")
  @hint("Offset position for the interaction plane relative to the frame center.")
  private _interactionPlaneOffset: vec3 = new vec3(0, 0, 0)

  /**
   * Get the offset position for the interaction plane relative to the frame center.
   */
  public get interactionPlaneOffset(): vec3 {
    return this._interactionPlaneOffset
  }

  /**
   * Set the offset position for the interaction plane relative to the frame center.
   * @param offset - The new offset.
   */
  public set interactionPlaneOffset(offset: vec3) {
    this._interactionPlaneOffset = offset
    this.updateInteractionPlane()
  }

  @input
  @showIf("_enableInteractionPlane")
  @hint("Padding that extends the InteractionPlane size.")
  private _interactionPlanePadding: vec2 = new vec2(0, 0)

  /**
   * Get the size of the padding around the InteractionPlane.
   */
  public get interactionPlanePadding(): vec2 {
    return this._interactionPlanePadding
  }

  /**
   * Set the size of the padding around the InteractionPlane.
   * @param padding - The new padding.
   */
  public set interactionPlanePadding(padding: vec2) {
    this._interactionPlanePadding = padding
    this.updateInteractionPlane()
  }

  /**
   * Sets the preferred targeting visual.
   * An enclosing InteractionPlane's value overrides this unless `ignoreInteractionPlane` is set.
   * - 0: None
   * - 1: Cursor (default)
   * - 2: Ray
   */
  @input
  @showIf("_enableInteractionPlane")
  @hint(
    "Sets the preferred targeting visual. An enclosing InteractionPlane overrides this unless Ignore Interaction Plane is set.\n\n\
- 0: None\n\
- 1: Cursor (default)\n\
- 2: Ray"
  )
  @widget(new ComboBoxWidget([new ComboBoxItem("None", 0), new ComboBoxItem("Cursor", 1), new ComboBoxItem("Ray", 2)]))
  private _targetingVisual: number = TargetingVisual.Cursor
  private _runtimeTargetingVisual: TargetingVisual | null = null

  /** Preferred targeting visual used by the Frame-owned interaction plane. */
  public get targetingVisual(): TargetingVisual {
    return this._runtimeTargetingVisual ?? this.normalizeTargetingVisual(this._targetingVisual)
  }

  public set targetingVisual(targetingVisual: TargetingVisual) {
    const normalized = this.normalizeTargetingVisual(targetingVisual)
    if (normalized !== targetingVisual) {
      log.w(`Unknown Frame targeting visual "${String(targetingVisual)}"; using Cursor.`)
    }
    this._runtimeTargetingVisual = normalized
    if (this._refs.interactionPlane && !isNull(this._refs.interactionPlane)) {
      this._refs.interactionPlane.targetingVisual = normalized
    }
  }

  private normalizeTargetingVisual(targetingVisual: number): TargetingVisual {
    switch (targetingVisual) {
      case TargetingVisual.None:
      case TargetingVisual.Cursor:
      case TargetingVisual.Ray:
        return targetingVisual
      default:
        return TargetingVisual.Cursor
    }
  }

  /** Parent SceneObject for the frame's content (assigned during onAwake). */
  public get content(): SceneObject {
    return this._refs.content
  }

  /** Top-level SceneObject holding the frame body (assigned during onAwake). */
  public get frameObject(): SceneObject {
    return this._refs.frameObject
  }

  /**
   * Transform of top level frame object.
   */
  public get transform(): Transform {
    return this._refs.transform
  }

  /**
   * Transform of content parent SceneObject.
   */
  public get contentTransform(): Transform {
    return this._refs.contentTransform
  }

  // Derived per-interaction transition state, grouped in one container. Read on
  // the hot paths (update/getInputMode/handleInputState/computeHitPosition) via
  // `this._interactionState.X`.
  private readonly _interactionState: FrameInteractionState = {
    inputMode: InputMode.Auto,
    scaling: false,
    translating: false,
    translatingLastFrame: false,
    billboardStateApplied: false,
    isInZone: false,
    isInZoneLast: false,
    pinchingLastFrame: false,
    hoveringInnerInteractableLast: false,
    hoveringContentLast: false,
    wasInFarNearTransition: false,
    forceTranslate: false,
    allowScalingTopLeft: true,
    allowScalingTopRight: true,
    dragStart: vec3.zero(),
    scalingSizeStart: vec2.zero(),
    // Desired manipulator cursor mode, derived from inputMode in updateInput().
    cursorMode: CursorMode.Auto,
    trigger: triggerIdleState,
    input: {
      hovered: false,
      hierarchyHovered: false,
      pinching: false,
      position: vec3.zero(),
      innerInteractableActive: false
    }
  }

  // Per-interactor cursor tracking. The previous single-slot _interactorCursor
  // was clobbered whenever a second hand entered the frame's hover region,
  // causing cursor-mode writes (Scale/Translate) to land on the wrong hand.
  // We now keep one entry per interactor for the lifetime of its hover.
  // First-arriving interactor wins the manipulator slot; non-manipulator
  // cursors stay in Auto while a gesture is active. This is deliberate.
  //
  // No mode cache lives here: updateCursorMode() compares against the
  // cursor's own `cursorMode` getter (the authoritative state), so writes
  // self-heal if any other component resets the cursor behind Frame's back.
  private _interactorCursors: Map<Interactor, InteractorCursor> = new Map()
  // Whether the frame's hovered visual (System3 green border fade) is on.
  // Driven by LIVE body targeting — a hand hovering a nested child interactable
  // (button, list item, …) must NOT light the frame's own hover highlight, only
  // a hand targeting the frame's interactable itself (body or margin) does.
  private _frameBodyHovered: boolean = false
  // Interactors currently LIVE-targeting the frame's own interactable. Updated
  // from HoverBehavior's per-frame hover events (registration-independent — a
  // hand whose cursor hasn't registered yet still drives this) and reconciled
  // against live targeting in updateCursorMode() to shed missed-exit hands.
  private _bodyHoverInteractors: Set<Interactor> = new Set()
  // Consecutive-frame counter for the reconciliation in updateCursorMode():
  // how long each registered interactor has been off the frame's hover
  // hierarchy. Entries past CURSOR_RECONCILE_OFF_FRAMES are reaped.
  private _interactorOffHierarchyFrames: Map<Interactor, number> = new Map()
  // Per-interactor object-space hit position. Lets updateCursorMode() derive
  // each cursor's mode from its own position instead of sharing the single
  // _inputState.position (which is intentionally single-slot for the
  // manipulator's getInputMode/handleInputState path).
  private _interactorPositions: Map<Interactor, vec3> = new Map()
  // NOTE: the per-interactor inner-content gate is NOT cached here. It is
  // read live from `interactor.currentInteractable` in updateCursorMode().
  // An event-fed cache went stale when hover events lagged behind the hand
  // (HoverBehavior replays the last stored event between real deliveries),
  // which let the cursor show Auto on a corner while the gesture — driven
  // by the live position — correctly started a scale.

  // Follow/tag-along state, grouped in one container.
  private readonly _follow: FrameFollow = {
    button: null,
    smooth: null,
    tagAlong: null,
    cleanup: null,
    suspended: false,
    suspendOwners: []
  }

  // Component handles + infra refs (one container). Non-null handles are seeded
  // null! (deferred init — assigned in onAwake/OnStart) so all keys are present
  // up-front for a stable shape; the FrameRefs type above carries the contract.
  private readonly _refs: FrameRefs = {
    transform: null!,
    contentTransform: null!,
    content: null!,
    frameObject: null!,
    chrome: null!,
    drawerHost: null!,
    shadowHost: null!,
    shadow: null,
    canvasController: null,
    collider: null!,
    colliderShape: null!,
    interactable: null!,
    manipulate: null!,
    billboardComponent: null!,
    buttonHandler: null!,
    rightDrawer: null!,
    frameVisual: null!,
    snappingHandler: null!,
    hoverBehavior: null!,
    interactionPlane: null!,
    interactionPlaneTransform: null,
    managedSceneObjects: [],
    managedComponents: [],
    axisBufferDegrees: new vec3(0, 0, 0),
    // Shared default is safe: setBillboardEasing replaces the reference, never
    // mutates components (same contract as AXIS_BUFFER_ZERO).
    axisEasing: BILLBOARD_AXIS_EASING,
    cachedFrameParams: null,
    unsubscribes: []
  }

  public get closeButton(): Button {
    return this._refs.buttonHandler.closeButton
  }

  public get followButton(): Button {
    return (this._follow.button ?? this._refs.buttonHandler.followButton) as Button
  }

  /**
   * Look up the `ElementContent` companion attached to a Frame-owned
   * Button (close lives on ButtonHandler; System3 follow lives on a
   * RightDrawer item; System2 follow lives on ButtonHandler). The icon
   * always sits on the same SceneObject as its Button after the System2
   * unification, so this single lookup works for both themes.
   */
  private iconContentOf(button: Button | null): ElementContent | null {
    if (!button || isNull(button) || isNull(button.sceneObject)) return null
    return button.sceneObject.getComponent(ElementContent.getTypeName()) as ElementContent | null
  }

  /**
   * The texture displayed on the close button's icon slot. Use this to
   * repurpose the close button as a back/home affordance without reaching
   * into theme-specific internals. Returns null if the close button
   * hasn't been created yet — set `showCloseButton = true` first.
   */
  public get closeButtonIcon(): Texture | null {
    return this.iconContentOf(this.closeButton)?.leadingIcon ?? null
  }
  public set closeButtonIcon(texture: Texture) {
    const content = this.iconContentOf(this.closeButton)
    if (content) content.leadingIcon = texture
  }

  /**
   * The texture displayed on the follow button's icon slot. Use this to
   * swap follow → pin / bookmark / other affordances. Returns null if
   * the follow button hasn't been created yet — set
   * `showFollowButton = true` first.
   */
  public get followButtonIcon(): Texture | null {
    return this.iconContentOf(this.followButton)?.leadingIcon ?? null
  }
  public set followButtonIcon(texture: Texture) {
    const content = this.iconContentOf(this.followButton)
    if (content) content.leadingIcon = texture
  }

  // Layout/size state, grouped in one container. `totalSize` is maintained
  // eagerly by recomputeTotalSize() (see the totalSize getter); reads are a
  // plain field return with no per-read allocation or dirty-flag branch.
  private readonly _layout: FrameLayout = {
    margin: 2.5,
    ogMargin: 2.5,
    customCornerRadius: null,
    originalInnerSize: vec2.zero(),
    grabZones: [],
    grabZoneOnly: false,
    squeezeAmount: 2.5 * 0.15,
    totalSize: new vec2(0, 0),
    interactablePadding: vec2.zero()
  }
  /**
   * Width of the grabbable margin around the frame's content. Contributes to totalSize
   * and defines where the frame's edge interaction region begins. Distinct from the
   * visual border rendered by the underlying RoundedRectangle.
   */
  public get margin(): number {
    return this._layout.margin
  }
  public set margin(margin: number) {
    // Full write: live margin + eager totalSize, the shader uniform, the
    // un-squeezed baseline (ogMargin), and a relayout. The per-frame grab
    // squeeze uses setSqueezeMargin() instead — see there for why.
    this._layout.margin = margin
    this.recomputeTotalSize()
    this._refs.frameVisual.setFrameMargin(margin)
    this._layout.ogMargin = margin
    this.scaleFrame()
  }

  @ui.group_end
  @ui.separator
  @input("vec2", "{1,1}")
  @hint(
    "Per-side padding (x = horizontal, y = vertical) added to the interaction collider only — widens the grab band \
around the frame without changing the visible frame size. In local space centimeters."
  )
  private _interactablePadding: vec2 = new vec2(1, 1)
  /**
   * Per-side padding (x = horizontal, y = vertical) added to the interaction
   * collider only — widens the grab band around the frame without changing the
   * visible frame size. Defaults to (1,1); serialized @input so every Frame
   * ships a 1cm grab band beyond the visible border.
   */
  public get interactablePadding(): vec2 {
    return this._layout.interactablePadding
  }
  public set interactablePadding(padding: vec2) {
    if (padding == null) return
    this._interactablePadding = padding
    this._layout.interactablePadding = padding
    // No-op during init (deferLayout); onStart's consolidated scaleFrame applies it.
    this.scaleFrame(true)
  }

  /**
   * Per-frame margin write for the grab "squeeze" tween — minimal on purpose:
   * live margin + eager totalSize only. It must NOT touch `ogMargin` (the
   * un-squeezed value the squeeze restores to on translate-end; overwriting it
   * each step would drag the baseline down and the margin would never spring
   * back), and skips the shader push + full scaleFrame to avoid a collider
   * rebuild + onSizeChanged cascade every drag frame. Naming it (vs a raw
   * `_layout.margin =`) keeps those omissions deliberate and visible.
   */
  private setSqueezeMargin(value: number): void {
    this._layout.margin = value
    this.recomputeTotalSize()
  }

  /**
   * @deprecated Renamed to `margin`. Will be removed in a future release.
   * The frame's grabbable margin, distinct from the visual border rendered
   * by the underlying RoundedRectangle.
   */
  public get border(): number {
    return this.margin
  }
  public set border(value: number) {
    this.margin = value
  }

  /**
   * Handles hover behavior for the frame.
   */
  public get hoverBehavior(): HoverBehavior {
    return this._refs.hoverBehavior
  }

  /** Active visual implementation for this frame. */
  public get frameVisual(): FrameVisual {
    return this._refs.frameVisual
  }

  /**
   * True when the frame is rendering with the System3 panel visual. Used by
   * show/hide and hover gating to fork System3-specific behavior (drawer
   * slide, body-fade-gated-on-autoShowHide) from the classic alpha tween.
   */
  private get isPanelFrame(): boolean {
    return this._refs.frameVisual instanceof FramePanelVisual
  }

  /**
   * Underlying RoundedRectangle when the current visual is the default
   * FrameRoundedRectVisual; null for other visual types.
   * @deprecated Prefer `frame.cornerRadius` for shape metrics and the
   *             FrameVisual interface for rendering operations.
   */
  public get roundedRectangle(): RoundedRectangle | null {
    return this._refs.frameVisual instanceof FrameRoundedRectVisual ? this._refs.frameVisual.roundedRectangle : null
  }

  /**
   * Currently-applied corner radius of the frame body in cm. Returns the
   * value most recently set via `cornerRadius =` if one is active,
   * otherwise the appearance-driven value (which on System3 is a single
   * fixed radius regardless of appearance — see `PANEL_CORNER_RADIUS` in
   * `FramePanelVisual`). Does NOT reflect the drawer's own corner radius
   * (`DRAWER_CORNER_RADIUS` in `RightDrawer.ts`).
   */
  public get cornerRadius(): number {
    return this._layout.customCornerRadius ?? this._refs.frameVisual.cornerRadius
  }

  /**
   * Override the frame body's corner radius in cm. Persists across
   * `appearance` changes until `resetCornerRadius()` is called. The
   * drawer is unaffected — it has its own fixed corner radius. The snap
   * ghost is refreshed to match.
   */
  public set cornerRadius(radius: number) {
    this._layout.customCornerRadius = radius
    this._refs.frameVisual.setCornerRadius(radius)
    this._refs.snappingHandler?.setGhostCornerRadius(radius)
    if (this._refs.shadow) {
      this._refs.shadow.cornerRadius = radius
    }
  }

  /**
   * Clear any custom corner radius so the frame resumes the appearance-
   * driven default. Re-applies the current appearance to refresh the
   * visual and the snap ghost.
   */
  public resetCornerRadius(): void {
    this._layout.customCornerRadius = null
    const config = this.getFrameParams().appearances[this.appearance as FrameAppearance]
    if (config) {
      this._refs.frameVisual.applyAppearance(config)
    }
    this._refs.snappingHandler?.setGhostCornerRadius(this._refs.frameVisual.cornerRadius)
    if (this._refs.shadow) {
      this._refs.shadow.cornerRadius = this._refs.frameVisual.cornerRadius
    }
  }

  /** Frame's ColliderComponent (created during onAwake). */
  public get collider(): ColliderComponent {
    return this._refs.collider
  }

  /**
   * Billboard component for the frame, used for automatic rotation to face the camera/user.
   */
  public get billboardComponent(): Billboard {
    return this._refs.billboardComponent
  }

  // Recompute the cached billboard axis-buffer vec3 (_refs.axisBufferDegrees)
  // only when the buffer-degree inputs change (init + setBillboardBufferDegrees).
  // A fresh instance per refresh (rare) rather than an in-place mutation, so a
  // Billboard reference retained from a prior frame is never disturbed.
  private refreshAxisBufferDegrees(): void {
    this._refs.axisBufferDegrees = new vec3(this.xBufferDegrees, this.yBufferDegrees, 0)
  }

  // Frame's event emitters live in one lazy container (_events): each starts
  // null and is created on first subscribe by its `onX` getter
  // (`this._events.X ??= new Event()`), mirroring IK Interactable. Dispatch
  // uses `this._events.X?.invoke(...)`, so an Event exists iff something
  // subscribed. `initialized` is a ReplayEvent force-created at its invoke site
  // so a late subscriber still receives the replay.
  private readonly _events: FrameEvents = {
    snappingComplete: null,
    followUpdate: null,
    followingChange: null,
    scalingUpdate: null,
    scalingStart: null,
    scalingEnd: null,
    translationStart: null,
    translationEnd: null,
    hoverEnterInnerInteractable: null,
    hoverExitInnerInteractable: null,
    initialized: null,
    showVisual: null,
    hideVisual: null,
    sizeChanged: null
  }

  /**
   * Public api for adding functions to the onSnappingComplete event handler.
   */
  public get onSnappingComplete(): PublicApi<void> {
    return (this._events.snappingComplete ??= new Event<void>()).publicApi()
  }

  /**
   * Fires every frame while the frame is in follow mode.
   * Follow behaviors subscribe to this to receive per-frame updates.
   */
  public get onFollowUpdate(): PublicApi<void> {
    return (this._events.followUpdate ??= new Event<void>()).publicApi()
  }

  /**
   * @deprecated Frame no longer holds a direct SmoothFollow reference. Follow is
   * now event-driven — subscribe to `onFollowUpdate`, `onTranslationStart/End`,
   * `onScalingStart/End`, `onSizeChanged` to implement custom follow behaviors,
   * or call `setUseFollow(true)` for the default behavior. This getter always
   * returns `null`.
   */
  public get smoothFollow(): null {
    return null
  }

  /**
   * Public api for adding functions to the onFollowingChange event handler.
   */
  public get onFollowingChange(): PublicApi<boolean> {
    return (this._events.followingChange ??= new Event<boolean>()).publicApi()
  }

  /**
   * TotalSize is the total size of the frame including margin and padding in
   * local space centimeters. Maintained eagerly (push, not pull): recomputed by
   * recomputeTotalSize() only when an input (innerSize/margin/padding) changes,
   * so reads (hit-testing, width/height, button/drawer layout, snapping) are a
   * plain field return with no per-read allocation. Returning the stable
   * instance is safe: every consumer reads .x/.y or stores by copy.
   */
  public get totalSize(): vec2 {
    return this._layout.totalSize
  }

  /**
   * Like {@link totalSize}, but computed from the un-squeezed margin baseline.
   * During a grab the frame tweens its live margin for feedback without
   * resizing the visual, so `totalSize` transiently shrinks. Use this stable
   * size for media layers and bounds that must remain locked to the visible
   * frame throughout the gesture.
   */
  public get stableTotalSize(): vec2 {
    return new vec2(
      this.innerSize.x + this._layout.ogMargin * 2 + this.padding.x,
      this.innerSize.y + this._layout.ogMargin * 2 + this.padding.y
    )
  }

  private recomputeTotalSize(): void {
    this._layout.totalSize = new vec2(
      this.innerSize.x + this._layout.margin * 2 + this.padding.x,
      this.innerSize.y + this._layout.margin * 2 + this.padding.y
    )
  }

  /**
   * Public api for adding functions to the onScalingUpdate event handler.
   */
  public get onScalingUpdate(): PublicApi<void> {
    return (this._events.scalingUpdate ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onScalingStart event handler.
   */
  public get onScalingStart(): PublicApi<void> {
    return (this._events.scalingStart ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onScalingEnd event handler.
   */
  public get onScalingEnd(): PublicApi<void> {
    return (this._events.scalingEnd ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onTranslationStart event handler.
   */
  public get onTranslationStart(): PublicApi<void> {
    return (this._events.translationStart ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onTranslationEnd event handler.
   */
  public get onTranslationEnd(): PublicApi<void> {
    return (this._events.translationEnd ??= new Event<void>()).publicApi()
  }

  public get onHoverEnterInnerInteractable(): PublicApi<void> {
    return (this._events.hoverEnterInnerInteractable ??= new Event<void>()).publicApi()
  }

  public get onHoverExitInnerInteractable(): PublicApi<void> {
    return (this._events.hoverExitInnerInteractable ??= new Event<void>()).publicApi()
  }

  public get forceTranslate() {
    return this._interactionState.forceTranslate
  }

  public set forceTranslate(forceTranslate: boolean) {
    this._interactionState.forceTranslate = forceTranslate
    // Billboard axis enables derive from forceTranslate — re-apply next update.
    this._interactionState.billboardStateApplied = false
    // Wake the gated loop: forceTranslate self-pumps translating every frame,
    // and there is no hover/gesture precondition to keep the loop alive here.
    this.refreshPerFrameActive()
  }

  /**
   * Getter for the initial scaling size.
   */
  public get scalingSizeStart(): vec2 {
    return this._interactionState.scalingSizeStart
  }
  /**
   * Setter for the initial scaling size.
   */
  public set scalingSizeStart(thisSize: vec2) {
    this._interactionState.scalingSizeStart = thisSize
  }

  /**
   * The interactor currently driving Frame's gesture (scale or translate),
   * or null if no gesture is active. Mirrors `_triggerState.primary` for
   * external consumers. In dual-grab mode, this is the primary (first-arriving)
   * interactor.
   */
  public get currentInteractor(): Interactor | null {
    if (this._interactionState.trigger.kind === "idle") return null
    return this._interactionState.trigger.primary
  }
  /**
   * The secondary interactor in dual-grab mode, or null otherwise.
   * Exposed for diagnostics; Frame's internal code should branch on
   * `_triggerState.kind === "dual"` rather than reading this field.
   */
  public get secondaryInteractor(): Interactor | null {
    return this._interactionState.trigger.kind === "dual" ? this._interactionState.trigger.secondary : null
  }
  /** True iff two interactors are currently triggering. */
  private get isDualGrab(): boolean {
    return this._interactionState.trigger.kind === "dual"
  }

  // Visual / animation state, grouped in one container.
  private readonly _visual: FrameVisualState = {
    opacity: 1,
    isVisible: true,
    bodyEnabled: true,
    hoverIntensity: 0
  }

  // Init-time layout batching: while deferLayout is true, scaleFrame() is a
  // no-op so the margin/innerSize/padding/appearance setters don't each trigger
  // a full relayout — onStart runs one consolidated scaleFrame() at the end.
  private readonly _loop: FrameLoop = {
    deferLayout: false,
    initializationStarted: false,
    initialized: false,
    // update()'s event, enabled only while the Frame has real per-frame work
    // (see perFrameActive); disabled when idle.
    updateEvent: null,
    // lateUpdate()'s event (pumps HoverBehavior). Enabled while update() is
    // active OR while HoverBehavior still has a pending hover-start/end signal
    // OR while a one-shot post-enable depth refresh is pending; parked when
    // fully idle. Woken from idle by a raw Interactable hover-enter
    // (InteractionManager-driven, independent of these events) — see
    // initializeHoverBehavior.
    lateUpdateEvent: null
  }

  // Hit-test scratch, grouped in one container:
  //  - invWorld/stamp: caches the frame's inverted world transform within a
  //    frame (stamped by getTime). computeHitPosition can run several times per
  //    frame (hover + trigger updates + dual→single rebase) and
  //    interactorLocalPlanecast shares the cache. Exact for hit-testing/gesture
  //    classification — the transform is static then (getInputMode is frozen
  //    during a pinch; scaling changes size, not world transform). It can lag
  //    one frame only when the transform moves mid-frame (active translate /
  //    follow); the sole same-frame re-read then is a non-manipulator cursor
  //    hint, which self-corrects next frame.
  //  - result: a reused HitPosition with two reused vec2s. Safe: callers consume
  //    it synchronously (read .x/.y or copy out) before the next computeHitPosition.
  private readonly _hit: FrameHit = {
    invWorld: null,
    stamp: -1,
    result: {localPosition: new vec2(0, 0), normalizedPosition: new vec2(0, 0)}
  }

  // Reused scratch for the pure FrameInputClassification helpers, which read
  // their args synchronously and never retain them, so one instance per helper
  // is repopulated in place at each call site (cursorArgs once per cursor in
  // updateCursorMode's loop).
  private readonly _scratch: FrameScratch = {
    classification: {
      innerSize: vec2.zero(),
      padding: vec2.zero(),
      grabZones: [],
      grabZoneOnly: false,
      allowScaling: true,
      allowScalingTopLeft: true,
      allowScalingTopRight: true,
      onlyInteractOnMargin: false
    },
    cursorArgs: {
      interactor: null!,
      manipulator: null,
      secondaryManipulator: null,
      manipulatorCursorMode: CursorMode.Auto,
      position: undefined,
      innerInteractableActive: false,
      classificationConfig: null!,
      cursorMappingConfig: null!
    }
  }

  private set isVisible(isVisible: boolean) {
    this._visual.isVisible = isVisible
  }

  public get isVisible() {
    return this._visual.isVisible
  }

  // Optional depth clamping / distance scaling state, grouped in one container.
  private readonly _depth: FrameDepth = {
    behavior: null,
    scaling: null,
    scalingSuspended: false,
    pendingEnableRefresh: false
  }

  /**
   * Public api for adding functions to the onInitialized event handler.
   * Backed by a ReplayEvent (force-created at its invoke site) so a subscriber
   * that attaches after initialization still receives the replayed event.
   */
  public get onInitialized(): PublicApi<void> {
    return (this._events.initialized ??= new ReplayEvent<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onShowVisual event handler.
   *
   * onShowVisual is invoked when the frame _starts_ to show its visuals.
   */
  public get onShowVisual(): PublicApi<void> {
    return (this._events.showVisual ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onHideVisual event handler.
   *
   * onHideVisual is invoked when the frame has _finished_ hiding its visuals.
   */
  public get onHideVisual(): PublicApi<void> {
    return (this._events.hideVisual ??= new Event<void>()).publicApi()
  }

  /**
   * Public api for adding functions to the onSizeChanged event handler.
   */
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._events.sizeChanged ??= new Event<vec3>()).publicApi()
  }

  public get interactionPlane() {
    return this._refs.interactionPlane
  }

  private set interactionPlane(interactionPlane: InteractionPlane) {
    this._refs.interactionPlane = interactionPlane
    this._refs.interactionPlaneTransform = interactionPlane.getTransform()
  }

  public onAwake() {
    this._refs.collider = this.sceneObject.createComponent("ColliderComponent")
    this._refs.interactable = this.sceneObject.createComponent(Interactable.getTypeName())
    this._refs.manipulate = this.sceneObject.createComponent(InteractableManipulation.getTypeName())
    this._refs.managedComponents = [this._refs.collider, this._refs.interactable, this._refs.manipulate]
    this.createEvent("OnStartEvent").bind(() => {
      if (this._loop.initializationStarted) return
      this._loop.initializationStarted = true
      // Seed the eagerly-maintained totalSize before anything reads it (the
      // margin/innerSize/padding setters below recompute it with final values).
      this.recomputeTotalSize()
      this.initializeContent()
      this.initializeVisuals()
      this._refs.content.setParent(this.sceneObject)
      this.initializeCollider()
      this.initializeHandlers()
      this.initializeBillboard()
      this.setFollowing(this.following)
      this._layout.originalInnerSize = this.innerSize.uniformScale(1)
      this.initializeInteractionPlane()
      // Defer layout: these setters (and appearance= below) each call
      // scaleFrame(); suppress them and run one consolidated pass after
      // appearance is applied, so init does a single relayout instead of ~5.
      this._loop.deferLayout = true
      this.margin = this._layout.margin
      this.innerSize = this._innerSize
      this.padding = this._padding
      this.interactablePadding = this._interactablePadding
      this.initializeHoverBehavior()
      if (this.useSnapping) this.createSnappableBehavior()
      if (this._useTagAlong) {
        this.setFollowing(true)
        this.createTagAlongBehavior()
      } else if (this.useFollowBehavior) {
        this.setUseFollow(true)
      }
      this.initializeInteractionEvents()
      // Spawn owns the whole-frame alpha on start — skip the autoShowHide
      // pre-hide so two tweens don't claim the writer on frame zero.
      if (this.autoShowHide && !this._spawnOnStart) this.hideVisual()
      this._refs.buttonHandler.renderOrder = this.renderOrder
      this._refs.rightDrawer.renderOrder = this.renderOrder
      this._refs.interactable.targetingMode = TargetingMode.Direct | TargetingMode.Indirect
      // allowMultipleInteractors defaults to true in Interactable — leave the
      // default so both hands' hover events reach Frame directly. Per-interactor
      // cursor state (`_interactorCursors` etc.) handles the bookkeeping;
      // manipulation stays single-hand via `currentInteractor` /
      // `_interactionState.scaling` / `_interactionState.translating` gating below.
      this._refs.manipulate.setCanScale(false)
      this._refs.manipulate.setCanRotate(false)
      this.syncDepthBehavior()
      // Discoverability: clamping only ever acts during user translation, so
      // this combination is silently inert. Checked once at init (after
      // syncDepthBehavior's item-snapping enforcement may clear the flag) —
      // syncDepthBehavior itself re-runs on every OnEnable/config resync, and
      // allowTranslation is a plain field, so runtime toggles can't be hooked.
      if (this._useDepthClamping && !this.allowTranslation && !this.forceTranslate) {
        log.w(
          "Depth Clamping is enabled but translation is disabled; it has no effect until " +
            "allowTranslation (or forceTranslate) is enabled."
        )
      }
      this.appearance = this._appearance as FrameAppearance
      // Re-enable layout and run the single consolidated relayout for init.
      this._loop.deferLayout = false
      this.scaleFrame(true)
      // The initial enable is an enable edge too (an app onStart running after
      // this one may reposition the frame). Armed before
      // initializeLifecycleEvents so its closing refreshPerFrameActive applies
      // the extended lateUpdate gate; whether the engine also replays
      // OnEnableEvent for this edge is not relied on — the OnEnable arm is
      // idempotent.
      this._depth.pendingEnableRefresh = true
      this.initializeLifecycleEvents()
      this._loop.initialized = true
      this.refreshDepthScaling()
      // A suppression request can land before this handler runs — a composing
      // component disabled in the same frame it created this Frame — in which
      // case it only reached the components onAwake had built by then. The
      // billboard and interaction plane above are created after it, and
      // setInteractionSuppressed no-ops on an unchanged flag, so a repeat
      // request cannot sweep them either. Re-derive here instead, while
      // suppressed only: the restore branch writes `enabled = true` to every
      // managed component, which is their creation state at init but not
      // something to reassert. Before the initialized event so a subscriber's
      // own policy — an owner may park the billboard for compact modes and headlock
      // — layers on top of this rather than being overwritten by it.
      if (this._interactionSuppressed)
        this.applyInteractionSuppression()
        // Force-create the ReplayEvent so a subscriber attaching after init still
        // receives the replayed invocation.
      ;(this._events.initialized ??= new ReplayEvent<void>()).invoke()
      // Horizon Reveal on start: the frame-zero write poses the frame at the
      // horizon (offset, 50%, hinged, alpha 0) this same frame — no flash of
      // the rest pose.
      if (this._spawnOnStart) this.spawn()
    })
  }

  /**
   * Gets the width of the frame layout in local space centimeters.
   * @returns The current width of the frame.
   */
  public get width(): number {
    return this.totalSize.x
  }

  /**
   * Sets the width of the frame.
   * @param value - The new width value.
   */
  public set width(value: number) {
    const newInnerWidth = value - (this.margin * 2 + this.padding.x)
    this.innerSize = new vec2(newInnerWidth, this.innerSize.y)
  }

  /**
   * Gets the height of the frame layout in local space centimeters.
   * @returns The current height of the frame.
   */
  public get height(): number {
    return this.totalSize.y
  }

  /**
   * Sets the height of the frame.
   * @param value - The new height value.
   */
  public set height(value: number) {
    const newInnerHeight = value - (this.margin * 2 + this.padding.y)
    this.innerSize = new vec2(this.innerSize.x, newInnerHeight)
  }

  /**
   * Gets the depth of the frame layout in local space centimeters.
   * @returns The current depth of the frame.
   */
  public get depth(): number {
    return 1
  }

  /**
   * Sets the depth of the frame.
   * This is a no-op as depth is not configurable for 2D components.
   * @param value - The new depth value (ignored).
   */
  public set depth(value: number) {
    // No-op, depth is not configurable for 2D component
  }

  /**
   * Gets the current size of the layout as a vec3 (width, height, depth).
   * @returns The layout size with width, height, and depth.
   */
  public get layoutSize(): vec3 {
    return new vec3(this.width, this.height, this.depth)
  }

  /**
   * Gets whether this frame is initialized.
   * @returns True if the frame is initialized, false otherwise.
   */
  public get initialized(): boolean {
    return this._loop.initialized
  }

  private initializeVisuals() {
    // Chrome subtree: shadow, drawer, and body live under a Canvas with
    // Hierarchy sorting so their draw order is structural (child order:
    // shadow -> drawer -> body -> buttons) instead of depth/renderOrder
    // driven. Content stays outside the canvas (sibling of chrome) so
    // arbitrary 3D content keeps its normal depth behavior.
    this._refs.chrome = global.scene.createSceneObject("FrameChrome")
    this._refs.chrome.layer = this.sceneObject.layer
    this._refs.chrome.setParent(this.sceneObject)
    this._refs.managedSceneObjects.push(this._refs.chrome)
    this._refs.canvasController = new CanvasController(this._refs.chrome, {allowInherited: false})
    this._refs.canvasController.ensure(new vec2(this.totalSize.x, this.totalSize.y))

    // Child order under chrome IS the draw order. The shadow and drawer hosts
    // are created first (even when unused — they're empty SceneObjects) so a
    // runtime `hasShadow = true` or drawer slide never needs reordering.
    // Coplanar with the body (no -z nudge): the canvas's hierarchy sorting
    // owns the draw order and the shadow doesn't write depth, so a z offset
    // would only add stereo parallax (the shadow visibly floating behind the
    // panel on device).
    this._refs.shadowHost = global.scene.createSceneObject("FrameShadow")
    this._refs.shadowHost.layer = this.sceneObject.layer
    this._refs.shadowHost.setParent(this._refs.chrome)

    this._refs.drawerHost = global.scene.createSceneObject("FrameDrawerHost")
    this._refs.drawerHost.layer = this.sceneObject.layer
    this._refs.drawerHost.setParent(this._refs.chrome)

    this._refs.frameVisual = this.createFrameVisual()
    this._refs.frameObject = this._refs.frameVisual.initialize(this._refs.chrome, this.sceneObject.layer)
    this._refs.frameVisual.setSize(this.innerSize)
    if (this._hasShadow) {
      this.buildShadow()
    }
    this.cutOutCenter = this._cutOutCenter
    this.cutOutFeather = this._cutOutFeather
  }

  /**
   * Parent for the RightDrawer's root object: a chrome child that sorts
   * BEFORE the body, so the tucked drawer is occluded by the panel under the
   * canvas's hierarchy sorting (depth no longer decides). Shares the body's
   * transform space — both are identity children of the chrome root.
   */
  public get drawerParent(): SceneObject {
    return this._refs.drawerHost ?? this._refs.frameObject
  }

  /**
   * Create the DropShadow on the (already ordered) shadow host and style it
   * from the theme's Frame parameters. Idempotent; the component stays alive
   * once built — visibility is driven by refreshShadowEnabled().
   */
  private buildShadow(): void {
    if (this._refs.shadow || isNull(this._refs.shadowHost) || !this._refs.shadowHost) {
      return
    }
    const params = this.getFrameParams()
    const shadow = this._refs.shadowHost.createComponent(DropShadow.getTypeName())
    // Explicit init: createComponent defers onAwake while the hierarchy is
    // disabled (e.g. hasShadow enabled on a hidden frame), and the lines
    // below touch renderMeshVisual synchronously.
    shadow.initialize()
    shadow.color = params.shadowColor
    shadow.blur = params.shadowBlur
    shadow.spreadRadius = params.shadowSpread
    shadow.offset = new vec2(params.shadowOffset.x, params.shadowOffset.y)
    shadow.size = new vec2(this.totalSize.x, this.totalSize.y)
    shadow.cornerRadius = this.cornerRadius
    // Neutral renderOrder: chrome layering is the canvas's hierarchy order
    // (shadow host is the first chrome child). No depth writes — a translucent
    // layer at the back must not punch depth holes into content behind the frame.
    shadow.renderOrder = this.renderOrder
    shadow.renderMeshVisual.mainPass.depthWrite = false
    shadow.opacity = this._visual.opacity
    this._refs.shadow = shadow
    this.refreshShadowEnabled()
  }

  /**
   * The shadow renders only while it's enabled, the body is enabled, and no
   * center cutout is active (a solid shadow would show through the hole).
   */
  private refreshShadowEnabled(): void {
    const host = this._refs.shadowHost
    if (!host || isNull(host)) {
      return
    }
    host.enabled = this._hasShadow && !this._cutOutCenter && this._visual.bodyEnabled
  }

  /**
   * Single funnel for body-visual enable state: drives the FrameVisual and
   * keeps the shadow mirrored to it.
   */
  private setBodyVisualsEnabled(enabled: boolean): void {
    this._visual.bodyEnabled = enabled
    this._refs.frameVisual.setEnabled(enabled)
    this.refreshShadowEnabled()
  }

  private initializeCollider() {
    this._refs.colliderShape = Shape.createBoxShape()
    this._refs.colliderShape.size = new vec3(this.innerSize.x, this.innerSize.y, 1)
    this._refs.collider.shape = this._refs.colliderShape
    this._refs.collider.fitVisual = false
  }

  private initializeContent() {
    this._refs.transform = this.sceneObject.getTransform()
    this._refs.content = global.scene.createSceneObject("content")
    this._refs.managedSceneObjects.push(this._refs.content)
    this._refs.content.layer = this.sceneObject.layer
    this._refs.contentTransform = this._refs.content.getTransform()
    // Move any existing children of sceneObject into `content` so they're grouped
    // under the frame for unified transform/visibility. Runs BEFORE initializeVisuals
    // so the frame's own SceneObject isn't swept up.
    this.sceneObject.children.forEach((child: SceneObject) => {
      child.setParent(this._refs.content)
    })
  }

  private initializeHandlers() {
    this._refs.buttonHandler = new ButtonHandler({
      frame: this,
      onButtonTriggerUp: () => {
        this._interactionState.input.pinching = false
      }
    })
    this._refs.rightDrawer = new RightDrawer({frame: this, initialVisible: false})
    this.showCloseButton = this._showCloseButton
    // The setter binds setFollowing when the button is freshly created; no
    // separate onTriggerUp wiring needed here.
    this.showFollowButton = this._showFollowButton
    // First push of the border-only body: applies the authored margin setting
    // plus any hideBody request made before the visual existed.
    this.applyBorderOnly()
  }

  private initializeBillboard() {
    this._refs.billboardComponent = this.useBillboarding
      ? this.sceneObject.createComponent(Billboard.getTypeName())
      : null
    if (this.billboardComponent !== null) {
      this._refs.managedComponents.push(this.billboardComponent)
      this.billboardComponent.xAxisEnabled = this.xAlways
      this.billboardComponent.yAxisEnabled = this.yAlways
      this.refreshAxisBufferDegrees()
      this.billboardComponent.axisBufferDegrees = this._refs.axisBufferDegrees
      this.billboardComponent.axisEasing = this._refs.axisEasing
    }
  }

  private initializeInteractionPlane() {
    this._refs.interactionPlane = this.sceneObject.createComponent(InteractionPlane.getTypeName())
    this._refs.managedComponents.push(this._refs.interactionPlane)
    this._refs.interactionPlane.nearFieldDepth = FrameConstants.nearFieldInteractionZoneDistance
    this._refs.interactionPlane.targetingVisual = this.targetingVisual
    this._refs.interactionPlane.enabled = this.interactionPlaneEnabled
    this._refs.interactionPlaneTransform = this._refs.interactionPlane.getTransform()
    this.updateInteractionPlane()
  }

  private initializeHoverBehavior() {
    this._refs.hoverBehavior = new HoverBehavior(this._refs.interactable)
    this.hideCursorHighlight()
    this._refs.unsubscribes.push(
      // Wake the gated LateUpdateEvent on every request edge. HoverBehavior
      // fires onRequestChange when a raw Interactable event flips an entry's
      // requested-active state (enter, exit, implicit enter via hover-update,
      // trigger-finished off-frame) — all delivered by the InteractionManager
      // independently of Frame's parked events. The flip is already applied
      // when this runs, so the refresh sees !isSettled and enables lateUpdate
      // to deliver the signal. Covers a hover-exit (or off-frame release)
      // during the InactiveToActive debounce: without it the request is never
      // delivered and the entry's SM completes to a phantom hoverStart for a
      // hand that already left.
      this._refs.hoverBehavior.onRequestChange.add(() => this.refreshPerFrameActive())
    )
    this._refs.unsubscribes.push(
      this.hoverBehavior.onHoverStart.add((e: InteractorEvent) => {
        this.addCursorForInteractor(e.interactor)
        if (this.autoShowHide || this.isPanelFrame) this.showVisual()
        if (!this.grabZoneOnly) this.showCursorHighlight()
        // Hovered visual only when the frame ITSELF is targeted — hovering a
        // nested child interactable must not light the frame highlight. Live
        // read (not e.target): HoverBehavior replays stale events between real
        // deliveries.
        this.updateFrameBodyHover(e.interactor)
        this._interactionState.input.hovered = true
        this._interactionState.input.hierarchyHovered = true
      }),
      this.hoverBehavior.onHoverUpdate.add((e: InteractorEvent) => {
        // Registration retry: getCursorByInteractor can return null at
        // hover-start (hand tracking still settling), leaving this interactor
        // without a cursor entry — and therefore without Translate/Scale
        // hints — for its entire hover. Retry until it succeeds.
        this.addCursorForInteractor(e.interactor)

        const targetObject = e && !isNull(e.target) ? e.target.sceneObject : undefined
        if (e.interactor.targetHitInfo) this.computeHitPosition(e.interactor)

        const hoveringContent =
          targetObject !== this.sceneObject &&
          targetObject !== this._refs.buttonHandler.closeButton?.sceneObject &&
          targetObject !== this.followButton?.sceneObject
        const isNearField =
          (e.interactor.inputType & InteractorInputType.BothHands) !== 0 &&
          !(e.interactor as HandInteractor).isFarField()

        this.updateCursorRadiusAndGlow(e)
        this.updateGrabZoneHighlight(hoveringContent)
        this.updateContentHover(hoveringContent, isNearField)
        // Per-frame body-hover sync lives HERE (not only in updateCursorMode):
        // hover updates fire per hovering hand regardless of whether its
        // cursor has registered, so the hovered visual can't get stuck during
        // the hand-tracking settle window.
        this.updateFrameBodyHover(e.interactor)
        // Global slot only (manipulator-view gates in getInputMode and the
        // inner-hover visuals). The per-interactor cursor gate reads
        // `interactor.currentInteractable` live in updateCursorMode().
        this._interactionState.input.innerInteractableActive = targetObject !== this.sceneObject
      }),
      this.hoverBehavior.onHoverEnd.add((e: InteractorEvent) => {
        this._bodyHoverInteractors.delete(e.interactor)
        this.applyFrameBodyHover(this._bodyHoverInteractors.size > 0)
        this.removeCursorForInteractor(e.interactor)
        this.clearGlobalHoverStateIfEmpty()
      })
    )
  }

  /**
   * Reset every registered cursor to Auto and drop all per-interactor
   * tracking. Used when the frame stops participating in interaction
   * entirely (disable / destroy) — cursors are global objects owned by the
   * CursorController and would otherwise keep the frame's last mode.
   */
  private resetAllCursors() {
    for (const cursor of this._interactorCursors.values()) {
      if (cursor != null) {
        cursor.cursorMode = CursorMode.Auto
      }
    }
    this._interactorCursors.clear()
    this._interactorPositions.clear()
    this._interactorOffHierarchyFrames.clear()
    this._bodyHoverInteractors.clear()
    this.applyFrameBodyHover(false)
  }

  /**
   * Change-gated write of the frame's hovered visual (System3 green border).
   * Kept in a Frame-side cache so the per-frame sync in updateCursorMode()
   * costs a boolean compare on no-change frames.
   */
  /**
   * Track one interactor's LIVE body targeting and refresh the hovered visual.
   * Membership is per-interactor so two hands (one on the body, one on a
   * nested child) resolve to the OR of their targeting.
   */
  private updateFrameBodyHover(interactor: Interactor) {
    if (interactor.currentInteractable === this._refs.interactable) {
      this._bodyHoverInteractors.add(interactor)
    } else {
      this._bodyHoverInteractors.delete(interactor)
    }
    this.applyFrameBodyHover(this._bodyHoverInteractors.size > 0)
  }

  private applyFrameBodyHover(hovered: boolean) {
    if (this._frameBodyHovered === hovered) return
    this._frameBodyHovered = hovered
    this._refs.frameVisual.setFrameHovered(hovered)
  }

  /**
   * Run the frame-wide un-hover side effects once NO interactor remains
   * registered. Shared between the event-driven path (onHoverEnd) and the
   * per-frame reconciliation in updateCursorMode() — both must produce the
   * same end state regardless of which one noticed the exit first.
   */
  private clearGlobalHoverStateIfEmpty() {
    if (this._interactorCursors.size !== 0) return
    if (this.autoShowHide || this.isPanelFrame) this.hideVisual()
    this.hideCursorHighlight()
    this._bodyHoverInteractors.clear()
    this.applyFrameBodyHover(false)
    this._interactionState.input.hovered = false
    this._interactionState.input.hierarchyHovered = false
    this._interactionState.input.innerInteractableActive = false
    // This can run from onHoverEnd (in lateUpdate, after update() already ran
    // this frame) and is the frame on which the loop idles — so flush the two
    // transitions update() would otherwise never get to run: the inner-
    // interactable exit and the pinch border reset. Both are guarded no-ops if
    // already settled. Then idle the gated loop.
    this.updateInnerInteractableHover()
    this.updatePinchVisuals()
    this.refreshPerFrameActive()
  }

  private initializeInteractionEvents() {
    this._refs.unsubscribes.push(
      this._refs.interactable.onInteractorTriggerStart.add((e: InteractorEvent) => {
        const targetObject = e?.target.sceneObject
        if (targetObject !== this.sceneObject) {
          // Triggers on inner children flow through to those children — Frame
          // doesn't update its own gesture state.
          return
        }

        const priorState = this._interactionState.trigger
        const nextState = triggerStateOnStart(priorState, e.interactor)
        // A runtime enable can be deferred while another gesture is active.
        // Install/remove the behavior while still in the idle state so IK's
        // manipulation root is stable for the whole gesture.
        if (priorState.kind === "idle") this.syncDepthBehavior()
        this._interactionState.trigger = nextState

        if (priorState.kind === "idle" && nextState.kind === "single") {
          // First triggerer — entering single-hand mode.
          const hitLocal = this.computeHitPosition(e.interactor).localPosition
          this._interactionState.dragStart = new vec3(hitLocal.x, hitLocal.y, 0)
          const depthAnchor = e.interactor.targetHitInfo?.localHitPosition ?? new vec3(hitLocal.x, hitLocal.y, 0)
          this._depth.behavior?.beginGesture(depthAnchor)
          this._interactionState.input.pinching = true
          // pinching is a perFrameActive() term, and a trigger can land in the
          // brief window where a hand hovers but its cursor hasn't registered
          // yet (loop still parked) — wake explicitly so update() observes the
          // pinch this frame rather than relying on the cursor-registration
          // backstop. Idempotent when already awake.
          this.refreshPerFrameActive()

          // Re-classify the gesture from THIS hand's own position. _inputMode
          // freezes once pinching=true (getInputMode only runs when idle), but
          // its pre-pinch value came from whichever hovering hand wrote the
          // shared _inputState.position last — with two hands on different
          // zones, that's a coin flip. Without this, the gesture can
          // contradict the cursor: this hand's cursor showed Scale (derived
          // from its own position) while the frozen global said Translating
          // (the other hand's zone), or vice versa. The same snapshot also
          // fixes _isInZone and the manipulator's locked cursor visual
          // (_cursorMode derives from _inputMode in updateInput).
          const ownPosition = this._interactorPositions.get(e.interactor)
          if (ownPosition !== undefined) {
            const cfg = this.buildClassificationConfig()
            this._interactionState.isInZone = isPositionInZone(ownPosition, cfg)
            this._interactionState.inputMode = computeInputModeFromPositionPure(ownPosition, cfg)
          }

          if (e.interactor.targetHitInfo) {
            const initialHit = e.interactor.targetHitInfo.localHitPosition
            const worldHitPosition = targetObject.getTransform().getWorldTransform().multiplyPoint(initialHit)
            if (this.billboardComponent !== null) {
              this.billboardComponent.setPivot(
                this.billboardComponent.targetTransform.getInvertedWorldTransform().multiplyPoint(worldHitPosition),
                e.interactor
              )
            }
          }
        } else if (priorState.kind === "single" && nextState.kind === "dual") {
          // If the primary is mid corner-scale, the second hand is a no-op:
          // don't cancel the scale and don't enter dual mode. Two-hand scale
          // is out of scope for now. Revert _triggerState so isDualGrab stays
          // false and Manipulate continues under hand A alone (canTranslate
          // is already false during scale, so hand B's per-interactor entry
          // into Manipulate doesn't drive a dual translate).
          if (this._interactionState.scaling) {
            this._interactionState.trigger = priorState
            return
          }

          // CRITICAL: clear the billboard pivot for the duration of dual-grab.
          //
          // While a pivot is set, BillboardController calls
          // InteractableManipulation.updateStartTransform() EVERY FRAME (its
          // single-hand 1:1 re-baseline hack). That method is hard-coded to
          // interactors[0]: it recomputes hitPointToTransform against hand A's
          // anchor alone. Manipulate's dualInteractorsTransform then adds that
          // baseline to the MIDPOINT of both hands, displacing the frame by
          // ~half the inter-hand distance — and Billboard re-baselines from the
          // displaced position next frame. Runaway loop ≈ 15 cm/frame: the
          // "frame flies away on second pinch" bug.
          //
          // resetPivotPoint() zeroes the pivot AND nulls the controller's
          // manipulationComponent reference, stopping the per-frame clobber.
          // Manipulate's own dual baseline (set via ChangeInteractors →
          // updateStartValues) then drives translate-to-midpoint correctly.
          // The dual → single hand-off (handleTriggerEnd) re-sets the pivot to
          // the remaining hand, restoring the single-hand 1:1 behavior.
          //
          // Proper upstream fix: make updateStartTransform() dual-aware in IK.
          if (this.billboardComponent !== null) {
            this.billboardComponent.resetPivotPoint()
          }
          this._depth.behavior?.setAnchorLocal(this.getDepthAnchorLocal([nextState.primary, nextState.secondary]))
        }
      }),
      this._refs.interactable.onTriggerUpdate.add((event: InteractorEvent) => {
        if (this.isDualGrab) {
          // No billboard pivot writes during dual-grab — see the dual-entry
          // branch in onTriggerStart for why (Billboard's per-frame
          // updateStartTransform() re-baseline is single-hand-only and fights
          // Manipulate's dual transform).
          return
        }

        // Only the primary manipulator drives scale-tracking. Secondary's
        // update events still flow (Manipulate consumes them), but Frame
        // ignores them here.
        if (event.interactor !== this.currentInteractor) return
        if (event.interactor.targetHitInfo && this._interactionState.scaling) {
          const dragPos = this.computeHitPosition(event.interactor).localPosition
          const sizeDelta = new vec2(
            (dragPos.x - this._interactionState.dragStart.x) * Math.sign(this._interactionState.dragStart.x) * 2,
            (dragPos.y - this._interactionState.dragStart.y) * Math.sign(this._interactionState.dragStart.y) * 2
          )
          if (this.allowNonUniformScaling) {
            const newSizeX = this.scalingSizeStart.x + sizeDelta.x
            const newSizeY = this.scalingSizeStart.y + sizeDelta.y
            this.innerSize = new vec2(
              MathUtils.clamp(newSizeX, this.minimumSize.x, this.maximumSize.x),
              MathUtils.clamp(newSizeY, this.minimumSize.y, this.maximumSize.y)
            )
          } else {
            const dragScale = 1 + Math.max(sizeDelta.x / this.scalingSizeStart.x, sizeDelta.y / this.scalingSizeStart.y)
            const minScale = Math.max(
              this.minimumSize.x / this.scalingSizeStart.x,
              this.minimumSize.y / this.scalingSizeStart.y
            )
            const maxScale = Math.min(
              this.maximumSize.x / this.scalingSizeStart.x,
              this.maximumSize.y / this.scalingSizeStart.y
            )
            this.innerSize = this.scalingSizeStart.uniformScale(MathUtils.clamp(dragScale, minScale, maxScale))
          }
        }
      })
    )

    const handleTriggerEnd = (e: InteractorEvent) => {
      const priorState = this._interactionState.trigger
      const nextState = triggerStateOnEnd(priorState, e.interactor)
      this._interactionState.trigger = nextState

      if (priorState.kind === "single" && nextState.kind === "idle") {
        // Lone manipulator released — full reset.
        this._interactionState.input.pinching = false
        const correctionEndedFromPendingConfig = this._depth.behavior?.endGesture() === true
        this.syncDepthBehavior()
        if (correctionEndedFromPendingConfig) this._follow.smooth?.recaptureRestTarget()
        this.refreshDepthScaling()
      } else if (priorState.kind === "dual" && nextState.kind === "single") {
        // One of the two released. Promote the remaining interactor to single-
        // hand manipulator and rebase the drag anchor so any future scale-
        // tracking starts from the remaining hand's current position (no snap).
        const remaining = nextState.primary
        if (remaining.targetHitInfo) {
          const hitLocal = this.computeHitPosition(remaining).localPosition
          this._interactionState.dragStart = new vec3(hitLocal.x, hitLocal.y, 0)

          // Restore billboard pivot to the remaining hand's position.
          const initialHit = remaining.targetHitInfo.localHitPosition
          this._depth.behavior?.setAnchorLocal(initialHit)
          const targetObject = this._refs.interactable.sceneObject
          const worldHitPosition = targetObject.getTransform().getWorldTransform().multiplyPoint(initialHit)
          if (this.billboardComponent !== null) {
            this.billboardComponent.setPivot(
              this.billboardComponent.targetTransform.getInvertedWorldTransform().multiplyPoint(worldHitPosition),
              remaining
            )
          }
        }
        // _inputState.pinching stays true — gesture continues under the remaining hand.
      }
    }
    // Use per-interactor tiers for end+endOutside so hand-#2 release fires
    // the dual→single transition. The aggregate onTrigger* events are gated by
    // _triggeringInteractor === None in InteractableEventHandler — they only
    // fire when the LAST hand releases, which would leave dual→single dead.
    // onTriggerCanceled is already per-hand (no aggregate gate in
    // triggerCanceled()), so it stays as-is.
    this._refs.unsubscribes.push(
      this._refs.interactable.onInteractorTriggerEnd.add(handleTriggerEnd),
      this._refs.interactable.onInteractorTriggerEndOutside.add(handleTriggerEnd),
      this._refs.interactable.onTriggerCanceled.add(handleTriggerEnd)
    )
  }

  /** Average available Frame-local hit points for a stable dual-hand anchor. */
  private getDepthAnchorLocal(interactors: Interactor[]): vec3 {
    let anchor = vec3.zero()
    let count = 0
    for (const interactor of interactors) {
      const localHit = interactor.targetHitInfo?.localHitPosition
      if (!localHit) continue
      anchor = anchor.add(localHit)
      count++
    }
    return count > 0 ? anchor.uniformScale(1 / count) : vec3.zero()
  }

  /**
   * Item snapping reparents this Frame under its snap target mid-tween, which
   * the depth behaviors do not support: the clamp's release spring would
   * fight the snap tween for the frame's pose, and the mid-tween reparent /
   * deparent churn sits outside the depth-scaling ownership model. (Reparent
   * scale compensation itself is baseline-preserving now — see
   * DepthScaling.adoptExternalScale — but the combination stays unsupported.)
   */
  private get itemSnappingActive(): boolean {
    return this.useSnapping && this.itemSnapping
  }

  /**
   * Forward live clamp settings to a released correction before structural
   * behavior cleanup. A synchronously canceled/completed correction also
   * releases the update-loop and follow pose authority immediately.
   */
  private applyDepthClampingConfigurationChange(): void {
    const correctionEnded = this._depth.behavior?.onClampingConfigurationChanged() === true
    this.syncDepthBehavior()
    if (!correctionEnded) return

    this._follow.smooth?.recaptureRestTarget()
    this.refreshPerFrameActive()
  }

  /**
   * Create or remove the optional depth behavior only between gestures. This
   * keeps InteractableManipulation's root stable while its cached baselines are
   * active. Together with DepthBehavior's per-gesture eligibility latches,
   * enabling mid-gesture never affects the gesture in flight — even when the
   * shared driver already exists for the other behavior. Disabling is honored
   * immediately by the config but cleanup is deferred.
   */
  private syncDepthBehavior(): void {
    if (!this._refs.manipulate || !this._refs.transform) return

    // Enforce the item-snapping exclusion (see itemSnappingActive) on
    // serialized inputs that arrive with both enabled; depth loses. The
    // public setters refuse runtime enables, and item snapping itself is
    // fixed once the SnappingHandler is created, so this cannot re-trigger.
    if ((this._useDepthClamping || this._useDepthScaling) && this.itemSnappingActive) {
      log.w(
        "Depth clamping/scaling are not supported together with item snapping; " +
          "disabling depth behaviors on this Frame. Disable Item Snapping to use them."
      )
      this._useDepthClamping = false
      this._useDepthScaling = false
    }

    if (this._useDepthScaling && !this._depth.scalingSuspended) {
      if (this._depth.scaling === null) {
        this._depth.scaling = new DepthScaling({
          sceneObject: this.sceneObject,
          transform: this.transform,
          getMinimumDepth: () => this._depthScalingMinimumDepth,
          getMaximumDepth: () => this._depthScalingMaximumDepth,
          getMinimumScale: () => this._depthScalingMinimumScale,
          getMaximumScale: () => this._depthScalingMaximumScale
        })
      }
    } else if (!this._useDepthScaling && this._depth.scaling !== null && !this._depth.scalingSuspended) {
      this._depth.scaling.destroy()
      // Keep the reset factor observable until an active manipulation ends;
      // the raw driver still has the scale captured at gesture start.
      if (this.currentInteractor === null) this._depth.scaling = null
    }

    // Changing Manipulate's root while a gesture is active invalidates IK's
    // cached baselines, so structural driver changes wait for the next idle.
    if (this.currentInteractor !== null || this._depth.behavior?.isAnimating === true) return

    if (this._useDepthClamping || this._useDepthScaling) {
      if (this._depth.behavior === null) {
        this._depth.behavior = new DepthBehavior({
          frameObject: this.sceneObject,
          frameTransform: this.transform,
          manipulation: this._refs.manipulate,
          getClampingEnabled: () => this._useDepthClamping,
          getMinimumDepth: () => this._minimumDepth,
          getMaximumDepth: () => this._maximumDepth,
          getDepthScaling: () => (this._useDepthScaling ? this._depth.scaling : null),
          getAppliedScaleFactor: () => this._depth.scaling?.scaleFactor ?? 1
        })
      }
    } else if (this._depth.behavior !== null) {
      this._depth.behavior.destroy()
      this._depth.behavior = null
    }
  }

  private initializeLifecycleEvents() {
    this.createEvent("OnEnableEvent").bind(() => {
      this.syncDepthBehavior()
      this.refreshDepthScaling()
      // The refresh above covers reposition-before-enable; the deferred
      // lateUpdate pass covers enable-before-reposition. It lands on the first
      // lateUpdate the engine runs after this callback — end of this frame at
      // best, the next frame when a script enables us mid-Update (measured: one
      // rendered frame at the pre-reposition scale). Either way the pass
      // measures the final pose; only the latency varies.
      this._depth.pendingEnableRefresh = true
      this.setBodyVisualsEnabled(this._visual.isVisible)
      this._refs.buttonHandler?.setRuntimeEnabled(true)
      // Re-derives the same policy setInteractionSuppressed applies, so a
      // disable/enable cycle in the middle of a suppressed window (a mode
      // transition, say) cannot silently restore interaction. This subsumes the
      // plain managedComponents re-enable loop it replaced: same per-component
      // policy, but it also honors a runtime interactionPlaneEnabled override
      // and cannot punch open a suppressed window.
      this.applyInteractionSuppression()
      // Re-derive the gated loop from live state on re-enable rather than
      // relying on the updateEvent/lateUpdateEvent.enabled flags surviving the
      // disable. (A re-enabled frame is idle until re-hovered; the raw
      // hover-enter wakes it — but if `following`/`forceTranslate` persisted
      // across the disable, this resumes the loop immediately.)
      this.refreshPerFrameActive()
    })
    this.createEvent("OnDisableEvent").bind(() => {
      // Cursors are owned by the CursorController and outlive this frame —
      // release them BEFORE disabling components, or a frame disabled
      // mid-hover strands its cursors on the last written mode. Then run the
      // frame-wide un-hover side effects so hover visuals don't survive a
      // disable mid-hover and reappear stale on re-enable.
      // Settle (not just end) any depth correction: the update loop stops
      // while disabled, and a stranded spring would teleport the frame to its
      // stale release-time pose on re-enable.
      this._depth.behavior?.settleNow()
      // While suspended, FocusFrame owns the frame's scale and this instance
      // holds the only copy of the authored baseline. Destroying it here would
      // stomp the docked scale, and resumeDepthScaling would then adopt the
      // factor-included restore as a new baseline — permanently baking in the
      // old depth factor. Keep the suspended instance; resume owns its fate.
      if (!this._depth.scalingSuspended) {
        this._depth.scaling?.destroy()
        this._depth.scaling = null
      }
      this.resetAllCursors()
      this.clearGlobalHoverStateIfEmpty()
      this._refs.buttonHandler.setRuntimeEnabled(false)
      this._refs.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.enabled = false
        }
      })
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      this.resetAllCursors()
      this._depth.behavior?.destroy()
      this._depth.behavior = null
      this._depth.scaling?.destroy()
      this._depth.scaling = null
      this._refs.hoverBehavior?.destroy()
      this._refs.unsubscribes.forEach((u) => u())
      this._refs.unsubscribes = []
      // Motion cleanup replaces the legacy CancelSets: the retained panel
      // fade, the highlight timeline, and the squeeze handle (keyed on this).
      if (this.panelAlphaWriter !== null) Motion.killTweensOf(this.panelAlphaWriter)
      this.cursorHighlightTimeline?.kill()
      this.cursorHighlightTimeline = null
      this.spawnTimeline?.kill()
      this.spawnTimeline = null
      this.resumeFollowAfterSpawn()
      // release() closes any open blend window and gives back the group's
      // slot in VisibilityGroup's module registry plus its cached renderable
      // references — destroyed frames that ever spawned would retain both.
      this.spawnContentGroup?.release()
      this.spawnContentGroup = null
      Motion.killTweensOf(this)
      this._refs.snappingHandler?.destroy()
      this._follow.cleanup?.()
      this._follow.smooth = null
      this._refs.buttonHandler?.destroy()
      this._refs.rightDrawer?.destroy()
      this._refs.canvasController?.release()
      this._refs.canvasController = null
      this._refs.shadow = null
      this._refs.frameVisual.destroy()
      // Reparenting under a dying object throws, and isBeingDestroyed propagates to
      // descendants before OnDestroyEvent, so a dying child is covered by its own check.
      if (!isNull(this._refs.content) && !this.sceneObject.isBeingDestroyed) {
        this._refs.content.children.forEach((child) => {
          if (!child.isBeingDestroyed) child.setParent(this.sceneObject)
        })
      }
      this._refs.managedComponents.forEach((c) => {
        if (!isNull(c) && c) c.destroy()
      })
      this._refs.managedComponents = []
      this._refs.managedSceneObjects.forEach((o) => {
        if (!isNull(o) && o) o.destroy()
      })
      this._refs.managedSceneObjects = []
    })
    const updateEvent = this.createEvent("UpdateEvent")
    updateEvent.bind(this.update.bind(this))
    // Start idle; the wake edges (cursor add / setFollowing / forceTranslate /
    // gesture start) enable it. The final refresh below picks up anything
    // already active at init (e.g. following set during onStart).
    updateEvent.enabled = false
    this._loop.updateEvent = updateEvent
    // LateUpdateEvent is gated too: it pumps HoverBehavior, but only needs to
    // run while update() is active or a hover-start/end signal is pending. From
    // idle it is woken by the raw Interactable hover-enter (see
    // initializeHoverBehavior), which the InteractionManager fires independently
    // of these events — so detection never depends on this being enabled.
    const lateUpdateEvent = this.createEvent("LateUpdateEvent")
    lateUpdateEvent.bind(this.lateUpdate.bind(this))
    lateUpdateEvent.enabled = false
    this._loop.lateUpdateEvent = lateUpdateEvent
    this.refreshPerFrameActive()
  }

  /**
   * True while the Frame has real per-frame work: a registered cursor (hover or
   * pending reap), translating, scaling, following, force-translating, or
   * pinching. When false, update() is idle and its UpdateEvent is disabled.
   * Evaluated LIVE each tick (update() re-checks at the end) so the loop
   * self-settles one frame after the
   * last active term clears; rising edges reachable while the loop is OFF call
   * refreshPerFrameActive() to wake it.
   *
   * `_interactorCursors.size > 0` is mandatory — updateCursorMode() reaps a
   * stranded cursor (missed hover-end) only by running, and the hovered=false
   * flip itself depends on that reaper, so gating on `hovered` alone would
   * deadlock. `pinching` keeps the loop alive for updatePinchVisuals' border
   * reset on release.
   */
  private perFrameActive(): boolean {
    // Wake-edge map — each term, and where it re-enables the loop while it's OFF
    // (refreshPerFrameActive). In-loop terms need no wake: update()'s end-of-tick
    // refresh keeps the loop alive until they clear, then idles it.
    return (
      this._interactorCursors.size > 0 || // wake: addCursorForInteractor (hover-start / onHoverUpdate retry)
      this._interactionState.translating || // in-loop: handleInputState → setInputTranslating
      this._interactionState.scaling || // in-loop: handleInputState
      this.following || // wake: setFollowing
      this._interactionState.forceTranslate || // wake: forceTranslate setter
      this._depth.behavior?.isAnimating === true || // in-loop: released depth-clamp spring
      this._interactionState.input.pinching // wake: onTriggerStart (single-mode branch)
    )
  }

  /**
   * Enable/disable the gated UpdateEvent and LateUpdateEvent to match current
   * activity. update() runs while perFrameActive(); lateUpdate() runs while
   * update() is active OR HoverBehavior still has a pending hover-start/end
   * signal to deliver (its per-interactor StateMachines finish their debounce
   * on their own events, so once settled lateUpdate has nothing left to pump)
   * OR a one-shot post-enable depth refresh is pending.
   */
  private refreshPerFrameActive(): void {
    const active = this.perFrameActive()
    if (this._loop.updateEvent !== null) {
      this._loop.updateEvent.enabled = active
    }
    if (this._loop.lateUpdateEvent !== null) {
      this._loop.lateUpdateEvent.enabled =
        active || !this._refs.hoverBehavior.isSettled() || this._depth.pendingEnableRefresh
    }
  }

  private update() {
    this.updateInput()
    this.updateCursorMode()
    this.updateInnerInteractableHover()

    if (this._depth.behavior?.update()) {
      this.syncDepthBehavior()
      // The spring settled this tick; follow resumes below — re-derive its
      // rest target from the corrected pose, not the stale release pose.
      this._follow.smooth?.recaptureRestTarget()
    }
    if (this._interactionState.translating) this._refs.snappingHandler?.update()
    // The released clamp spring is the pose authority while it animates
    // (<= 0.35s); follow resumes on the settle tick above.
    if (this.following && !this._follow.suspended && this._depth.behavior?.isAnimating !== true) {
      this._events.followUpdate?.invoke()
      // Origin-based refresh only while no grab owns the pose. During a grab
      // DepthBehavior owns scale (anchor-based, per-gesture eligibility): a
      // mid-grab enable leaves DepthScaling's lastWorldPosition stale while
      // the hand keeps moving the frame, so this delta check would apply
      // scale immediately and bypass the eligibility latch. The
      // _useDepthScaling gate keeps a mid-gesture disable's
      // destroyed-but-referenced instance from applying from here.
      if (this._useDepthScaling && this.currentInteractor === null) {
        this._depth.scaling?.refreshAfterMovement()
      }
    }

    this.updateBillboardState(this._interactionState.translating)
    this.updatePinchVisuals()
    if (DEBUG_DRAW) this.debugDraw()

    // In-loop transitions (gesture/translate/scale end) ran their frame above;
    // idle the loop now if nothing remains active.
    this.refreshPerFrameActive()
  }

  private syncSmoothFollowTiltConfig(): void {
    this._follow.smooth?.setTilt(this._useTiltMode, this._tiltUpThreshold, this._tiltDownThreshold)
  }

  private updateInnerInteractableHover() {
    const shouldSlide = this.autoShowHide || this.isPanelFrame
    if (this._interactionState.input.innerInteractableActive && !this._interactionState.hoveringInnerInteractableLast) {
      if (shouldSlide) this.tweenOpacity(this._visual.opacity, 1)
      this._events.hoverEnterInnerInteractable?.invoke()
    } else if (
      !this._interactionState.input.innerInteractableActive &&
      this._interactionState.hoveringInnerInteractableLast
    ) {
      if (this._interactionState.input.hierarchyHovered && shouldSlide) this.tweenOpacity(this._visual.opacity, 1)
      this._events.hoverExitInnerInteractable?.invoke()
    }
    this._interactionState.hoveringInnerInteractableLast = this._interactionState.input.innerInteractableActive
  }

  private updateBillboardState(isTranslating: boolean) {
    // While follow is suspended (a field inside this frame is docked to the keyboard), the
    // frame's world rotation is driven by the focus-frame anchor. Keep billboard axes off so
    // xAlways/yAlways billboarding can't fight the anchor rotation. Invalidate the applied
    // state so the normal axis config is rewritten once follow resumes.
    if (this._follow.suspended) {
      if (this.billboardComponent !== null) {
        this.billboardComponent.xAxisEnabled = false
        this.billboardComponent.yAxisEnabled = false
      }
      this._interactionState.billboardStateApplied = false
      return
    }
    // Billboard axis config depends only on the translating state, so write the
    // billboard properties only on a transition (or the first apply). The margin
    // squeeze tween below still runs every frame off translatingLastFrame.
    const stateChanged =
      !this._interactionState.billboardStateApplied || isTranslating !== this._interactionState.translatingLastFrame
    if (isTranslating) {
      if (this.billboardComponent !== null && stateChanged) {
        this.billboardComponent.xAxisEnabled =
          (this.xOnTranslate && (this.allowTranslation || this.forceTranslate)) || this.xAlways
        this.billboardComponent.yAxisEnabled =
          (this.yOnTranslate && (this.allowTranslation || this.forceTranslate)) || this.yAlways
        this.billboardComponent.axisBufferDegrees = AXIS_BUFFER_ZERO
      }
      if (!this._interactionState.translatingLastFrame)
        this.tweenMarginSize(this._layout.margin - this._layout.squeezeAmount)
      this._interactionState.translatingLastFrame = true
    } else {
      if (this.billboardComponent !== null && stateChanged) {
        this.billboardComponent.xAxisEnabled = this.xAlways
        this.billboardComponent.yAxisEnabled = this.yAlways
        this.billboardComponent.axisBufferDegrees = this._refs.axisBufferDegrees
        if (this._interactionState.translatingLastFrame) this.billboardComponent.resetPivotPoint()
      }
      if (this._interactionState.translatingLastFrame) this.tweenMarginSize(this._layout.ogMargin)
      this._interactionState.translatingLastFrame = false
    }
    // Latch only once a billboard component exists, so one created later still
    // receives its initial configuration.
    if (this.billboardComponent !== null) {
      this._interactionState.billboardStateApplied = true
    }
  }

  // TODO: drive this off pinch start/end events instead of polling once the
  // rest of the event-driven migration lands.
  private updatePinchVisuals() {
    if (this._interactionState.input.pinching === this._interactionState.pinchingLastFrame) return
    const params = this.getFrameParams()
    this._refs.frameVisual.setActiveState(
      this._interactionState.input.pinching,
      this._interactionState.input.pinching ? params.borderActiveColor : params.borderColor
    )
    this._interactionState.pinchingLastFrame = this._interactionState.input.pinching
  }

  private debugDraw() {
    global.debugRenderSystem.drawBox(
      this.transform.getWorldPosition().sub(new vec3(0, this.totalSize.y * 0.5 - this.margin * 0.5, 0.1)),
      this.margin,
      this.margin,
      0.1,
      marginDebugColor
    )
    global.debugRenderSystem.drawBox(
      this.transform.getWorldPosition().sub(new vec3(this.totalSize.x * 0.5 - this.margin * 0.5, 0, 0.1)),
      this.margin,
      this.margin,
      0.1,
      marginDebugColor
    )
    for (const grabZone of this.grabZones) {
      const worldPos = this.transform.getWorldPosition()
      const bottomLeft = new vec3(grabZone.x, grabZone.y, 0).add(worldPos)
      const topLeft = new vec3(grabZone.x, grabZone.w, 0).add(worldPos)
      const topRight = new vec3(grabZone.z, grabZone.w, 0).add(worldPos)
      const bottomRight = new vec3(grabZone.z, grabZone.y, 0).add(worldPos)
      global.debugRenderSystem.drawLine(bottomLeft, topLeft, debugRed)
      global.debugRenderSystem.drawLine(topLeft, topRight, debugRed)
      global.debugRenderSystem.drawLine(topRight, bottomRight, debugRed)
      global.debugRenderSystem.drawLine(bottomRight, bottomLeft, debugRed)
    }
  }

  private lateUpdate() {
    // Deferred post-enable depth pass: runs on the first lateUpdate after an
    // enable edge, so an app that enabled first and repositioned second is
    // measured at its final pose. That is the end of the enable frame at best —
    // this event is parked while idle, and enabling it from inside the enable
    // callback may not schedule it until the next frame, so a script-driven
    // mid-Update enable can render one frame at the pre-reposition scale. Apps
    // that reposition on a later frame call the public refreshDepthScaling().
    // refreshDepthScaling's ownership guards still win (grab / suspension /
    // released spring), and each of those paths owns its own follow-up refresh,
    // so the flag is consumed rather than retried.
    if (this._depth.pendingEnableRefresh) {
      this._depth.pendingEnableRefresh = false
      this.refreshDepthScaling()
    }
    this.hoverBehavior.lateUpdate()
    // hoverBehavior.lateUpdate() just delivered any pending signals; re-park
    // both events if the Frame is now idle and HoverBehavior has settled.
    this.refreshPerFrameActive()
  }

  private updateInteractionPlane() {
    if (!this._refs.interactionPlane || !this._refs.interactionPlaneTransform) {
      return
    }

    const paddedSize = this.totalSize.add(this._interactionPlanePadding)
    this._refs.interactionPlane.planeSize = paddedSize

    this._refs.interactionPlane.offset = this._interactionPlaneOffset
    this._refs.interactionPlane.targetingVisual = this.targetingVisual
  }

  // _loop.deferLayout: while true, scaleFrame() is a no-op. Set during init so
  // the margin/innerSize/padding/appearance setters don't each trigger a full
  // relayout (collider rebuild, setSize, button/drawer resize, content rescale,
  // frustum bounds, onScalingUpdate/onSizeChanged) — onStart runs one
  // consolidated scaleFrame() at the end instead of ~5 redundant ones.
  private scaleFrame(isTrueScaleUpdate: boolean = true) {
    if (this._loop.deferLayout) return
    // Pre-init size writes (e.g. a parent layout applying width/height before
    // this Frame's OnStartEvent) only store _innerSize — the visuals, handlers,
    // and collider below don't exist yet. OnStart re-applies the stored size
    // through the consolidated scaleFrame at the end of init.
    if (!this._refs.frameVisual) return
    this._refs.frameVisual.setSize(this.totalSize)
    this._refs.canvasController?.setSize(new vec2(this.totalSize.x, this.totalSize.y))
    if (this._refs.shadow) {
      this._refs.shadow.size = new vec2(this.totalSize.x, this.totalSize.y)
    }
    this.updateInteractionPlane()

    this._refs.buttonHandler.resize()
    this._refs.rightDrawer.resize()

    let newZScale = 1
    if (this.autoScaleContent) {
      const factorX = this.innerSize.x / Math.max(this._layout.originalInnerSize.x, 0.001)
      const factorY = this.innerSize.y / Math.max(this._layout.originalInnerSize.y, 0.001)
      newZScale = this.relativeZ ? Math.min(factorX, factorY) : 1
      this.contentTransform.setLocalScale(new vec3(factorX, factorY, newZScale))
    }

    this._refs.colliderShape.size = new vec3(
      this.totalSize.x + this._layout.interactablePadding.x * 2,
      this.totalSize.y + this._layout.interactablePadding.y * 2,
      newZScale
    )
    this._refs.collider.shape = this._refs.colliderShape

    this._refs.frameVisual.setFrustumCullBounds(
      this._refs.colliderShape.size.uniformScale(-0.5),
      this._refs.colliderShape.size.uniformScale(0.5)
    )

    if (isTrueScaleUpdate) {
      this._events.scalingUpdate?.invoke()
      this._events.sizeChanged?.invoke(this.layoutSize)
    }
  }

  /**
   * @param useFollow enable or disable the option to turn on the default follow behavior with the follow button
   */
  public setUseFollow(useFollow: boolean) {
    this.useFollowBehavior = useFollow
    if (useFollow && !this._follow.cleanup) {
      const follow = new SmoothFollow({
        transform: this.transform,
        visibleWidth: this.totalSize.x,
        onFollowUpdate: this.onFollowUpdate,
        onDragStart: this.onTranslationStart,
        onDragEnd: this.onTranslationEnd,
        onScalingStart: this.onScalingStart,
        onScalingEnd: this.onScalingEnd,
        onSizeChanged: this.onSizeChanged,
        tiltEnabled: this._useTiltMode,
        tiltUpThreshold: this._tiltUpThreshold,
        tiltDownThreshold: this._tiltDownThreshold
      })
      this.setFollowBehavior(() => follow.destroy())
      this._follow.smooth = follow
    }
  }

  private createTagAlongBehavior(): void {
    const tagAlong = new TagAlong({
      transform: this.transform,
      onFollowUpdate: this.onFollowUpdate,
      onDragStart: this.onTranslationStart,
      onDragEnd: this.onTranslationEnd,
      onScalingStart: this.onScalingStart,
      onScalingEnd: this.onScalingEnd,
      onSizeChanged: this.onSizeChanged,
      followDistance: this._tagAlongDistance
    })
    this.setFollowBehavior(() => tagAlong.destroy())
    this._follow.tagAlong = tagAlong
  }

  /**
   * Registers a follow behavior cleanup function. Called on Frame destroy.
   */
  public setFollowBehavior(cleanup: (() => void) | null) {
    this._follow.smooth = null
    this._follow.tagAlong = null
    this._follow.cleanup?.()
    this._follow.cleanup = cleanup
  }

  /**
   * Sets whether the frame follows the viewer, and syncs the follow button's toggled state.
   *
   * @param following - True to follow the viewer, false to stop following.
   */
  public setFollowing(following: boolean): void {
    this._following = following
    this.followButton?.toggle(following)
    if (this.following && this.billboardComponent !== null) {
      this.billboardComponent.xAxisEnabled = (this.xOnTranslate && this.allowTranslation) || this.xAlways
      this.billboardComponent.yAxisEnabled = (this.yOnTranslate && this.allowTranslation) || this.yAlways
    }
    // Wrote the billboard axes directly above; mark dirty so updateBillboardState
    // re-applies its own config next tick instead of skipping it.
    this._interactionState.billboardStateApplied = false
    // Wake the gated loop so update() drives followUpdate (and idle it on stop).
    // Programmatic callers (init / useTagAlong) have no hover backstop, so this
    // is the only thing that starts the follow loop.
    this.refreshPerFrameActive()
    this._events.followingChange?.invoke(following)
  }

  /**
   * Temporarily pauses the active follow behavior without changing the user-visible
   * follow mode. While suspended, the per-frame follow update stops firing (pausing
   * SmoothFollow and any other behavior driven by onFollowUpdate) and any TagAlong
   * behavior is paused. The follow button, `following` state, and `onFollowingChange`
   * are left untouched, so `resumeFollow()` restores exactly the prior mode.
   *
   * Used by the focus frame to hold the frame still while a field inside it is docked to
   * the keyboard. Idempotent.
   */
  public suspendFollow(owner: string = "default"): void {
    // Keyed holds, NOT a count. The focus frame and the spawn reveal can
    // overlap (both need follow held), but FocusFrameFollower documents that
    // its onFocusStart/onReturnComplete must be idempotent and calls
    // onFocusStart unconditionally — a rapid refocus during the return tween
    // suspends twice and resumes once. A count would strand follow off for
    // the session; a plain boolean couldn't compose across owners. Keys give
    // both: idempotent per owner, released only when the last one lets go.
    if (this._follow.suspendOwners.indexOf(owner) >= 0) return
    this._follow.suspendOwners.push(owner)
    if (this._follow.suspendOwners.length > 1) return
    this._follow.suspended = true
    this._follow.tagAlong?.pause()
    // Disable billboard axes immediately rather than waiting for updateBillboardState: an
    // idle frame (following === false) has its update loop gated off, so that tick may never
    // run, leaving xAlways/yAlways fighting the focus-frame anchor rotation. Invalidate the
    // applied state so the normal config is rewritten on resume.
    if (this.billboardComponent !== null) {
      this.billboardComponent.xAxisEnabled = false
      this.billboardComponent.yAxisEnabled = false
    }
    this._interactionState.billboardStateApplied = false
  }

  /**
   * Resumes a follow behavior previously paused by {@link suspendFollow}. Idempotent.
   */
  public resumeFollow(owner: string = "default"): void {
    const index = this._follow.suspendOwners.indexOf(owner)
    if (index < 0) return
    this._follow.suspendOwners.splice(index, 1)
    if (this._follow.suspendOwners.length > 0) return
    this._follow.suspended = false
    this._follow.tagAlong?.resume()
    // Reassert the billboard axis config immediately (the update loop may be idle, so don't
    // rely on a later tick). billboardStateApplied was invalidated on suspend, so this
    // rewrites the correct axes for the current translating state.
    this.updateBillboardState(this._interactionState.translating)
  }

  /**
   * Recalculate distance scaling after external code teleports or repositions
   * this Frame. Camera-only motion intentionally does not trigger this method.
   */
  public refreshDepthScaling(): void {
    // Translation refreshes through DepthBehavior so scaling pivots around the
    // grabbed point. DepthBehavior solves its factor against the origin's
    // depth, so this origin-based refresh always agrees with it at release —
    // the guards below exist because DepthBehavior owns the pose while a
    // gesture or released correction is live, not because the factor differs.
    if (
      !this._useDepthScaling ||
      this._depth.scalingSuspended ||
      this.currentInteractor !== null ||
      this._depth.behavior?.isAnimating === true
    )
      return
    this._depth.scaling?.refresh()
  }

  /**
   * Deterministically complete a released depth-clamp correction so another
   * system can take over this Frame's pose without fighting the spring. An
   * active grab is left alone — the gesture owns the pose until release.
   */
  public settleDepthCorrection(): void {
    if (this._depth.behavior?.isAnimating !== true || this.currentInteractor !== null) return
    this.settleDepthCorrectionNow()
  }

  /**
   * Unguarded settle core — callers own the takeover-safety checks.
   * Deliberately no refreshDepthScaling(): settleNow already applied the
   * final origin-consistent scale (DepthBehavior solves its factor against
   * the origin's depth), so a recompute here would be a no-op by invariant;
   * skipping it keeps the takeover boundary free of redundant camera reads.
   */
  private settleDepthCorrectionNow(): void {
    if (this._depth.behavior === null) return
    this._depth.behavior.settleNow()
    this.syncDepthBehavior()
    this._follow.smooth?.recaptureRestTarget()
  }

  /**
   * Freeze the current distance scale while another system temporarily owns
   * this Frame's local scale. Idempotent.
   */
  public suspendDepthScaling(): void {
    if (this._depth.scalingSuspended) return
    this._depth.scalingSuspended = true
    this._depth.scaling?.suspend()
  }

  /**
   * Release temporary scale ownership and recalculate for the Frame's current
   * resting pose. Scale changes made while suspended are not adopted as a new
   * authored baseline. Idempotent.
   */
  public resumeDepthScaling(): void {
    if (!this._depth.scalingSuspended) return
    this._depth.scalingSuspended = false

    if (this._useDepthScaling) {
      if (this._depth.scaling === null) this.syncDepthBehavior()
      // resume(false): recalculation goes through refreshDepthScaling below so
      // its mid-gesture guard applies — while a grab is live, DepthBehavior
      // owns scale and position, so resume()'s internal refresh must not write
      // scale behind its back.
      this._depth.scaling?.resume(false)
      this.refreshDepthScaling()
    } else if (this._depth.scaling !== null) {
      this._depth.scaling.resume(false)
      this._depth.scaling.destroy()
      this._depth.scaling = null
      this.syncDepthBehavior()
    }
  }

  /**
   * Hand this Frame over to the focus frame, which temporarily owns its pose
   * and local scale while a field inside it is docked to the keyboard:
   * completes any released depth-clamp correction, then freezes depth scaling
   * and the follow behavior. Follow suspension (motion/billboard) and
   * depth-scaling suspension (scale ownership) remain independent public APIs
   * for callers that need only one; this wrapper is the focus-frame dock
   * sequence. Idempotent.
   */
  public suspendForFocusFrame(): void {
    // Settle before suspending scale: the settle applies the final
    // anchor-referenced scale, which a suspended DepthScaling would drop.
    this.settleDepthCorrection()
    this.suspendDepthScaling()
    this.suspendFollow(Frame.FOCUS_FRAME_FOLLOW_OWNER)
  }

  /**
   * Release the focus frame's temporary ownership once the docked field has
   * returned to rest: recalculates depth scaling for the current pose and
   * resumes the follow behavior. Idempotent.
   */
  public resumeFromFocusFrame(): void {
    this.resumeDepthScaling()
    this.resumeFollow(Frame.FOCUS_FRAME_FOLLOW_OWNER)
  }

  /**
   * Sets the buffer degrees for the billboard component. Will only be effective if Frame's billboarding is set to true, and xAlways and/or yAlways is set to true.
   * @param xBufferDegrees the buffer degrees for the x-axis
   * @param yBufferDegrees the buffer degrees for the y-axis
   */
  public setBillboardBufferDegrees(xBufferDegrees: number, yBufferDegrees: number): void {
    if (this.billboardComponent !== null) {
      this.xBufferDegrees = xBufferDegrees
      this.yBufferDegrees = yBufferDegrees
      this.refreshAxisBufferDegrees()
      // Apply immediately so a dynamic caller sees the new buffer this frame,
      // matching initializeBillboard(); mark dirty so updateBillboardState
      // re-applies on the next tick.
      this.billboardComponent.axisBufferDegrees = this._refs.axisBufferDegrees
      this._interactionState.billboardStateApplied = false
    }
  }

  /**
   * Sets the billboard easing per axis: the fraction of the remaining angle eliminated per 33ms
   * (exponential decay), where 1 is instant. Defaults to BILLBOARD_AXIS_EASING so a grabbed
   * frame eases to face the user instead of snapping the accumulated angle in one frame.
   * @param xEasing easing for the x-axis (0-1]
   * @param yEasing easing for the y-axis (0-1]
   */
  public setBillboardEasing(xEasing: number, yEasing: number): void {
    this._refs.axisEasing = new vec3(xEasing, yEasing, 1)
    if (this.billboardComponent !== null) {
      this.billboardComponent.axisEasing = this._refs.axisEasing
    }
  }

  /**
   * Resets the scale baseline so that the current innerSize is treated as the new 1× reference.
   * Call this after programmatically changing innerSize to a different aspect ratio so that
   * subsequent interactive scaling computes uniform factors relative to the new size.
   */
  public syncScaleBaseline(): void {
    this._layout.originalInnerSize = this.innerSize.uniformScale(1)
  }

  /**
   * @returns whether interactive scaling of the frame via corner handles is enabled
   */
  public get allowScaling(): boolean {
    return this._allowScaling
  }

  /**
   * Sets whether interactive scaling of the frame via corner handles is enabled
   * @param allowScaling - if true, scaling is enabled through the corner handles
   */
  public set allowScaling(allowScaling: boolean) {
    this._allowScaling = allowScaling
  }

  /**
   * @returns current renderOrder for the renderMeshVisual of the frame itself
   */
  public get renderOrder(): number {
    return this._refs.frameVisual.getRenderOrder()
  }

  /**
   * @param renderOrder sets renderOrder for the renderMeshVisual of the frame itself
   */
  public set renderOrder(renderOrder: number) {
    this._refs.frameVisual.setRenderOrder(renderOrder)
    this._refs.buttonHandler.renderOrder = renderOrder
    this._refs.rightDrawer.renderOrder = renderOrder
    if (this._refs.shadow) {
      this._refs.shadow.renderOrder = renderOrder
    }
  }

  /**
   * @returns whether the snapping behavior is currently tweening
   */
  public isSnappingTweening(): boolean {
    if (this._refs.snappingHandler) {
      return this._refs.snappingHandler.isTweening
    }
    return false
  }

  /**
   * @returns whether the snapping behavior is checking for snappable elements
   */
  public isSnappingActive(): boolean {
    if (this._refs.snappingHandler) {
      return this._refs.snappingHandler.isActive
    }
    return false
  }

  /**
   * @returns the current grab zones of the frame
   */
  public get grabZones(): vec4[] {
    return this._layout.grabZones
  }

  /**
   * Sets the grab zones of the frame, which are used for interaction
   */
  public set grabZones(grabZones: vec4[]) {
    this._layout.grabZones = grabZones
    this._refs.frameVisual.setGrabZones(this.grabZones)
  }

  /**
   * @returns whether the frame only allows interaction in the grab zones
   */
  public get grabZoneOnly(): boolean {
    return this._layout.grabZoneOnly
  }

  /**
   * Sets whether the frame only allows interaction in the grab zones
   * @param only - if true, interaction is limited to the grab zones
   */
  public set grabZoneOnly(only: boolean) {
    this._layout.grabZoneOnly = only
  }

  /**
   * gets the onlyInteractOnMargin setting
   */
  public get onlyInteractOnMargin(): boolean {
    return this._onlyInteractOnMargin
  }

  /**
   * sets the onlyInteractOnMargin setting
   * @param onlyInteractOnMargin - if true, interaction is limited to the frame's margin
   */
  public set onlyInteractOnMargin(onlyInteractOnMargin: boolean) {
    this._onlyInteractOnMargin = onlyInteractOnMargin
    this.applyBorderOnly()
  }

  /**
   * Whether the frame body is drawn border-only — a transparent panel body on
   * System 3.0, the border-only shader path on System 2.0 — while every interactive
   * region stays exactly as it is.
   *
   * `onlyInteractOnMargin` already implies a border-only body, so the visual
   * follows either request. Set this when body-drag has to stay enabled but the
   * body itself must not draw, which is what a compact owner mode needs.
   */
  public get hideBody(): boolean {
    return this._hideBody
  }

  public set hideBody(hideBody: boolean) {
    this._hideBody = hideBody
    this.applyBorderOnly()
  }

  /**
   * Pushes the effective border-only state onto the visual. Tolerates being
   * called before initializeVisuals — initializeHandlers re-applies it once the
   * visual exists, so a pre-init request is deferred rather than lost.
   */
  private applyBorderOnly(): void {
    if (!this._refs.frameVisual) return
    this._refs.frameVisual.setBorderOnly(this._onlyInteractOnMargin || this._hideBody)
  }

  /**
   * @deprecated Renamed to `onlyInteractOnMargin`. Will be removed in a
   * future release. When true, only the frame's margin is interactive.
   */
  public get onlyInteractOnBorder(): boolean {
    return this.onlyInteractOnMargin
  }
  public set onlyInteractOnBorder(value: boolean) {
    this.onlyInteractOnMargin = value
  }

  private createSnappableBehavior() {
    this._refs.snappingHandler = new SnappingHandler({
      frame: this,
      interactable: this._refs.interactable,
      worldSnapping: this.worldSnapping,
      itemSnapping: this.itemSnapping,
      // SnappingHandler invokes this directly, so hand it the (force-created)
      // backing Event — the same instance onSnappingComplete's publicApi wraps.
      onSnappingCompleteEvent: (this._events.snappingComplete ??= new Event<void>()),
      onScalingUpdate: this.onScalingUpdate,
      onPoseUpdated: () => {
        if (this._useDepthScaling) this._depth.scaling?.refreshAfterMovement()
      },
      // SnappingHandler receives per-hand cancellation before handleTriggerEnd
      // updates this state. Predict the transition from the actual interactor
      // so dual → single and bubbled untracked cancellations both preserve
      // snapping while another hand continues the gesture.
      onCancellationPreflight: (event) =>
        triggerStateOnEnd(this._interactionState.trigger, event.interactor).kind === "idle",
      onPoseTakeover: () => {
        // A final cancellation reaches this callback before handleTriggerEnd,
        // so the state is intentionally still single. settleNow() ends the
        // depth gesture; the subsequent endGesture() cleanup is idempotent.
        //
        // Reachable mid-dual without a cancellation: the dual input branch
        // re-reads allowTranslation every frame, so toggling it off fires
        // translationEnd while the gesture remains live. Settling then would
        // clear DepthBehavior's gesture state and freeze this grab.
        if (shouldSettleDepthOnPoseTakeover(this._interactionState.trigger)) this.settleDepthCorrectionNow()
        return true
      }
    })
  }

  /** Frame's inverted world transform, computed at most once per frame. */
  private getInvWorldThisFrame(): mat4 {
    const stamp = getTime()
    if (this._hit.invWorld === null || this._hit.stamp !== stamp) {
      this._hit.invWorld = this.transform.getInvertedWorldTransform()
      this._hit.stamp = stamp
    }
    return this._hit.invWorld
  }

  private computeHitPosition(interactor: Interactor): HitPosition {
    const position = interactor.planecastPoint
    const objectSpaceHit = this.getInvWorldThisFrame().multiplyPoint(position)
    this._interactionState.input.position = objectSpaceHit
    this._interactorPositions.set(interactor, objectSpaceHit)

    const totalSize = this.totalSize
    const result = this._hit.result
    result.normalizedPosition.setXY((objectSpaceHit.x / totalSize.x) * 2, (objectSpaceHit.y / totalSize.y) * 2)

    if (!this._interactionState.translating) {
      this._refs.frameVisual.setCursorPosition(result.normalizedPosition)
    }

    result.localPosition.setXY(objectSpaceHit.x, objectSpaceHit.y)
    return result
  }

  /**
   * Register the cursor visual for an interactor that just started hovering
   * the frame. Existing entries for other interactors are left untouched so
   * both cursors can coexist while both hands hover.
   *
   * Returns whether the interactor is registered after the call.
   * `getCursorByInteractor` can return null (observed on device when hand
   * tracking is still settling at hover-start), so onHoverUpdate retries
   * this until it succeeds — without the retry, the interactor would never
   * receive cursor-mode writes for the entire hover session.
   */
  private addCursorForInteractor(interactor: Interactor): boolean {
    if (this._interactorCursors.has(interactor)) return true
    const cursor = CursorControllerProvider.getInstance().getCursorByInteractor(interactor)
    if (cursor == null) return false
    this._interactorCursors.set(interactor, cursor)
    // First cursor registered (hover-start, or the onHoverUpdate retry): wake
    // the gated loop. Refresh AFTER the set so perFrameActive() sees size > 0.
    this.refreshPerFrameActive()
    return true
  }

  /**
   * Unregister an interactor's cursor on hover-end. Resets that specific
   * cursor to Auto and removes it from the per-interactor maps. Other
   * hovering interactors keep their entries.
   */
  private removeCursorForInteractor(interactor: Interactor) {
    const cursor = this._interactorCursors.get(interactor)
    if (cursor != null) {
      cursor.cursorMode = CursorMode.Auto
    }
    this._interactorCursors.delete(interactor)
    this._interactorPositions.delete(interactor)
    this._interactorOffHierarchyFrames.delete(interactor)
  }

  /**
   * Snapshot of frame geometry / permission flags used by the pure
   * classifier in modules/FrameInputClassification.ts. Built fresh each
   * time `updateCursorMode` runs so changes to grab zones, scaling
   * permissions, etc. take effect immediately.
   */
  private buildClassificationConfig(): FrameClassificationConfig {
    const c = this._scratch.classification
    c.innerSize = this.innerSize
    c.padding = this.padding
    c.grabZones = this.grabZones
    c.grabZoneOnly = this.grabZoneOnly
    c.allowScaling = this._allowScaling
    c.allowScalingTopLeft = this._interactionState.allowScalingTopLeft
    c.allowScalingTopRight = this._interactionState.allowScalingTopRight
    c.onlyInteractOnMargin = this._onlyInteractOnMargin
    return c
  }

  /**
   * Build the cursor-mapping config for the pure cursor-mapping helpers. Both
   * callers — updateInput and updateCursorMode — go through here so the two
   * never drift.
   */
  private buildCursorMappingConfig(): CursorMappingConfig {
    return {allowTranslation: this.allowTranslation, forceTranslate: this.forceTranslate}
  }

  /**
   * Per-update cursor-mode write. Walks every tracked cursor and writes its
   * desired mode only when it changes.
   *
   * Gating rule:
   * - Manipulator active (currentInteractor != null during a pinch):
   *   the manipulator's cursor shows the locked-in `_cursorMode` (frozen
   *   by getInputMode()'s !pinching guard); every other cursor stays in
   *   Auto so the off-hand doesn't show a phantom Scale/Translate hint.
   * - No manipulator: each cursor's mode is computed independently from
   *   its own per-interactor position. Two hands on different zones produce
   *   two different cursor modes.
   */
  private updateCursorMode() {
    // Idle fast path: with no registered cursors there is nothing to
    // reconcile or reap — skip the config builds and the map walk entirely.
    if (this._interactorCursors.size === 0) return
    const manipulator = this.currentInteractor
    const secondary = this.secondaryInteractor
    const classificationConfig = this.buildClassificationConfig()
    const cursorMappingConfig = this.buildCursorMappingConfig()
    let reaped: Interactor[] | null = null
    for (const [interactor, cursor] of this._interactorCursors) {
      if (cursor == null) continue

      // Live targeting facts for this hand, queried once per frame. The
      // cursor must be a pure function of live interactor state — every
      // event-fed input here has produced a stale-cursor bug (stored event
      // targets lagging the hand; position map gated on a targetHitInfo
      // precondition the gesture path doesn't have).
      const targetsFrame = interactor.currentInteractable === this._refs.interactable
      const hoveringHierarchy = interactor.isHoveringInteractableHierarchy(this._refs.interactable)
      // Reconcile body-hover membership against LIVE targeting — sheds hands
      // whose hover-exit was missed (the same failure updateCursorMode's
      // cursor reap exists for). The primary per-frame writer is the
      // HoverBehavior hover-update path, which also covers unregistered hands.
      this.updateFrameBodyHover(interactor)

      // Per-frame reconciliation against the LIVE hover state. Hover-end
      // events can be missed (e.g. an exit swallowed during a trigger whose
      // end variant wasn't covered) — and a hand that's already off the
      // frame produces no further events, so a missed exit would otherwise
      // leave its cursor stuck on the last written mode forever. Active
      // manipulators are exempt: a mid-drag hand may legitimately point off
      // the collider, and the trigger-end path owns their cleanup. Reap only
      // when BOTH live signals say the hand is gone — near-field plane
      // targeting can make the hierarchy query lag the targeting query, and
      // reaping on a single disagreeing signal caused an add/reap oscillation
      // that pinned the cursor to Auto while legitimately hovering the edge.
      // The debounce mirrors HoverBehavior's, so brief flickers don't strobe.
      const isGestureOwner = interactor === manipulator || interactor === secondary
      if (!isGestureOwner && !hoveringHierarchy && !targetsFrame) {
        const offFrames = (this._interactorOffHierarchyFrames.get(interactor) ?? 0) + 1
        if (offFrames >= CURSOR_RECONCILE_OFF_FRAMES) {
          ;(reaped ??= []).push(interactor)
          continue
        }
        this._interactorOffHierarchyFrames.set(interactor, offFrames)
      } else {
        this._interactorOffHierarchyFrames.delete(interactor)
      }

      // Position: live planecast, same source the gesture classification
      // uses at trigger time. The event-fed `_interactorPositions` map only
      // updates when a hover event arrives AND targetHitInfo is non-null —
      // in near-field plane targeting, targetHitInfo can stay null for the
      // whole hover, so the map never populates and the cursor was stuck on
      // Auto while the trigger (which reads planecastPoint unconditionally)
      // happily started a translate. Fall back to the map only when the
      // planecast is momentarily unavailable.
      const livePosition = this.interactorLocalPlanecast(interactor)
      const position = livePosition ?? this._interactorPositions.get(interactor)

      const cursorArgs = this._scratch.cursorArgs
      cursorArgs.interactor = interactor
      cursorArgs.manipulator = manipulator
      cursorArgs.secondaryManipulator = secondary
      cursorArgs.manipulatorCursorMode = this._interactionState.cursorMode
      cursorArgs.position = position
      // Live targeting: a hand on the frame (or its margin) targets the
      // frame's interactable; a hand on a nested child targets the child.
      cursorArgs.innerInteractableActive = !targetsFrame
      cursorArgs.classificationConfig = classificationConfig
      cursorArgs.cursorMappingConfig = cursorMappingConfig
      const desired = selectCursorMode(cursorArgs)

      // Compare against the cursor's own state, not a Frame-side cache: the
      // cursor can be reset externally (another Frame, another UIKit widget,
      // the cursor system itself), and a stale cache would block the
      // corrective rewrite. The v3 setter no-ops on identical values, so the
      // guarded write stays cheap.
      if (cursor.cursorMode !== desired) {
        cursor.cursorMode = desired
      }
    }
    if (reaped !== null) {
      for (const interactor of reaped) {
        this._bodyHoverInteractors.delete(interactor)
        this.removeCursorForInteractor(interactor)
      }
      this.applyFrameBodyHover(this._bodyHoverInteractors.size > 0)
      this.clearGlobalHoverStateIfEmpty()
    }
  }

  /**
   * This interactor's planecast point in frame-local space, or null when the
   * planecast is unavailable. Live read — the same source `computeHitPosition`
   * uses for gesture classification, so cursor hints and gesture starts can
   * never disagree about where the hand is.
   */
  private interactorLocalPlanecast(interactor: Interactor): vec3 | null {
    const world = interactor.planecastPoint
    if (world === null) return null
    return this.getInvWorldThisFrame().multiplyPoint(world)
  }

  private updateInput() {
    this._interactionState.isInZoneLast = this._interactionState.isInZone
    if (!this._interactionState.input.pinching) this.getInputMode()
    this.handleInputState()

    if ((this.allowTranslation && this._interactionState.translating) || this.forceTranslate) {
      this._refs.manipulate.setCanTranslate(true)
    } else {
      this._refs.manipulate.setCanTranslate(false)
    }

    // Cursor mode from input mode. Safe to always run — _inputMode is frozen
    // during pinching (getInputMode() only runs when !pinching), so the cursor
    // stays correct for the operation in progress. The per-cursor write
    // happens in updateCursorMode() which also gates non-manipulator cursors
    // to Auto while a manipulator is active.
    this._interactionState.cursorMode = mapInputModeToCursorPure(
      this._interactionState.inputMode,
      this.buildCursorMappingConfig()
    )
  }

  /**
   * Compute `_inputMode` (and the `_isInZone` side-effect) for the manipulator's
   * view. Geometry classification is delegated to the pure helpers in
   * FrameInputClassification.ts — see those for the corner/edge/interior
   * rules. This wrapper layers Frame-specific manipulator gates on top:
   *
   *  - `innerInteractableActive`, `!hierarchyHovered`, `!_isInZone` → Auto
   *    (highest-priority short-circuits, before geometry runs).
   *  - Mid-gesture freeze: when the manipulator drifts into the interior
   *    with `onlyInteractOnMargin = true` and a scale/translate gesture is
   *    already active, the prior `_inputMode` is kept rather than reset to
   *    Auto. Corner-without-permission and other Auto results still write
   *    through normally (handled by the `isPositionInterior` gate).
   *
   * Kept 1:1 with the pre-refactor inline implementation — see
   * FrameInputClassification.test.ts for the geometry contract.
   */
  private getInputMode() {
    const position = this._interactionState.input.position
    const cfg = this.buildClassificationConfig()

    this._interactionState.isInZone = isPositionInZone(position, cfg)

    if (
      this._interactionState.input.innerInteractableActive ||
      !this._interactionState.input.hierarchyHovered ||
      !this._interactionState.isInZone
    ) {
      this._interactionState.inputMode = InputMode.Auto
      return
    }

    const classified = computeInputModeFromPositionPure(position, cfg)

    // Mid-gesture freeze: keep the prior _inputMode rather than letting an
    // Auto result reset state while the manipulator is mid-drag. Only
    // applies in the interior + onlyInteractOnMargin case; corner-without-
    // permission Auto and other Auto results write through.
    if (
      classified === InputMode.Auto &&
      this._onlyInteractOnMargin &&
      isPositionInterior(position, cfg) &&
      (this._interactionState.scaling || this._interactionState.translating)
    ) {
      return
    }

    this._interactionState.inputMode = classified
  }

  private handleInputState() {
    if (this.isDualGrab) {
      // Dual-grab: corner-scale is disabled (design decision #2). Translate
      // stays enabled — provided the primary's pinch qualified for some
      // interaction — so updateInput()'s canTranslate gate keeps Manipulate's
      // dual-transform running. Without that gate, Manipulate.setCanTranslate
      // would flip false on the next updateInput() tick and the visual
      // translation would stop entirely.
      //
      // The dualGrabShouldTranslate gate honors the single-hand interactivity
      // contract: if the primary's _inputMode is Auto (e.g. interior pinch
      // with onlyInteractOnMargin=true, or a corner without scale
      // permission), adding a second hand does NOT elevate the gesture into
      // a translate. _inputMode here is the v5 snapshot from idle → single,
      // taken from the original triggering hand's own position.
      if (this._interactionState.scaling) this._events.scalingEnd?.invoke()
      this._interactionState.scaling = false
      this.setInputTranslating(
        dualGrabShouldTranslate(this._interactionState.inputMode, this.allowTranslation, this.forceTranslate)
      )
      return
    }
    if (this._interactionState.input.pinching) {
      if (this._interactionState.isInZone && !this._interactionState.scaling && !this._interactionState.translating) {
        switch (this._interactionState.inputMode) {
          case InputMode.ScaleBottomLeft:
          case InputMode.ScaleTopLeft:
          case InputMode.ScaleBottomRight:
          case InputMode.ScaleTopRight:
            this._interactionState.scaling = true
            this.scalingSizeStart = this.innerSize.uniformScale(1)
            this._events.scalingStart?.invoke()
            break
          case InputMode.Translating:
            this.setInputTranslating(true)
            break
          default:
            if (this._onlyInteractOnMargin === false) {
              this.setInputTranslating(true)
            }
            break
        }
      }
    } else {
      if (this._interactionState.scaling) this._events.scalingEnd?.invoke()
      // When forceTranslate is on, the block below keeps _translating=true; flipping
      // to false here would cause onTranslationEnd + onTranslationStart to fire every
      // frame as the two blocks fought each other.
      if (!this.forceTranslate) {
        this.setInputTranslating(false)
      }
      this._interactionState.scaling = false
    }

    if (this.forceTranslate) {
      this._interactionState.inputMode = InputMode.Translating
      this.setInputTranslating(true)
    }
  }

  private setInputTranslating(isTranslating: boolean) {
    if (isTranslating === this._interactionState.translating) return
    this._interactionState.translating = isTranslating
    if (this._interactionState.translating) {
      this._events.translationStart?.invoke()
    } else {
      this._events.translationEnd?.invoke()
    }
  }

  private updateCursorRadiusAndGlow(e: InteractorEvent) {
    if ((e.interactor.inputType & InteractorInputType.BothHands) !== 0) {
      const handInteractor = e.interactor as HandInteractor
      const currentPlane = handInteractor.currentInteractionPlane
      const cachedProjection = handInteractor.cachedIndexProjection

      if (currentPlane === null || cachedProjection === null) {
        this._refs.frameVisual.setCursorRadiusFactor(1)
      } else {
        const outThreshold = currentPlane.nearFieldDepth
        const inThreshold = currentPlane.physicalZoneDepth
        const distance =
          handInteractor.fieldTargetingMode === FieldTargetingMode.Direct ||
          handInteractor.fieldTargetingMode === FieldTargetingMode.BehindNearField
            ? inThreshold
            : cachedProjection.distance

        const pokeLerpValue = clamp((distance - inThreshold) / (outThreshold - inThreshold), 0, 1)
        const pinchLerpValue = 1 - clamp(handInteractor.interactionStrength ?? 0, 0, 0.8) / 0.8
        const minLerpValue = Math.min(pokeLerpValue, pinchLerpValue)

        this._refs.frameVisual.setCursorRadiusFactor(
          MINIMUM_CURSOR_RADIUS_FACTOR + LERP_CURSOR_RADIUS_FACTOR * easingFunctions["ease-out-cubic"](minLerpValue)
        )
      }

      // Glow opacity: Only fade during Far-Near transitions to hide targeting jump
      const transitionInfo = handInteractor.fieldModeTransitionInfo
      const involveFarField =
        transitionInfo.fromMode === FieldTargetingMode.FarField || transitionInfo.toMode === FieldTargetingMode.FarField
      const isInFarNearTransition = transitionInfo.isTransitioning && involveFarField

      if (isInFarNearTransition) {
        this._refs.frameVisual.setGlowOpacityFactor(transitionInfo.blendFactor)
        this._interactionState.wasInFarNearTransition = true
      } else if (this._interactionState.wasInFarNearTransition) {
        this._refs.frameVisual.setGlowOpacityFactor(1.0)
        this._interactionState.wasInFarNearTransition = false
      }
    } else {
      this._refs.frameVisual.setCursorRadiusFactor(1)
    }
  }

  private updateGrabZoneHighlight(hoveringContent: boolean) {
    if (
      !hoveringContent &&
      this._interactionState.isInZone &&
      !this._interactionState.isInZoneLast &&
      this.grabZoneOnly
    ) {
      this.showCursorHighlight()
    }
    if (
      !hoveringContent &&
      !this._interactionState.isInZone &&
      !this._interactionState.isInZoneLast &&
      this.grabZoneOnly
    ) {
      this.hideCursorHighlight()
    }
  }

  private updateContentHover(hoveringContent: boolean, isNearField: boolean) {
    if (hoveringContent && !isNearField) {
      if (!this._interactionState.hoveringContentLast) {
        this.hideCursorHighlight()
      }
    } else {
      if (this._interactionState.hoveringContentLast) {
        if (!this.grabZoneOnly || this._interactionState.isInZone) {
          this.showCursorHighlight()
        }
      }
    }
    this._interactionState.hoveringContentLast = hoveringContent
  }

  /**
   * Show the frame's visuals. System2: opacity tween of the body + buttons.
   * System 3.0: drawer slides out; if autoShowHide is on, body also fades in.
   * Close button stays at full opacity in all System3 cases.
   */
  public showVisual() {
    this.setBodyVisualsEnabled(true)
    this.tweenOpacity(this._visual.opacity, 1)
    this._events.showVisual?.invoke()
  }

  /**
   * Hide the frame's visuals. System2: opacity tween + disable frame mesh.
   * System 3.0: drawer slides behind the body; if autoShowHide is on, body
   * also fades out and the mesh disables at the end of the fade. With
   * autoShowHide off, the body stays at full opacity and enabled.
   */
  public hideVisual() {
    this.tweenOpacity(this._visual.opacity, 0, () => {
      if (!this.isPanelFrame || this.autoShowHide) {
        this.setBodyVisualsEnabled(false)
      }
      this._events.hideVisual?.invoke()
    })
  }

  // Panel fade: the retained "panel.fade" timeline. Built once; show plays
  // forward, hide plays in reverse from wherever the fade currently is.
  private panelFadeCallback: (() => void) | null = null
  private panelAlphaWriter: OpacityWriter | null = null

  /**
   * One conceptual "panel alpha" write, fanned out to every frame element.
   * Panel frames drive the pieces directly (mesh enable is deferred to the
   * hide callback); classic frames route through the `opacity` setter, which
   * already fans out and manages mesh enablement.
   */
  private getPanelAlphaWriter(): OpacityWriter {
    if (this.panelAlphaWriter !== null) {
      return this.panelAlphaWriter
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const frame = this
    this.panelAlphaWriter = this.isPanelFrame
      ? {
          get opacity(): number {
            return frame._visual.opacity
          },
          set opacity(value: number) {
            frame._visual.opacity = value
            frame._refs.frameVisual.setOpacity(value)
            frame._refs.buttonHandler.opacity = value
            frame._refs.rightDrawer.opacity = value
            if (frame._refs.shadow) {
              frame._refs.shadow.opacity = value
            }
          }
        }
      : {
          get opacity(): number {
            return frame._visual.opacity
          },
          set opacity(value: number) {
            frame.opacity = value
          }
        }
    return this.panelAlphaWriter
  }

  /**
   * Fades the whole frame from `currentOpacity` toward `targetOpacity` — any
   * target in [0,1], not just show/hide (a consumer may fade frames to partial
   * opacity on proximity). A retained tween on the panel alpha writer:
   * a re-call retargets from the live value (never a restart), and a
   * superseded fade never fires its callback (the legacy cancel semantics).
   * Duration scales with the remaining delta — constant fade rate, the base
   * token for a full fade, linear per the spec's fade rows. Value-
   * parameterized motion has no intent grammar, same as the squeeze handle,
   * so tokens are read from the profile directly.
   */
  public tweenOpacity(currentOpacity: number, targetOpacity: number, endCallback = () => {}) {
    // The spawn timeline owns the frame's opacity for its flight: its
    // composite fade writes the same chrome writer through a DIFFERENT
    // registry target, so a concurrent tween here (autoShowHide hover fades)
    // could not be conflict-resolved — chrome and content would diverge.
    // Deliberately DROP the callback: hideVisual uses it to disable body
    // visuals, which would pop the frame off mid-reveal.
    if (this.spawnTimeline !== null && this.spawnTimeline.isPlaying) {
      return
    }
    if (this.isPanelFrame) {
      // Drawer slides on every show/hide regardless of autoShowHide.
      if (targetOpacity > 0) {
        this._refs.rightDrawer.show(this.autoShowHide ? undefined : endCallback)
      } else {
        this._refs.rightDrawer.hide(this.autoShowHide ? undefined : endCallback)
      }
      if (!this.autoShowHide) {
        // Body and close stay visible; drawer slide is the only feedback.
        return
      }
    }
    this.panelFadeCallback = endCallback
    const writer = this.getPanelAlphaWriter()
    const current = clamp(currentOpacity, 0, 1)
    const target = clamp(targetOpacity, 0, 1)
    // Resync if something wrote opacity outside the fade.
    if (Math.abs(writer.opacity - current) > 0.001) {
      writer.opacity = current
    }
    const profile = getActiveMotionProfile()
    Motion.to(writer, {
      channel: MotionChannels.ch.alpha,
      value: target,
      duration: profile.durations.base * Math.abs(target - current),
      ease: profile.eases.linear,
      onFinish: () => {
        const callback = this.panelFadeCallback
        this.panelFadeCallback = null
        callback?.()
      }
    })
  }

  /**
   * @param opacity sets opacity for all frame elements
   * Note this parameter is effected by calls to `showVisual` and `hideVisual`.
   */
  public set opacity(opacity: number) {
    if (opacity > 0) {
      this.isVisible = true
    } else {
      this.isVisible = false
    }

    this._visual.opacity = opacity
    this.setBodyVisualsEnabled(opacity > 0)
    this._refs.frameVisual.setOpacity(opacity)
    this._refs.buttonHandler.opacity = opacity
    this._refs.rightDrawer.opacity = opacity
    if (this._refs.shadow) {
      this._refs.shadow.opacity = opacity
    }
  }

  /**
   * @returns current opacity of frame elements
   */
  public get opacity(): number {
    return this._visual.opacity
  }

  /**
   * @param _minimumSize sets the minimum size for all frame elements
   * Note this parameter controls the lower bound for scaling.
   */
  public set minimumSize(minimumSize: vec2) {
    this._minimumSize = minimumSize
    this.clampInnerSizeToBounds()
  }

  /**
   * @returns current minimum size of frame elements
   */
  public get minimumSize(): vec2 {
    return this._minimumSize
  }

  /**
   * @param _maximumSize sets the maximum size for all frame elements
   * Note this parameter controls the upper bound for scaling.
   */
  public set maximumSize(maximumSize: vec2) {
    this._maximumSize = maximumSize
    this.clampInnerSizeToBounds()
  }

  /**
   * @returns current maximum size of frame elements
   */
  public get maximumSize(): vec2 {
    return this._maximumSize
  }

  private clampInnerSizeToBounds() {
    const clampedX = MathUtils.clamp(this.innerSize.x, this.minimumSize.x, this.maximumSize.x)
    const clampedY = MathUtils.clamp(this.innerSize.y, this.minimumSize.y, this.maximumSize.y)
    if (clampedX !== this.innerSize.x || clampedY !== this.innerSize.y) {
      this.innerSize = new vec2(clampedX, clampedY)
    }
  }

  private cursorHighlightTimeline: Timeline | null = null

  private animateCursorHighlight(target: number) {
    const show = target > 0
    if (this.cursorHighlightTimeline === null) {
      this.cursorHighlightTimeline = Intents.highlight(
        {
          apply: (value: number) => {
            this._visual.hoverIntensity = value
            this._refs.frameVisual.setHoverIntensity(value)
          },
          read: () => this._visual.hoverIntensity
        },
        {direction: show ? "forward" : "reverse"}
      )
    } else {
      this.cursorHighlightTimeline.play(show)
    }
  }

  private showCursorHighlight() {
    this.animateCursorHighlight(1)
  }
  private hideCursorHighlight() {
    this.animateCursorHighlight(0)
  }

  // Squeeze margin: a retained retargetable handle — targets are arbitrary
  // layout-dependent margins (squeezed vs original), so quickTo semantics fit
  // where a play/reverse timeline wouldn't. Duration/ease from tokens; the
  // legacy back-cubic overshoot is the `back` family. NOTE: value-
  // parameterized motion has no intent grammar.
  private squeezeHandle: ((value: number) => unknown) | null = null

  private tweenMarginSize(targetMargin: number) {
    if (this.squeezeHandle === null) {
      const profile = getActiveMotionProfile()
      this.squeezeHandle = Motion.handle(
        this,
        MotionChannels.custom<number>("frame.squeezeMargin", () => ({
          read: () => this._layout.margin,
          write: (value: number) => this.setSqueezeMargin(value)
        })),
        {duration: profile.durations.base, ease: back().out}
      )
    }
    this.squeezeHandle(targetMargin)
  }

  // --- Horizon Reveal (spec slide 26 — Spatial Spawning) ---

  private spawnTimeline: Timeline | null = null
  private spawnGeometryKey = ""
  private spawnEndCallback: (() => void) | null = null
  private spawnBillboardWasEnabled = false
  // The spec fades "Frame + elements": chrome fades through the panel alpha
  // writer, CONTENT through a VisibilityGroup over the content subtree
  // (the DialogPopup pattern — refresh() per spawn catches late content).
  private spawnContentGroup: VisibilityGroup | null = null
  // Opaque content passes flipped to blending for the spawn window: opaque
  // blend ignores alpha outright (element bodies default opaque), so they'd
  // pop while everything else fades. Restored ONLY when fully shown —
  // restoring at hidden would render opaque bodies straight through alpha 0.
  private static readonly SPAWN_FOLLOW_OWNER = "spawn"
  private static readonly FOCUS_FRAME_FOLLOW_OWNER = "focusFrame"
  // Rest pose the retained timeline was built against — the parked-pose check
  // that catches a frame moved (e.g. re-laid-out) while despawned.
  private spawnRestPosition: vec3 | null = null
  private spawnRestHeight: number = 0
  // Authored scale and rest rotation as captured when the timeline was built:
  // a rebuild triggered from the parked (closed) pose must not read them off
  // the live transform, which is mid-reveal by definition.
  private spawnAuthoredScale: vec3 | null = null
  private spawnRestRotation: quat | null = null
  // Late-materializing content watch (the DialogPopup pattern): on a
  // spawn-on-start, content Elements build their visuals in their OWN
  // OnStart — after this frame's — so the first discovery sees a nearly
  // empty subtree. Poll while the spawn plays: refresh discovery, flip any
  // newly-built opaque passes, and reapply the timeline so newcomers adopt
  // the in-flight alpha instead of popping in.
  private static readonly SPAWN_FADE_WATCH_FRAMES = 30
  /** Fibonacci-thinned rescan schedule within the watch window (frame 0 = play frame). */
  private static readonly SPAWN_FADE_RESCAN_FRAMES = [1, 2, 3, 5, 8, 13, 21, 29]
  private spawnFadeWatchEvent: LateUpdateEvent | null = null
  private spawnFadeWatchFramesLeft = 0
  private spawnLastManagedCount = -1

  /**
   * Plays the Horizon Reveal: the frame materializes — settling from half its
   * height above rest, scale 50→100%, X-hinge 83°→0°, with a quick lead fade
   * (1 s spawn tuning). The billboard is suspended while the hinge animates
   * (two rotation writers would fight) and restored on completion. Assumes
   * the frame is not following at spawn time — SmoothFollow owns position
   * while following, so the rise channel would fight it.
   */
  public spawn(): void {
    this.playHorizonReveal(true)
  }

  /**
   * The reverse: the frame recedes to the horizon (667 ms exit tuning, fade
   * delayed 333 ms) and its SceneObject DISABLES on completion — a removed
   * surface is gone entirely. `spawn()` re-enables and revives it.
   */
  public despawn(endCallback?: () => void): void {
    this.playHorizonReveal(false, endCallback)
  }

  private playHorizonReveal(forward: boolean, endCallback?: () => void): void {
    if (!this.initialized) return
    this.spawnEndCallback = endCallback ?? null
    // A hover fade already in flight keeps writing chrome opacity from a
    // different registry target than the spawn composite — kill it here;
    // tweenOpacity's own guard only blocks NEW fades during the flight.
    if (this.panelAlphaWriter !== null) {
      Motion.killTweensOf(this.panelAlphaWriter)
    }
    // A despawned frame's SceneObject is disabled; a new spawn revives it.
    if (forward && !this.sceneObject.enabled) {
      this.sceneObject.enabled = true
    }
    // Mid-flight: a direction change on the retained timeline — never rebuild
    // here (the live pose is animated; capturing it as rest would corrupt the
    // geometry key).
    if (this.spawnTimeline !== null && this.spawnTimeline.isPlaying) {
      this.spawnTimeline.play(forward)
      return
    }
    // Parked at the CLOSED endpoint: the live pose IS the spawn's from-state
    // (half a height up, 50%, hinged) — re-capturing it as rest would drift
    // the frame half a height per cycle. The retained endpoints are correct;
    // replay them — UNLESS something repositioned the frame while it was
    // parked. A despawned frame is disabled, which drops it out of layout
    // discovery, so a sibling rearrangement can move it; the parked pose is
    // then no longer rest+height/2 and the retained endpoints are stale.
    // Whoever moved it meant the new position as REST (layout knows nothing
    // about the closed offset), so fall through and rebuild from it.
    if (this.spawnTimeline !== null && !this.spawnTimeline.isForward && this.parkedAtExpectedClosedPose()) {
      this.suspendBillboardForSpawn()
      this.suspendFollowForSpawn()
      this.openSpawnBlendWindow()
      this.spawnTimeline.play(forward)
      this.startSpawnFadeWatch()
      return
    }
    const transform = this._refs.transform
    // CAREFUL: when we fall through here from the parked-at-closed branch the
    // live transform is at the CLOSED endpoint — scale is authored×scaleFrom
    // and rotation carries the full hinge (see buildHorizonReveal). Reading
    // them as authored would halve the frame and re-add height/2 every cycle,
    // which is precisely the drift the parked branch exists to avoid. Use the
    // values captured when the timeline was built; only POSITION is re-read,
    // because whoever moved the parked frame meant the new spot as rest.
    const parkedButMoved = this.spawnTimeline !== null && !this.spawnTimeline.isForward
    const rest = transform.getLocalPosition()
    const authored =
      parkedButMoved && this.spawnAuthoredScale !== null ? this.spawnAuthoredScale : transform.getLocalScale()
    const height = this.totalSize.y
    // Rest ROTATION is part of the key: the hinge binding caches its euler at
    // bind time, so after the billboard re-aims the frame, replaying the
    // retained timeline would write the first-spawn yaw back. A facing change
    // rebuilds instead.
    const restRotation =
      parkedButMoved && this.spawnRestRotation !== null ? this.spawnRestRotation : transform.getLocalRotation()
    const geometryKey =
      `${rest.x.toFixed(3)}|${rest.y.toFixed(3)}|${rest.z.toFixed(3)}|` +
      `${authored.x.toFixed(3)}|${authored.y.toFixed(3)}|${authored.z.toFixed(3)}|${height.toFixed(3)}|` +
      `${restRotation.w.toFixed(3)}|${restRotation.x.toFixed(3)}|${restRotation.y.toFixed(3)}|${restRotation.z.toFixed(3)}`
    this.suspendBillboardForSpawn()
    this.suspendFollowForSpawn()
    this.openSpawnBlendWindow()
    this.spawnRestPosition = new vec3(rest.x, rest.y, rest.z)
    this.spawnRestHeight = height
    this.spawnAuthoredScale = new vec3(authored.x, authored.y, authored.z)
    this.spawnRestRotation = restRotation
    if (this.spawnTimeline === null || geometryKey !== this.spawnGeometryKey) {
      this.spawnTimeline?.kill()
      this.spawnGeometryKey = geometryKey
      this.spawnTimeline = Intents.horizonReveal(
        {
          target: this.sceneObject,
          restPosition: new vec3(rest.x, rest.y, rest.z),
          height,
          authoredScale: new vec3(authored.x, authored.y, authored.z),
          fade: this.spawnFadeWriter(),
          onComplete: (revealed: boolean) => {
            // Billboard back on before follow resumes: resumeFollow rewrites
            // the axis config (suspendFollow forced it off), so the component
            // must be live to receive it.
            this.restoreBillboardAfterSpawn()
            this.resumeFollowAfterSpawn()
            // Fully shown → opaque bodies can go back to the cheap pass.
            // Hidden → keep blending (opaque would render through alpha 0)
            // and disable the whole SceneObject (the DialogPopup precedent):
            // a removed surface is GONE — including content whose materials
            // have no fadeable surface (prism bodies) and idle update cost.
            if (revealed) this.closeSpawnBlendWindow()
            else this.sceneObject.enabled = false
            const callback = this.spawnEndCallback
            this.spawnEndCallback = null
            callback?.()
            if (revealed) this._events.showVisual?.invoke()
            else this._events.hideVisual?.invoke()
            // autoShowHide contract: an unhovered frame hides. The spawn
            // skipped the OnStart pre-hide so the reveal could play; without
            // this, a never-hovered frame would stay visible forever (no
            // hover-exit ever fires from the Inactive state).
            if (revealed && this.autoShowHide && this._interactorCursors.size === 0) {
              this.hideVisual()
            }
          }
        },
        {direction: forward ? "forward" : "reverse"}
      )
    } else {
      this.spawnTimeline.play(forward)
    }
    this.startSpawnFadeWatch()
  }

  private startSpawnFadeWatch(): void {
    this.spawnLastManagedCount = this.spawnContentGroup?.size ?? -1
    this.spawnFadeWatchFramesLeft = Frame.SPAWN_FADE_WATCH_FRAMES
    if (this.spawnFadeWatchEvent === null) {
      this.spawnFadeWatchEvent = this.createEvent("LateUpdateEvent")
      this.spawnFadeWatchEvent.bind(() => this.pollSpawnFadeTargets())
    }
    this.spawnFadeWatchEvent.enabled = true
  }

  private pollSpawnFadeTargets(): void {
    const group = this.spawnContentGroup
    const timeline = this.spawnTimeline
    // Stop with the animation: polling past completion would re-flip passes
    // the shown-state restore just returned to the cheap opaque pass.
    if (group === null || timeline === null || !timeline.isPlaying) {
      if (this.spawnFadeWatchEvent) this.spawnFadeWatchEvent.enabled = false
      return
    }
    // refresh() is a full teardown + rediscovery — doing it every LateUpdate
    // made spawn O(frames × subtree) during the animation. Late content lands
    // on its own OnStart within the first frames, so rescan on a thinning
    // schedule instead. The group re-opens its own blend window for newly
    // discovered entries as part of the refresh.
    const elapsed = Frame.SPAWN_FADE_WATCH_FRAMES - this.spawnFadeWatchFramesLeft
    if (Frame.SPAWN_FADE_RESCAN_FRAMES.indexOf(elapsed) >= 0) {
      group.refresh()
      if (group.size !== this.spawnLastManagedCount) {
        this.spawnLastManagedCount = group.size
        timeline.reapply()
      }
    }
    this.spawnFadeWatchFramesLeft--
    if (this.spawnFadeWatchFramesLeft <= 0 && this.spawnFadeWatchEvent) {
      this.spawnFadeWatchEvent.enabled = false
    }
  }

  /**
   * The whole-frame fade target: chrome through the proven panel alpha
   * writer, content through a VisibilityGroup over the content subtree.
   * A composite object (not a SceneObject), so the alpha channel writes it
   * directly rather than resolving a provider.
   */
  private spawnFadeWriter(): OpacityWriter {
    // openSpawnBlendWindow() already ensured + refreshed on this entry.
    const content = this.ensureSpawnContentGroup(false)
    const chrome = this.getPanelAlphaWriter()
    return {
      get opacity(): number {
        return chrome.opacity
      },
      set opacity(value: number) {
        chrome.opacity = value
        content.opacity = value
      }
    }
  }

  /**
   * Creates or refreshes the content fade group (content can appear late).
   * `refresh` is a full teardown + subtree rediscovery, so a spawn entry does
   * it ONCE — a freshly constructed group has just discovered, and the second
   * caller in the same entry passes false.
   */
  private ensureSpawnContentGroup(refresh: boolean = true): VisibilityGroup {
    if (this.spawnContentGroup === null) {
      this.spawnContentGroup = new VisibilityGroup(this._refs.content)
      return this.spawnContentGroup
    }
    if (refresh) {
      // Content built since the last discovery (async text, added children).
      this.spawnContentGroup.refresh()
    }
    return this.spawnContentGroup
  }

  /**
   * Opens the content fade's blend window so opaque element bodies actually
   * participate. The GROUP owns this: it holds every material slot's pass
   * (not just the first), stops at nested VisibilityGroup boundaries instead
   * of trampling a child group's own fade, ref-counts passes shared with
   * other groups, and re-applies to content discovered later.
   */
  private openSpawnBlendWindow(): void {
    this.ensureSpawnContentGroup().openFadeBlendWindow()
  }

  private closeSpawnBlendWindow(): void {
    this.spawnContentGroup?.closeFadeBlendWindow()
  }

  /**
   * True when the frame still sits where the closed endpoint left it. A
   * parked frame is disabled and therefore invisible to layout discovery, so
   * a sibling rearrangement can move it — the retained timeline's endpoints
   * are stale in that case and the caller must rebuild.
   */
  private parkedAtExpectedClosedPose(): boolean {
    const rest = this.spawnRestPosition
    if (rest === null) {
      return false
    }
    const actual = this._refs.transform.getLocalPosition()
    const expectedY = rest.y + this.spawnRestHeight / 2
    return (
      Math.abs(actual.x - rest.x) < 0.01 && Math.abs(actual.y - expectedY) < 0.01 && Math.abs(actual.z - rest.z) < 0.01
    )
  }

  /**
   * SmoothFollow writes the frame's WORLD pose every follow tick while the
   * reveal drives its LOCAL pose — two owners, visible jitter. `_spawnOnStart`
   * can fire on an already-following frame (OnStart enables following before
   * it runs), so spawn suspends follow for its flight rather than trusting
   * the documented "not following" assumption.
   */
  private suspendFollowForSpawn(): void {
    this.suspendFollow(Frame.SPAWN_FOLLOW_OWNER)
  }

  private resumeFollowAfterSpawn(): void {
    this.resumeFollow(Frame.SPAWN_FOLLOW_OWNER)
  }

  private suspendBillboardForSpawn(): void {
    const billboard = this._refs.billboardComponent
    if (billboard !== null && billboard.enabled) {
      this.spawnBillboardWasEnabled = true
      billboard.enabled = false
    }
  }

  private restoreBillboardAfterSpawn(): void {
    if (this.spawnBillboardWasEnabled) {
      this.spawnBillboardWasEnabled = false
      const billboard = this._refs.billboardComponent
      if (billboard !== null) billboard.enabled = true
    }
  }
}
