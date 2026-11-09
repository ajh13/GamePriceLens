import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import Event from "Leaf.lspkg/Utils/common/Event"

const LOG = new Logger("LeafAsrModule")

// AsrModule.AsrTranscriptionOptions.create is declared as a static method, so
// TypeScript won't let us reassign it directly -- widen through this type to
// patch and later restore it.
type AsrTranscriptionOptionsFactory = {
  create: () => AsrModule.AsrTranscriptionOptions
}

type MockAsrSession = {
  updateEvent: Event<AsrModule.TranscriptionUpdateEvent>
  errorEvent: Event<AsrModule.AsrStatusCode>
}

/**
 * Implements LeafVoiceInteractor's ASR-result seam. It intercepts an
 * AsrModule instance and replaces its transcription callback events with
 * LEAF-backed events. It does not provide audio to the microphone or to ASR.
 *
 * The lens registers handlers via `.add(...)` as usual, then
 * `triggerUpdate`/`triggerError` invoke those handlers with simulated results.
 */
export class LeafAsrModule {
  private originalStartTranscribing?: (
    options: AsrModule.AsrTranscriptionOptions,
  ) => void
  private originalStopTranscribing?: (streamType?: number) => Promise<void>
  private originalOptionsCreate?: () => AsrModule.AsrTranscriptionOptions

  private sessionsByOptions = new Map<
    AsrModule.AsrTranscriptionOptions,
    MockAsrSession
  >()
  private currentSession?: MockAsrSession
  private latestSession?: MockAsrSession

  constructor(private module: AsrModule) {
    this.originalStartTranscribing = this.module.startTranscribing.bind(
      this.module,
    )
    this.originalStopTranscribing = this.module.stopTranscribing.bind(
      this.module,
    )

    // Safe to call repeatedly. On re-subscription, AsrModule cancels the
    // current session and starts a new one.
    this.module.startTranscribing = (
      options: AsrModule.AsrTranscriptionOptions,
    ) => {
      LOG.debug("startTranscribing called")
      this.currentSession = this.sessionsByOptions.get(options)
    }

    this.module.stopTranscribing = async () => {
      LOG.debug("stopTranscribing called")
      this.currentSession = undefined
      this.latestSession = undefined
    }

    const factory =
      AsrModule.AsrTranscriptionOptions as unknown as AsrTranscriptionOptionsFactory
    this.originalOptionsCreate = factory.create.bind(factory)
    factory.create = () => {
      const session: MockAsrSession = {
        updateEvent: new Event<AsrModule.TranscriptionUpdateEvent>(),
        errorEvent: new Event<AsrModule.AsrStatusCode>(),
      }
      const options = {
        onTranscriptionUpdateEvent: session.updateEvent.publicApi(),
        onTranscriptionErrorEvent: session.errorEvent.publicApi(),
      } as unknown as AsrModule.AsrTranscriptionOptions

      this.sessionsByOptions.set(options, session)
      this.latestSession = session
      LOG.debug("mock AsrTranscriptionOptions created")
      return options
    }

    LOG.info("AsrModule intercepted")
  }

  /**
   * Deliver a transcription update to the active session's handlers.
   *
   * @param text - the (interim or final) transcription text
   * @param isFinal - whether this is the final transcription for the utterance
   */
  triggerUpdate(text: string, isFinal: boolean): void {
    const event = {
      text,
      isFinal,
    } as unknown as AsrModule.TranscriptionUpdateEvent
    this.getSession("triggerUpdate").updateEvent.invoke(event)
  }

  /**
   * Deliver a transcription error to the active session's handlers.
   *
   * @param code - the AsrStatusCode to report
   */
  triggerError(code: AsrModule.AsrStatusCode): void {
    this.getSession("triggerError").errorEvent.invoke(code)
  }

  /** Restore the original AsrModule methods and clear captured state. */
  reset(): void {
    if (this.originalStartTranscribing) {
      this.module.startTranscribing = this.originalStartTranscribing
    }
    if (this.originalStopTranscribing) {
      this.module.stopTranscribing = this.originalStopTranscribing
    }
    if (this.originalOptionsCreate) {
      const factory =
        AsrModule.AsrTranscriptionOptions as unknown as AsrTranscriptionOptionsFactory
      factory.create = this.originalOptionsCreate
      this.originalOptionsCreate = undefined
    }

    this.sessionsByOptions.clear()
    this.currentSession = undefined
    this.latestSession = undefined

    LOG.info("AsrModule restored")
  }

  private getSession(method: string): MockAsrSession {
    // Prefer the session selected by startTranscribing. The latest created
    // options still lets the mock work if the lens resolves AsrModule through
    // another wrapper but uses the patched AsrTranscriptionOptions factory.
    const session = this.currentSession ?? this.latestSession
    if (!session) {
      throw new Error(
        `LeafAsrModule.${method}: no captured AsrTranscriptionOptions. ` +
          "Construct LeafVoiceInteractor before the lens creates its options.",
      )
    }
    return session
  }
}
