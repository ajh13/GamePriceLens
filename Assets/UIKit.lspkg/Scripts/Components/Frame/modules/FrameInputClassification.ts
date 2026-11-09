// Pure (test-friendly) classification logic for Frame's cursor mode.
//
// Lives outside Frame so it can be unit-tested without a Lens Studio runtime.
// Frame delegates to these helpers from updateCursorMode() — see Frame.ts.
//
// Three responsibilities, all stateless:
//   - InputMode classification from a hit position + frame geometry
//   - Mapping InputMode → CursorMode (the visual)
//   - Per-interactor cursor selection with manipulator gating

import {
  CursorMode,
  InteractorCursor
} from "InteractionKit.lspkg/Components/Interaction/InteractorCursor/InteractorCursor"
import {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"

/**
 * Coarse classification of where a hit position falls relative to the frame.
 *
 * Used by Frame.handleInputState() to drive gesture state machines AND by
 * updateCursorMode() to drive cursor visuals. Kept in its own module so the
 * geometry is unit-testable.
 */
export enum InputMode {
  Auto = 0,
  Translating = 1,
  ScaleBottomLeft = 2,
  ScaleBottomRight = 3,
  ScaleTopLeft = 4,
  ScaleTopRight = 5
}

/** Pure inputs for {@link computeInputModeFromPosition}. */
export type FrameClassificationConfig = {
  innerSize: vec2
  padding: vec2
  /** Optional explicit grab regions (frame-local rect xyzw = minX, minY, maxX, maxY). */
  grabZones: vec4[]
  /** When true, only the grab zones (not the whole margin) are interactive. */
  grabZoneOnly: boolean
  allowScaling: boolean
  allowScalingTopLeft: boolean
  allowScalingTopRight: boolean
  /** When false, the body itself is translatable in addition to the margin. */
  onlyInteractOnMargin: boolean
}

/** Pure inputs for {@link mapInputModeToCursor}. */
export type CursorMappingConfig = {
  allowTranslation: boolean
  forceTranslate: boolean
}

/**
 * Whether a position is inside the frame's interactive grab region.
 *
 * - When `grabZoneOnly` is false (or there are no grab zones), the entire
 *   frame counts as in-zone — the caller can still classify by edge / corner.
 * - When `grabZoneOnly` is true, only positions inside one of the configured
 *   rects count as in-zone; anything outside falls to Auto.
 *
 * Exported so `Frame.getInputMode()` can drive its `_isInZone` side-effect
 * from the same logic the pure classifier uses internally (single source of
 * truth — see Frame.ts).
 */
export function isPositionInZone(position: vec3, cfg: FrameClassificationConfig): boolean {
  if (cfg.grabZones.length > 0 && cfg.grabZoneOnly) {
    for (let i = 0; i < cfg.grabZones.length; i++) {
      const zone = cfg.grabZones[i]
      if (position.x >= zone.x && position.y >= zone.y && position.x <= zone.z && position.y <= zone.w) {
        return true
      }
    }
    return false
  }
  return true
}

/**
 * Whether a position falls strictly inside the inner-content rectangle
 * (not on the margin and not in a corner).
 *
 * Frame uses this to gate its mid-gesture freeze: while `_scaling` or
 * `_translating` is true and the hand drifts into the interior with
 * `onlyInteractOnMargin` enabled, the prior `_inputMode` is kept rather
 * than reset to Auto. Corner-no-permission and other Auto results from the
 * pure classifier still write through normally.
 */
export function isPositionInterior(position: vec3, cfg: FrameClassificationConfig): boolean {
  const xEdge = (cfg.innerSize.x + cfg.padding.x) * 0.5
  const yEdge = (cfg.innerSize.y + cfg.padding.y) * 0.5
  return Math.abs(position.x) <= xEdge && Math.abs(position.y) <= yEdge
}

/**
 * Classify a frame-local hit position into an InputMode based on frame geometry.
 *
 * Pure: no side effects, no dependencies on Frame instance state beyond the
 * passed-in config. Mirrors the geometry logic in Frame.getInputMode(), minus
 * the manipulator-specific gates (`innerInteractableActive`, `_scaling`,
 * `_translating`) which apply only to the manipulator's own classification —
 * Frame layers those on top after calling this helper.
 *
 * Coordinate system: position is in frame-local space, with origin at the
 * frame's center. xEdge / yEdge form a rectangle around the inner content;
 * outside that rectangle is the margin (translate zone). Past a corner
 * (`|x| > xEdge && |y| > yEdge`) the mode promotes to a Scale* variant.
 */
export function computeInputModeFromPosition(position: vec3, cfg: FrameClassificationConfig): InputMode {
  if (!isPositionInZone(position, cfg)) return InputMode.Auto

  const xEdge = (cfg.innerSize.x + cfg.padding.x) * 0.5
  const yEdge = (cfg.innerSize.y + cfg.padding.y) * 0.5

  // Corner promotions. NOTE: ScaleBottomLeft / ScaleTopRight share a diagonal,
  // and ScaleBottomRight / ScaleTopLeft share the other — that's why
  // mapInputModeToCursor groups them. The TopLeft / TopRight permission flags
  // only gate the *top* corners (the ones with a UI button, in practice).
  if (position.x < -xEdge && position.y < -yEdge && cfg.allowScaling) return InputMode.ScaleBottomLeft
  if (position.x < -xEdge && position.y > yEdge && cfg.allowScaling) {
    return cfg.allowScalingTopLeft ? InputMode.ScaleTopLeft : InputMode.Auto
  }
  if (position.x > xEdge && position.y < -yEdge && cfg.allowScaling) return InputMode.ScaleBottomRight
  if (position.x > xEdge && position.y > yEdge && cfg.allowScaling) {
    return cfg.allowScalingTopRight ? InputMode.ScaleTopRight : InputMode.Auto
  }

  // Edge (margin) → Translating.
  if (position.x > xEdge || position.x < -xEdge || position.y < -yEdge || position.y > yEdge) {
    return InputMode.Translating
  }

  // Interior. Translates when the frame allows body-drag.
  if (cfg.onlyInteractOnMargin === false) return InputMode.Translating
  return InputMode.Auto
}

/**
 * Whether dual-grab is allowed to translate the frame.
 *
 * Frame's `handleInputState()` dual branch consults this before pinning
 * `_translating = true` (which lets `Manipulate.dualInteractorsTransform`
 * run). The rule preserves the single-hand interactivity contract:
 *
 *  - Primary's classification was `Auto` (e.g. interior pinch with
 *    `onlyInteractOnMargin=true`, or a corner without the matching scale
 *    permission) → dual-grab does NOT translate. Adding a second hand must
 *    not elevate a non-interactive pinch into a gesture.
 *  - Primary qualified for SOME interaction (`Translating` or `Scale*`) →
 *    dual-grab translates the frame to the midpoint as long as either
 *    `allowTranslation` or `forceTranslate` is on (mirrors the single-hand
 *    translate permission gate).
 *
 * `primaryInputMode` is the value of Frame's `_inputMode` at dual entry —
 * snapshotted at `idle → single` from the original triggering hand's own
 * position (the v5 gesture-classification block), and frozen since.
 */
export function dualGrabShouldTranslate(
  primaryInputMode: InputMode,
  allowTranslation: boolean,
  forceTranslate: boolean
): boolean {
  if (primaryInputMode === InputMode.Auto) return false
  return allowTranslation || forceTranslate
}

/**
 * Map an InputMode (geometric zone) to a CursorMode (visual shape).
 *
 * The two diagonal Scale modes collapse to a single visual per diagonal:
 * ScaleBottomLeft + ScaleTopRight → cursor shows the "↘↖" arrows;
 * ScaleBottomRight + ScaleTopLeft → cursor shows the "↙↗" arrows.
 *
 * Translating only renders as Translate cursor when translation is actually
 * allowed (allowTranslation || forceTranslate); otherwise it falls to Auto.
 */
export function mapInputModeToCursor(mode: InputMode, cfg: CursorMappingConfig): CursorMode {
  if (mode === InputMode.ScaleBottomLeft || mode === InputMode.ScaleTopRight) {
    return CursorMode.ScaleTopRight
  }
  if (mode === InputMode.ScaleBottomRight || mode === InputMode.ScaleTopLeft) {
    return CursorMode.ScaleTopLeft
  }
  if (mode === InputMode.Translating && (cfg.allowTranslation || cfg.forceTranslate)) {
    return CursorMode.Translate
  }
  return CursorMode.Auto
}

/**
 * Per-interactor cursor decision with manipulator gating.
 *
 * Gating rules, in order:
 *   1. Inner-content suppression: if this interactor is targeting a child
 *      Interactable, the cursor is forced to Auto.
 *   2. Manipulator gating:
 *      - With a primary manipulator, the primary gets `manipulatorCursorMode`.
 *      - With a secondary manipulator (dual-grab), the secondary gets Auto.
 *      - Any other tracked interactor gets Auto.
 *   3. Per-position derivation: with no manipulators, each interactor's
 *      mode is computed from its own position.
 */
export function selectCursorMode(args: {
  interactor: Interactor
  manipulator: Interactor | null
  /**
   * Secondary manipulator in dual-grab; null in single-hand or idle.
   *
   * Currently informational — the existing gating produces Auto for the
   * secondary via the `interactor !== manipulator` branch. The arg is part
   * of the signature so dual-grab is explicit at every call site and so a
   * future per-secondary visual (e.g., a custom dual-grab cursor) can hook
   * in without changing the signature.
   */
  secondaryManipulator: Interactor | null
  /** Locked-in cursor mode for the manipulator (Frame's `_cursorMode`). */
  manipulatorCursorMode: CursorMode
  /** This interactor's own hit position (Frame's `_interactorPositions.get(i)`). */
  position: vec3 | undefined
  /**
   * Is this interactor's hit-target a child Interactable rather than the
   * Frame itself? When true, the cursor is forced to Auto regardless of
   * position or manipulator state — child Interactables provide their own
   * affordance (button highlight, etc.) and the Frame must not overlay
   * a Translate/Scale hint on top.
   */
  innerInteractableActive: boolean
  classificationConfig: FrameClassificationConfig
  cursorMappingConfig: CursorMappingConfig
}): CursorMode {
  const {
    interactor,
    manipulator,
    secondaryManipulator,
    manipulatorCursorMode,
    position,
    innerInteractableActive,
    classificationConfig,
    cursorMappingConfig
  } = args

  // 1. Inner-content gate — highest priority.
  if (innerInteractableActive) return CursorMode.Auto

  // 2. Manipulator gating.
  if (manipulator !== null) {
    if (interactor === manipulator) return manipulatorCursorMode
    // Secondary in dual-grab AND any other tracked interactor → Auto.
    return CursorMode.Auto
  }
  // secondaryManipulator without a primary should be impossible; defensive
  // fallthrough into the no-manipulator branch covers it harmlessly.
  void secondaryManipulator

  // 3. Per-position derivation.
  if (position == null) return CursorMode.Auto
  const inputMode = computeInputModeFromPosition(position, classificationConfig)
  return mapInputModeToCursor(inputMode, cursorMappingConfig)
}

// Re-export so consumers can avoid the InteractionKit.lspkg path.
export type {InteractorCursor}
