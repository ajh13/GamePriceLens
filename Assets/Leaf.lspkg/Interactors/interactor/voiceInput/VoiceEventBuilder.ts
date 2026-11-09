/**
 * Error types the interactor can simulate, aligned with AsrModule.AsrStatusCode
 */
export type VoiceErrorType =
  | "no_internet"
  | "timeout"
  | "unauthenticated"
  | "backend_failure"

const ERROR_STATUS_MAP: Record<VoiceErrorType, AsrModule.AsrStatusCode> = {
  backend_failure: AsrModule.AsrStatusCode.InternalError,
  unauthenticated: AsrModule.AsrStatusCode.Unauthenticated,
  no_internet: AsrModule.AsrStatusCode.NoInternet,
  timeout: AsrModule.AsrStatusCode.InternalError,
}

/**
 * Map a VoiceErrorType to the closest AsrModule.AsrStatusCode.
 *
 * @param errorType - the simulated error
 * @returns the matching AsrStatusCode (timeout falls back to InternalError)
 */
export function mapVoiceErrorToAsrStatus(
  errorType: VoiceErrorType,
): AsrModule.AsrStatusCode {
  return ERROR_STATUS_MAP[errorType]
}
