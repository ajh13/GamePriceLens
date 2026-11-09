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
  elbowAngleDeg,
  reachDistance,
} from "../ReachContext"

/**
 * Elbow is near full extension at the wrist target — IK reaches, but
 * the arm visually looks locked. Warning only.
 */
export class ReachMarginal implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "reach_marginal"
  readonly severity: Severity = "warning"

  constructor(
    private readonly context: ReachContext,
    private readonly upperArmCm: number,
    private readonly forearmCm: number,
    private readonly thresholdElbowDeg: number,
  ) {}

  private _elbowDeg: number = 0
  private _targetName: string = UNKNOWN_TARGET_NAME

  get handSide(): Side { return this.context.handSide }

  get message(): string {
    return `${diagnosticHeader(this.context, this._targetName)}: elbow at ${this._elbowDeg.toFixed(0)}° (180° = locked; flagged ≥ ${this.thresholdElbowDeg}°).`
  }

  /** @inheritDoc */
  applies(): boolean {
    const elbowDeg = elbowAngleDeg(reachDistance(this.context), this.upperArmCm, this.forearmCm)
    if (elbowDeg < this.thresholdElbowDeg) return false
    const sceneObject = this.context.target.getSceneObject()
    if (isNull(sceneObject)) return false
    this._elbowDeg = elbowDeg
    this._targetName = sceneObject.name
    return true
  }
}
