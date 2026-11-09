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
} from "../ReachContext"

/** Target is behind the shoulder plane (arm can't reach behind the back). */
export class UnreachableBehind implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "unreachable_behind"
  readonly severity: Severity = "error"

  constructor(private readonly context: ReachContext) {}

  private _behindCm: number = 0
  private _targetName: string = UNKNOWN_TARGET_NAME

  get handSide(): Side { return this.context.handSide }

  get message(): string {
    return `${diagnosticHeader(this.context, this._targetName)}: ${this._behindCm.toFixed(1)}cm behind the shoulder.`
  }

  /** @inheritDoc */
  applies(): boolean {
    const axes = missAxes(this.context)
    if (axes.forward >= 0) return false
    const sceneObject = this.context.target.getSceneObject()
    if (isNull(sceneObject)) return false
    this._behindCm = Math.abs(axes.forward)
    this._targetName = sceneObject.name
    return true
  }
}
