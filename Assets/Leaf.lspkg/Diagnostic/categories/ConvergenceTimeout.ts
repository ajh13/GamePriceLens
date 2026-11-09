import {Side} from "Leaf.lspkg/IKSolver/Pose"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {
  Diagnostic,
  DiagnosticCategory,
  DiagnosticRecorder,
  Severity,
} from "../DiagnosticRecorder"

/** Convergence wait expired. Recorded by `withTimeoutOrRecord`. */
export class ConvergenceTimeout implements Diagnostic {
  readonly category: DiagnosticCategory = "convergence_timeout"
  readonly severity: Severity = "error"

  constructor(
    readonly handSide: Side,
    readonly message: string,
    readonly timeoutMs: number,
    readonly interactableName?: string,
  ) {}
}

const TIMEOUT_FIRED: unique symbol = Symbol("TIMEOUT_FIRED")

/**
 * Race `promise` against a timeout. On timeout, record a `ConvergenceTimeout`
 * and resolve with `undefined` instead of throwing.
 */
export async function withTimeoutOrRecord<T>(
  promise: Promise<T>,
  timeoutMs: number,
  info: {message: string; handSide: Side; interactableName?: string},
): Promise<T | undefined> {
  /** `sleep` schedules a DelayedCallbackEvent we can't cancel; guard with `settled` so a late tick doesn't pollute the next scenario. `try/finally` flips `settled` on `promise` rejection too — otherwise the late timer would record against an unrelated scenario. */
  let settled = false
  const timeoutPromise: Promise<typeof TIMEOUT_FIRED> = sleep(timeoutMs).then(
    () => {
      if (!settled) {
        DiagnosticRecorder.getInstance().record(
          new ConvergenceTimeout(info.handSide, info.message, timeoutMs, info.interactableName),
        )
      }
      return TIMEOUT_FIRED
    },
  )
  let result: T | typeof TIMEOUT_FIRED
  try {
    result = await Promise.race([promise, timeoutPromise])
  } finally {
    settled = true
  }
  if (result === TIMEOUT_FIRED) return undefined
  return result as T
}
