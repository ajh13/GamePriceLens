import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"
import {LeafAsrModule} from "./LeafAsrModule"
import {VoiceErrorType, mapVoiceErrorToAsrStatus} from "./VoiceEventBuilder"

export type {VoiceErrorType} from "./VoiceEventBuilder"

export interface LeafVoiceInteractorOptions {
  interimDelayMs?: number
  finalDelayMs?: number
}

export interface SayOptions {
  isFinal?: boolean
  delayMs?: number
}

const DEFAULT_INTERIM_DELAY_MS = 200
const DEFAULT_FINAL_DELAY_MS = 100

const LOG = new Logger("LeafVoiceInteractor")

/**
 * Simulates transcription results from an AsrModule session for LEAF
 * scenarios. This is an ASR-result test seam: it does not inject microphone
 * samples, play audio into AsrModule, or invoke the real ASR service.
 *
 * Use it to deterministically test lens behavior after ASR has produced an
 * interim result, final transcription, or error. Cover microphone capture,
 * recognition quality, and service latency with hardware or platform tests.
 * Automatically detaches when the scenario completes.
 */
export class LeafVoiceInteractor {
  private asrMock: LeafAsrModule
  private lifecycle = LeafLifecycle.getInstance()
  private detached = false

  private destroyCallback = () => {
    this.detach()
  }

  private interimDelayMs: number
  private finalDelayMs: number

  /**
   * @param module - the AsrModule the lens under test transcribes with
   * @param options - interimDelayMs/finalDelayMs pacing overrides
   */
  constructor(module: AsrModule, options?: LeafVoiceInteractorOptions) {
    this.interimDelayMs = options?.interimDelayMs ?? DEFAULT_INTERIM_DELAY_MS
    this.finalDelayMs = options?.finalDelayMs ?? DEFAULT_FINAL_DELAY_MS
    this.asrMock = new LeafAsrModule(module)
    this.lifecycle.onCleanup.add(this.destroyCallback)
  }

  /**
   * Deliver one final transcription, or a sequence of interim results followed
   * by a final one.
   *
   * @param text - transcription text, or interim segments with the last segment final
   * @param options - isFinal for a single string, plus an optional delayMs override
   */
  async say(text: string | string[], options?: SayOptions): Promise<void> {
    const segments = typeof text === "string" ? [text] : text

    for (let i = 0; i < segments.length; i++) {
      const isFinal =
        typeof text === "string"
          ? (options?.isFinal ?? true)
          : i === segments.length - 1
      const delayMs =
        options?.delayMs ?? (isFinal ? this.finalDelayMs : this.interimDelayMs)

      this.asrMock.triggerUpdate(segments[i], isFinal)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
    LOG.debug(`say completed (${segments.length} segment(s))`)
  }

  /**
   * Deliver a transcription error to the lens.
   *
   * @param errorType - the error to simulate (mapped to an AsrStatusCode)
   */
  async triggerError(errorType: VoiceErrorType): Promise<void> {
    this.asrMock.triggerError(mapVoiceErrorToAsrStatus(errorType))

    await sleep(this.finalDelayMs)
    LOG.debug(`triggerError("${errorType}")`)
  }

  /**
   * Restore the original AsrModule methods. Also called automatically by
   * LeafLifecycle when the scenario completes.
   */
  detach(): void {
    if (this.detached) {
      return
    }
    this.asrMock.reset()
    this.lifecycle.onCleanup.remove(this.destroyCallback)
    this.detached = true
    LOG.info("Detached voice mock")
  }
}
