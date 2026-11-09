import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {Diagnostic, DiagnosticCategory, Severity} from "../DiagnosticRecorder"

/**
 * IK reported a different interactable than the scenario requested at the
 * moment of pinch. Recorded inline (no synchronous check); the caller passes
 * pre-captured names so the message getter never dereferences a SceneObject.
 */
export class TargetOverlap implements Diagnostic {
  readonly category: DiagnosticCategory = "target_overlap"
  readonly severity: Severity = "warning"

  constructor(
    readonly handSide: Side,
    private readonly operation: string,
    private readonly requested: string,
    private readonly resolved: string,
  ) {}

  get message(): string {
    return `[IK ${this.handSide}] ${this.operation}: about to pinch "${this.resolved}" but scenario requested "${this.requested}". Possible overlap or descendant resolution.`
  }
}
