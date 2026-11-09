import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {
  CheckableDiagnostic,
  DiagnosticCategory,
  Severity,
  UNKNOWN_TARGET_NAME,
} from "../DiagnosticRecorder"
import {ReachContext, diagnosticHeader} from "../ReachContext"

/** Target sits beyond IK's indirect-raycast cap — IK won't hover it from the head ray. */
export class UnreachableFarIndirect implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "unreachable_far_indirect"
  readonly severity: Severity = "error"

  constructor(
    private readonly context: ReachContext,
    private readonly maxRaycastCm: number,
  ) {}

  private _distance: number = 0
  private _targetName: string = UNKNOWN_TARGET_NAME

  get handSide(): Side { return this.context.handSide }

  get message(): string {
    return `${diagnosticHeader(this.context, this._targetName)}: ${this._distance.toFixed(1)}cm from head; IK indirect raycast cap is ${this.maxRaycastCm.toFixed(0)}cm.`
  }

  /** @inheritDoc */
  applies(): boolean {
    const sceneObject = this.context.target.getSceneObject()
    if (isNull(sceneObject)) return false
    const targetWorld = sceneObject.getTransform().getWorldPosition()
    this._distance = targetWorld.sub(this.context.headPosition).length
    if (this._distance <= this.maxRaycastCm) return false
    this._targetName = sceneObject.name
    return true
  }
}
