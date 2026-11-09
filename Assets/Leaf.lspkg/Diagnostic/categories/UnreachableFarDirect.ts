import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {
  CheckableDiagnostic,
  DiagnosticCategory,
  Severity,
  UNKNOWN_TARGET_NAME,
} from "../DiagnosticRecorder"
import {
  ReachContext,
  diagnosticHeader,
  missAxes,
  reachDistance,
} from "../ReachContext"

/**
 * Wrist target is beyond what the IK can actually deliver — past
 * `WRIST_MAX_REACH_CM` (the soft-cap the arm model clamps to). Targets in
 * the gap between the soft cap and the physical chain (40+30=70cm) are also
 * flagged here: the IK clamps them, so the visual arm lands short.
 */
export class UnreachableFarDirect implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "unreachable_far_direct"
  readonly severity: Severity = "error"

  constructor(
    private readonly context: ReachContext,
    private readonly maxReachCm: number,
  ) {}

  private _detail: string = ""
  private _targetName: string = UNKNOWN_TARGET_NAME

  get handSide(): Side { return this.context.handSide }

  get message(): string {
    return `${diagnosticHeader(this.context, this._targetName)}: ${this._detail}`
  }

  /** @inheritDoc */
  applies(): boolean {
    const distance = reachDistance(this.context)
    if (distance <= this.maxReachCm) return false
    const sceneObject = this.context.target.getSceneObject()
    if (isNull(sceneObject)) return false
    const axes = missAxes(this.context)
    this._targetName = sceneObject.name
    this._detail = `wrist target ${distance.toFixed(1)}cm from shoulder; IK clamps at ${this.maxReachCm.toFixed(1)}cm (${(distance - this.maxReachCm).toFixed(1)}cm short). Forward ${axes.forward.toFixed(1)}cm, up ${axes.up.toFixed(1)}cm, lateral ${axes.lateral.toFixed(1)}cm.`
    return true
  }
}
