import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {InteractionStrategy} from "./DiagnosticRecorder"

/** Body-frame offset components in centimeters. Positive = forward of / above / outward from the active side. */
export type BodyAxes = {
  forward: number
  up: number
  lateral: number
}

/**
 * Snapshot of body anchors + target geometry shared by the reach diagnostics
 * (`UnreachableFarDirect`, `UnreachableBehind`, `UnreachableCrossBody`,
 * `ReachMarginal`). Built once per trigger/drag/scale call from the current
 * arm-model keypoints so every check evaluates against the same frame.
 */
export type ReachContext = {
  readonly target: Interactable
  readonly handSide: Side
  readonly operation: string
  readonly strategy: InteractionStrategy
  readonly shoulder: vec3
  readonly headPosition: vec3
  /** On-spine reference for midline checks. `shoulder` is itself ~20cm laterally off-midline, which would inflate cross-body distances. */
  readonly bodyCenter: vec3
  /** Where the IK will actually place the wrist (Interactable pivot transformed through the hand's pinch-grip offset). */
  readonly wristTargetWorld: vec3
  readonly bodyForward: vec3
  readonly bodyDown: vec3
  readonly bodyRight: vec3
}

/** Straight-line distance from shoulder anchor to the wrist target. */
export function reachDistance(context: ReachContext): number {
  return context.wristTargetWorld.sub(context.shoulder).length
}

/** Body-frame breakdown of the shoulder→wrist-target vector. */
export function missAxes(context: ReachContext): BodyAxes {
  const offset = context.wristTargetWorld.sub(context.shoulder)
  const lateralSign = context.handSide === "left" ? -1 : 1
  return {
    forward: offset.dot(context.bodyForward),
    up: -offset.dot(context.bodyDown),
    lateral: offset.dot(context.bodyRight.uniformScale(lateralSign)),
  }
}

/** 180° = fully locked; smaller = more bent. Clamped to 180° when `distance` exceeds chain length. */
export function elbowAngleDeg(
  distance: number,
  upperArm: number,
  forearm: number,
): number {
  const cap = upperArm + forearm
  if (distance >= cap) return 180
  const cos = (upperArm * upperArm + forearm * forearm - distance * distance) /
    (2 * upperArm * forearm)
  return Math.acos(Math.max(-1, Math.min(1, cos))) * MathUtils.RadToDeg
}

export function diagnosticHeader(context: ReachContext, targetName: string): string {
  return `[IK ${context.handSide} (${context.strategy})] ${context.operation} "${targetName}"`
}
