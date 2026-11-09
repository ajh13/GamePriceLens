import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {
  CheckableDiagnostic,
  DiagnosticCategory,
  Severity,
  UNKNOWN_TARGET_NAME,
} from "../DiagnosticRecorder"
import {ReachContext, diagnosticHeader} from "../ReachContext"

/** Target is across the body midline by more than `thresholdCm` — would require a cross-body reach. */
export class UnreachableCrossBody implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "unreachable_cross_body"
  readonly severity: Severity = "error"

  constructor(
    private readonly context: ReachContext,
    private readonly thresholdCm: number,
  ) {}

  private _acrossCm: number = 0
  private _targetName: string = UNKNOWN_TARGET_NAME

  get handSide(): Side { return this.context.handSide }

  get message(): string {
    return `${diagnosticHeader(this.context, this._targetName)}: ${this._acrossCm.toFixed(1)}cm across the body midline.`
  }

  /** @inheritDoc */
  applies(): boolean {
    const lateralSign = this.context.handSide === "left" ? -1 : 1
    /** Measure from `bodyCenter` (on-spine), not `shoulder` — `shoulder` is itself ~20cm laterally off-midline, which would inflate the reported distance. */
    const offsetFromCenter = this.context.wristTargetWorld.sub(this.context.bodyCenter)
    const lateral = offsetFromCenter.dot(this.context.bodyRight) * lateralSign
    if (lateral >= -this.thresholdCm) return false
    const sceneObject = this.context.target.getSceneObject()
    if (isNull(sceneObject)) return false
    this._acrossCm = Math.abs(lateral)
    this._targetName = sceneObject.name
    return true
  }
}
