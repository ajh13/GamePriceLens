import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {JointPose, Side, angleFromHeadForwardDeg} from "Leaf.lspkg/IKSolver/Pose"
import {
  CheckableDiagnostic,
  DiagnosticCategory,
  Severity,
  UNKNOWN_TARGET_NAME,
} from "../DiagnosticRecorder"

/** Fires after `waitForHeadAimedAt` if the target still sits outside the head's forward cone — the system tried to aim and the user wasn't lookable-at. */
export class OutOfFov implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "out_of_fov"
  readonly severity: Severity = "error"

  constructor(
    private readonly target: Interactable,
    private readonly operation: string,
    private readonly headPose: JointPose,
    private readonly halfAngleDeg: number,
    readonly handSide?: Side,
  ) {}

  private _angleDeg: number = 0
  private _targetName: string = UNKNOWN_TARGET_NAME

  get message(): string {
    const handSidePrefix = this.handSide ? `[IK ${this.handSide}] ` : ""
    return `${handSidePrefix}${this.operation} "${this._targetName}": still outside FOV (${this._angleDeg.toFixed(1)}° off-axis) after head aim.`
  }

  /** @inheritDoc */
  applies(): boolean {
    const sceneObject = this.target.getSceneObject()
    if (isNull(sceneObject)) return false
    const targetWorld = sceneObject.getTransform().getWorldPosition()
    this._angleDeg = angleFromHeadForwardDeg(this.headPose, targetWorld)
    if (this._angleDeg <= this.halfAngleDeg) return false
    this._targetName = sceneObject.name
    return true
  }
}
