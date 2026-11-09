import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {
  CheckableDiagnostic,
  DiagnosticCategory,
  Severity,
} from "../DiagnosticRecorder"

/**
 * Target's `SceneObject` is null or destroyed. Fires because the SceneObject
 * is gone, so there's no name left to display — `message` just states the
 * operation that was attempted.
 */
export class TargetMissing implements CheckableDiagnostic {
  readonly category: DiagnosticCategory = "target_missing"
  readonly severity: Severity = "error"

  constructor(
    private readonly target: Interactable,
    private readonly operation: string,
    readonly handSide?: Side,
  ) {}

  get message(): string {
    const handSidePrefix = this.handSide ? `[IK ${this.handSide}] ` : ""
    return `${handSidePrefix}${this.operation}: target SceneObject is null or destroyed.`
  }

  /** @inheritDoc */
  applies(): boolean {
    return isNull(this.target?.getSceneObject?.())
  }
}
