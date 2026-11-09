import {Side} from "Leaf.lspkg/IKSolver/Pose"

/** Placeholder for a target whose SceneObject was destroyed before a name could be captured. */
export const UNKNOWN_TARGET_NAME = "<unknown>"

/** Which interaction strategy was active when a diagnostic fired. */
export type InteractionStrategy = "direct" | "indirect"

/** Errors fail the scenario at end; warnings surface in the report only. */
export type Severity = "error" | "warning"

/**
 * How error-severity diagnostics affect the in-flight IK action.
 * - `fallback`: skip IK, run the configured IK fallback so downstream events still fire.
 * - `fail-fast`: throw from `checkAndRecord` at the firing call site.
 * Warnings are always just recorded.
 */
export type DiagnosticPolicy = "fallback" | "fail-fast"

/**
 * Tag every diagnostic carries. Add a new entry here when adding a new
 * diagnostic class; the class's `category` field is type-checked against
 * this union via `implements Diagnostic`.
 */
export type DiagnosticCategory =
  | "target_missing"
  | "out_of_fov"
  | "target_overlap"
  | "convergence_timeout"
  | "unreachable_far_direct"
  | "unreachable_far_indirect"
  | "unreachable_behind"
  | "unreachable_cross_body"
  | "reach_marginal"

/** Shape every diagnostic implements. Concrete classes add their own category-specific fields. */
export interface Diagnostic {
  readonly category: DiagnosticCategory
  readonly severity: Severity
  /** Which hand the diagnostic refers to, when applicable (omit for two-handed operations like scale). */
  readonly handSide?: Side
  readonly message: string
}

/** A diagnostic plus the time it was recorded. */
export type Entry = {
  /** Seconds since scenario start. */
  timestamp: number
  diagnostic: Diagnostic
}

/**
 * A diagnostic that knows whether it applies. `applies()` runs the check and
 * populates any internal fields the message renders from; it returns `true`
 * when the diagnostic applies, `false` otherwise. The recording side is
 * owned by `DiagnosticRecorder.checkAndRecord`.
 */
export interface CheckableDiagnostic extends Diagnostic {
  applies(): boolean
}

/**
 * Accumulator for diagnostics over the lifetime of a single scenario run.
 * Singleton owned by the scenario manager: `reset` at start, `hasErrors` +
 * `toReport` at end.
 */
export class DiagnosticRecorder {
  private static instance: DiagnosticRecorder

  private entries: Entry[] = []
  private startTimeMs: number = 0
  private _policy: DiagnosticPolicy = "fallback"

  private constructor() {}

  /** How firing diagnostics interact with the current IK action. See {@link DiagnosticPolicy}. */
  get policy(): DiagnosticPolicy {
    return this._policy
  }

  /**
   * Safe to change between calls; takes effect on the next firing diagnostic.
   * @param policy - new policy for `checkAndRecord`.
   */
  setPolicy(policy: DiagnosticPolicy): void {
    this._policy = policy
  }

  /** @returns the process-wide singleton, creating it on first call. */
  static getInstance(): DiagnosticRecorder {
    if (!DiagnosticRecorder.instance) {
      DiagnosticRecorder.instance = new DiagnosticRecorder()
    }
    return DiagnosticRecorder.instance
  }

  /** Clear all recorded entries, restart the scenario-relative clock, and restore the default policy so the previous scenario's setting doesn't leak. */
  reset(): void {
    this.entries = []
    this.startTimeMs = Date.now()
    this._policy = "fallback"
  }

  /**
   * Append `diagnostic` to the report, time-stamped relative to the last
   * `reset()`.
   *
   * @param diagnostic - The diagnostic to record.
   * @returns the passed-in `diagnostic`, for chaining.
   */
  record<T extends Diagnostic>(diagnostic: T): T {
    this.entries.push({
      timestamp: (Date.now() - this.startTimeMs) / 1000,
      diagnostic,
    })
    return diagnostic
  }

  /**
   * Run `diagnostic.applies()`; if it returns `true`, append the
   * diagnostic to the report and apply the current {@link policy}.
   *
   * @param diagnostic - The diagnostic to check.
   * @returns `true` when the diagnostic applied (and was recorded), `false`
   *   otherwise. Callers that need to abort their flow on a fired check
   *   can branch on this return value.
   * @throws when the policy is `"fail-fast"` and an error-severity diagnostic fired.
   */
  checkAndRecord<T extends CheckableDiagnostic>(diagnostic: T): boolean {
    if (!diagnostic.applies()) return false
    this.record(diagnostic)
    if (this._policy === "fail-fast" && diagnostic.severity === "error") {
      throw new Error(diagnostic.message)
    }
    return true
  }

  /** @returns all entries recorded since the last `reset()`, in insertion order. */
  getAll(): readonly Entry[] {
    return this.entries
  }

  /** @returns `true` if any recorded entry has `severity === "error"`. */
  hasErrors(): boolean {
    return this.entries.some((e) => e.diagnostic.severity === "error")
  }

  /**
   * Render the accumulated diagnostics as a human-readable, multi-line string
   * suitable for the scenario log and the in-world overlay.
   *
   * @returns the rendered report, or `""` if nothing was recorded.
   */
  toReport(): string {
    if (this.entries.length === 0) return ""

    const errorCount = this.entries.filter((e) => e.diagnostic.severity === "error").length
    const warningCount = this.entries.length - errorCount

    const lines: string[] = [
      "",
      `Summary: ❌ ${errorCount} errors, ⚠️ ${warningCount} warnings`,
    ]
    for (const {timestamp, diagnostic} of this.entries) {
      const icon = diagnostic.severity === "error" ? "❌" : "⚠️"
      const time = timestamp.toFixed(3)
      /** Use `lastIndexOf('": ')` so an interactable name containing `": "` (e.g. `Section: Submit`) doesn't split inside the name. */
      const splitIdx = diagnostic.message.lastIndexOf('": ')
      const reformatted = splitIdx >= 0
        ? `${diagnostic.message.slice(0, splitIdx + 1)}: ${diagnostic.category}${diagnostic.message.slice(splitIdx + 1)}`
        : `${diagnostic.message}: ${diagnostic.category}`
      lines.push("")
      lines.push(`  ${icon} [${time}s] ${reformatted}`)
    }
    return lines.join("\n")
  }
}
