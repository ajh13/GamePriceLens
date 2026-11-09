import {Logger, LogLevel} from "Leaf.lspkg/Utils/common/Logger"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"
import {UpdateDispatcher} from "Leaf.lspkg/Utils/common/UpdateDispatcher"
import {withTimeout} from "Leaf.lspkg/Utils/common/Utils"
import {combineErrors, errorMessage} from "Leaf.lspkg/Utils/common/Errors"
import {InteractionTracer} from "Leaf.lspkg/Utils/debug/InteractionTracer"
import {
  DiagnosticPolicy,
  DiagnosticRecorder,
} from "Leaf.lspkg/Diagnostic/DiagnosticRecorder"
import {DiagnosticReportOverlay} from "Leaf.lspkg/Diagnostic/DiagnosticReportOverlay"
import {UserInputSuppressor} from "Leaf.lspkg/Interactors/interactor/UserInputSuppressor"
import {
  restoreHandRigs,
  settleHandRigs,
  warmHandRigs,
} from "Leaf.lspkg/Interactors/interactor/handInput/HandRig"
import {Scenario} from "../Scenario"
import {
  ScenarioConfig,
  ResolvedScenarioConfig,
  RESERVED_PARAMS,
  RESERVED_PARAM_KEYS,
} from "../ScenarioConfig"
import {ScenarioManager, AwaitScenarioComplete} from "./ScenarioManager"
import {ScenarioRegistry} from "./ScenarioRegistry"
import {
  ParameterType,
  ScenarioMetadata,
  parameterDefault,
  parameterTypeOf,
} from "../ScenarioMetadata"
import {EnsembleInfo, EnsembleMetadata} from "../../connected/EnsembleMetadata"
import {ParticipantAgent} from "../../connected/ParticipantAgent"
import {
  ParticipantContext,
  ParticipantEnvironment,
} from "../../connected/ParticipantContext"
import {
  LEAF_ROLE_KEY,
  LEAF_HANDLE_KEY,
  LEAF_RUN_ID_KEY,
  LEAF_RUN_START_TIMEOUT_MS_KEY,
  DEFAULT_RUN_START_TIMEOUT_MS,
  RUN_START_RENDEZVOUS,
} from "../../connected/ConnectedMessages"
import Event from "Leaf.lspkg/Utils/common/Event"

const LOG = new Logger("DefaultLeafScenarioManager")

/**
 * Default implementation of the {@link ScenarioManager}, as a singleton.
 * Not a component, because it shouldn't be set directly in the space.
 *
 * Owns one {@link ScenarioRegistry} for Scenarios and Ensembles (they share an
 * id namespace) and runs both kinds of start: a plain Scenario, or -
 * when the start config carries a Role - one Participant's leg of a
 * ConnectedRun (resolve the Ensemble + Role to a Scenario, hold at the implicit
 * run-start Rendezvous, run, report). The ConnectedRun path is gated by
 * `@enableConnectedRuns()`; a lens that never opts in never enters it.
 */
export class DefaultScenarioManager implements ScenarioManager {
  private readonly registry = new ScenarioRegistry()
  private connectedRunsEnabled = false
  /** Admitted ConnectedRun, retained through the start barrier and Scenario cleanup. */
  private pendingRun?: Promise<void>
  /** Pending and admitted starts by run ID; shares duplicate starts and excludes ordinary runs. */
  private readonly starts = new Map<string, Promise<void>>()

  private static instance: DefaultScenarioManager

  private scenarioCompleteEvent = new Event()
  /**
   * Event to be invoked after running a scenario to completion
   */
  onScenarioComplete = this.scenarioCompleteEvent.publicApi()

  private constructor(private owner: SceneObject) {}

  /**
   * @returns the singleton default manager (created on first use).
   */
  static getInstance(): DefaultScenarioManager {
    if (!this.instance) {
      const owner = global.scene.createSceneObject("LeafScenarioManager")
      this.instance = new DefaultScenarioManager(owner)
    }

    return this.instance
  }

  /**
   * Opt the lens into ConnectedRuns - called by `@enableConnectedRuns()` at
   * class-definition time. Until then a start carrying a Role is refused with an
   * explanatory error rather than entering the connected path.
   */
  enableConnectedRuns(): void {
    this.connectedRunsEnabled = true
  }

  registerScenario(metadata: ScenarioMetadata): void {
    LOG.info(`Register scenario: ${metadata.id}`, false)
    this.registry.registerScenario(metadata)
    if (metadata.parameters) {
      const paramKeys = Object.keys(metadata.parameters)
      LOG.debug(
        `Scenario "${metadata.id}" params: [${paramKeys.join(", ")}]`,
        false,
      )
    }
  }

  registerEnsemble(metadata: EnsembleMetadata): void {
    LOG.info(`Register ensemble: ${metadata.id}`, false)
    this.registry.registerEnsemble(metadata)
  }

  listScenarioIds(): string[] {
    return this.registry.listScenarioIds()
  }

  listEnsembles(): EnsembleInfo[] {
    return this.registry.listEnsembles()
  }

  listScenarioParameters(scenarioId: string): Record<string, string> {
    const metadata = this.registry.getScenario(scenarioId)
    if (!metadata) {
      throw Error(`No test scenario with ID: "${scenarioId}"`)
    }
    const declared = metadata.parameters || {}
    const params = Object.fromEntries(
      Object.entries(declared).map(([key, parameter]) => [
        key,
        parameterDefault(parameter),
      ]),
    )
    const defaults = Object.fromEntries(
      Object.entries(RESERVED_PARAMS).filter(([key]) => !(key in params)),
    )
    return {...params, ...defaults}
  }

  listScenarioParameterTypes(
    scenarioId: string,
  ): Record<string, ParameterType> {
    const metadata = this.registry.getScenario(scenarioId)
    if (!metadata) {
      throw Error(`No test scenario with ID: "${scenarioId}"`)
    }
    const declared = metadata.parameters || {}
    return Object.fromEntries(
      Object.entries(declared).map(([key, parameter]) => [
        key,
        parameterTypeOf(parameter),
      ]),
    )
  }

  /**
   * Start a Scenario, or this Participant's leg of an Ensemble when `args`
   * carries a Role. Registration and required start metadata are validated
   * synchronously before message handlers acknowledge the start.
   */
  startScenario(
    scenarioId: string,
    args?: ScenarioConfig,
  ): AwaitScenarioComplete {
    const role = args?.get(LEAF_ROLE_KEY)
    if (role !== undefined) {
      return this.startConnectedRun(scenarioId, role, args!)
    }
    if (this.registry.hasEnsemble(scenarioId)) {
      // Say so rather than surface a misleading "No test scenario with ID".
      throw new Error(
        `"${scenarioId}" is an Ensemble, not a Scenario. Run it as a ConnectedRun from the LEAF panel.`,
      )
    }
    if (this.starts.size) {
      throw new Error(
        "A ConnectedRun is awaiting admission or still executing; wait for it to finish before starting a Scenario.",
      )
    }
    return this.runScenario(scenarioId, args)
  }

  /**
   * One Participant's leg of a ConnectedRun: resolve the Ensemble + Role to a
   * Scenario, install the Participant context the Scenario base class reads,
   * hold at the implicit run-start Rendezvous, run, and report the
   * outcome to the plugin tagged with the Handle.
   */
  private startConnectedRun(
    ensembleId: string,
    role: string,
    args: ScenarioConfig,
  ): AwaitScenarioComplete {
    if (!this.connectedRunsEnabled) {
      throw new Error(
        `Ensemble "${ensembleId}" cannot run: this lens has not opted into ConnectedRuns. Add @enableConnectedRuns() to the scenario index.`,
      )
    }
    // Resolve synchronously so a bad mapping throws before the handler replies "running".
    const resolvedScenarioId = this.registry.resolveRole(ensembleId, role)
    /*
     * A Role without a run id or Handle is a malformed start (plugin/package
     * version skew). Refuse it here, where the handlers turn a throw into an
     * immediate error reply; defaulting would fail later, deep in the run, with
     * a misleading "outside a ConnectedRun".
     */
    const handle = args.get(LEAF_HANDLE_KEY)
    const runId = args.get(LEAF_RUN_ID_KEY)
    if (runId === undefined || handle === undefined) {
      throw new Error(
        `Ensemble "${ensembleId}": ConnectedRun start is missing ${runId === undefined ? LEAF_RUN_ID_KEY : LEAF_HANDLE_KEY}. The LEAF plugin and package versions may be mismatched.`,
      )
    }
    const environment: ParticipantEnvironment =
      global.deviceInfoSystem.isEditor() ? "preview" : "device"
    // Throws synchronously if the bridge is missing, which is the right moment.
    const agent = ParticipantAgent.requireInstance()
    const duplicate = this.starts.get(runId)
    if (duplicate) {
      LOG.info(
        `ConnectedRun ${runId}: duplicate start shares the existing admission.`,
        false,
      )
      return duplicate
    }
    if (!agent.prepareRun(runId)) {
      if (agent.isCurrentRun(runId)) return this.pendingRun ?? Promise.resolve()
      throw new Error(agent.refusedStartReason(runId))
    }

    const previous = this.pendingRun
    let completion!: Promise<void>
    completion = (async () => {
      try {
        if (previous) {
          let cancel = () => {}
          const frame = new Promise<void>((resolve) => {
            cancel =
              UpdateDispatcher.getInstance().createNextFrameEvent(resolve)
          })
          try {
            await Promise.race([previous.catch(() => {}), frame])
          } finally {
            cancel()
          }
        }
        if (this.pendingRun)
          throw new Error(
            "Previous ConnectedRun is still executing or awaiting admission; wait for it to finish or reset this lens.",
          )
        if (!agent.isFreshStart(runId))
          throw new Error(
            `ConnectedRun ${runId}: start was aborted or superseded before admission.`,
          )
        await LeafLifecycle.getInstance().waitForReusable()
        if (this.pendingRun)
          throw new Error(
            "ConnectedRun admission is busy; retry after the current run finishes.",
          )
        if (!agent.beginRun(runId, handle))
          throw new Error(
            `ConnectedRun ${runId}: start was aborted or superseded before admission.`,
          )
      } catch (error) {
        agent.reportRefusedStart(runId, handle, errorMessage(error))
        throw error
      }
      this.pendingRun = completion
      const context = new ParticipantContext(
        {handle, role, environment},
        (name) => agent.rendezvous(name, runId),
      )
      try {
        LOG.info(
          `ConnectedRun ${runId}: Participant ${handle} (${environment}) runs Role "${role}" → "${resolvedScenarioId}".`,
          false,
        )
        /* Peer admission time does not count toward the Scenario timeout. */
        let cancel = () => {}
        const configuredTimeoutMs = Number(
          args.get(LEAF_RUN_START_TIMEOUT_MS_KEY),
        )
        const timeoutMs =
          Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
            ? configuredTimeoutMs
            : DEFAULT_RUN_START_TIMEOUT_MS
        const deadline = new Promise<never>((_, reject) => {
          cancel = UpdateDispatcher.getInstance().createDelayedEvent(() => {
            reject(
              new Error(
                `ConnectedRun ${runId}: run-start admission timed out after ${timeoutMs}ms; retry or reset this lens.`,
              ),
            )
          }, timeoutMs / 1000)
        })
        try {
          await Promise.race([
            agent.rendezvous(RUN_START_RENDEZVOUS, runId),
            deadline,
          ])
        } finally {
          cancel()
        }
        agent.confirmRun(runId)
        await this.runScenario(
          resolvedScenarioId,
          args,
          context,
          agent.currentAbortSignal(),
        )
        /* Attribute the result by Handle and run ID despite unstable preview wrappers. */
        this.report(agent, runId, "succeeded")
      } catch (error) {
        /* Log failures before runScenario too, including admission and orchestrator aborts. */
        LOG.error(
          `ConnectedRun ${runId}: Participant ${handle} failed - ${error}`,
          false,
        )
        this.report(
          agent,
          runId,
          "failed",
          error instanceof Error ? error.message : String(error),
        )
        throw error
      } finally {
        /* Ending an old run must not affect a newer admission. */
        agent.endRun(runId)
        if (this.pendingRun === completion) this.pendingRun = undefined
      }
    })()
    this.starts.set(runId, completion)
    const forget = () => {
      this.starts.delete(runId)
    }
    completion.then(forget, forget)
    return completion
  }

  /**
   * Report the outcome to the plugin; a failing send must not mask the run's own
   * result, so it is logged rather than thrown.
   */
  private report(
    agent: ParticipantAgent,
    runId: string,
    status: "succeeded" | "failed",
    detail?: string,
  ): void {
    try {
      agent.reportResult(runId, status, detail)
    } catch (error) {
      LOG.error(
        `ConnectedRun ${runId}: could not report "${status}" to the plugin - ${error}`,
        false,
      )
    }
  }

  /** Run a Scenario, racing ConnectedRuns against their private abort signal. */
  private runScenario(
    scenarioId: string,
    args?: ScenarioConfig,
    context?: ParticipantContext,
    aborted?: Promise<never>,
  ): AwaitScenarioComplete {
    const scenarioTypename = this.registry.getScenario(scenarioId)?.typename
    if (!scenarioTypename) {
      throw Error(`No test scenario with ID: ${scenarioId}`)
    }
    const lifecycle = LeafLifecycle.getInstance()
    const runControl = lifecycle.beginScenario()
    const {scope} = runControl

    LOG.debug(`Creating SceneObject for scenario "${scenarioId}"`, false)
    let scenarioOwner!: SceneObject
    let scenario: Scenario
    try {
      /* A scenario that builds a hand in a field initializer cannot await this. */
      warmHandRigs()
      scenarioOwner = global.scene.createSceneObject(scenarioId)
      scenarioOwner.setParent(this.owner)
      scenario = scenarioOwner.createComponent(scenarioTypename) as Scenario
    } catch (error) {
      const errors: unknown[] = [error]
      for (const cleanup of [
        () =>
          scope.cancel(
            error instanceof Error ? error : new Error(String(error)),
          ),
        () => lifecycle.invokeCleanup(),
        () => restoreHandRigs(),
        () => scenarioOwner?.destroy(),
      ]) {
        try {
          cleanup()
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
      }
      runControl.cleanupFinished()
      throw errors.length === 1 ? error : combineErrors(errors)
    }
    LOG.debug(`Scenario component "${scenarioTypename}" instantiated`, false)

    const awaitScenarioComplete: AwaitScenarioComplete = (async () => {
      let isComplete = false
      let failure: Error | undefined
      let reportDiagnosticsOnExit: (() => void) | null = null
      try {
        scenario.createEvent("OnDestroyEvent").bind(() => {
          if (!isComplete) {
            throw new Error("Scenario was destroyed before completion.")
          }
        })

        const config = this.mergeReservedParams(scenarioId, args)
        this.applyLogLevel(config)
        if (this.resolveDisableUserInput(config)) {
          UserInputSuppressor.getInstance().suppress()
        }

        const timeoutSecs = config.getNumberOrThrow("__leaf__timeout_secs")
        const scenarioConfig = config.getScenarioConfig()

        Logger.reset()
        const diagnostics = DiagnosticRecorder.getInstance()
        diagnostics.reset()
        diagnostics.setPolicy(this.resolveDiagnosticPolicy(config))
        /* Preserve recorded interaction failures on timeout and abort. */
        let diagnosticsLogged = false
        const logDiagnostics = () => {
          if (diagnosticsLogged) {
            return
          }
          diagnosticsLogged = true
          const report = diagnostics.toReport()
          if (report.length > 0) {
            LOG.info(report, false)
            const durationMs = config.getNumber(
              "__leaf__diagnostic_report_duration_ms",
            )
            DiagnosticReportOverlay.show(
              report,
              durationMs === undefined || durationMs < 0
                ? undefined
                : durationMs,
            )
          }
        }
        reportDiagnosticsOnExit = logDiagnostics
        LOG.info(
          `RUNS: ${scenarioId} with args: ${scenarioConfig.toString()}`,
          true,
        )
        LOG.info(
          `Running with runner config: ${JSON.stringify(config.runnerConfig)}`,
          false,
        )

        new InteractionTracer()

        const handRigsReady = settleHandRigs()
        if (aborted) await Promise.race([handRigsReady, aborted])
        else await handRigsReady

        runControl.bodyStarted()
        let run = Promise.resolve()
          .then(() => scenario.run(scenarioConfig, context))
          .finally(runControl.bodySettled)
        if (timeoutSecs > 0) {
          LOG.debug(
            `Scenario timeout set to ${timeoutSecs}s for "${scenarioId}"`,
            false,
          )
          run = withTimeout(
            run,
            timeoutSecs * 1000,
            `Scenario "${scenarioId}" timed out after ${timeoutSecs}s`,
          )
        }
        if (aborted) {
          await Promise.race([run, aborted])
        } else {
          await run
        }

        logDiagnostics()
        if (diagnostics.hasErrors()) {
          throw new Error("Failed interactions detected")
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      } finally {
        isComplete = true
        const cleanupErrors: unknown[] = []
        const attemptCleanup = (cleanup: () => void) => {
          try {
            cleanup()
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        attemptCleanup(() => UserInputSuppressor.getInstance().restore())
        attemptCleanup(() =>
          scope.cancel(failure ?? new Error(`Scenario "${scenarioId}" ended`)),
        )
        attemptCleanup(() => reportDiagnosticsOnExit?.())
        attemptCleanup(() => this.scenarioCompleteEvent.invoke())
        attemptCleanup(() => LeafLifecycle.getInstance().invokeCleanup())
        attemptCleanup(() => restoreHandRigs())
        attemptCleanup(() => scenarioOwner.destroy())
        runControl.cleanupFinished()
        if (cleanupErrors.length) {
          failure = combineErrors(
            failure ? [failure, ...cleanupErrors] : cleanupErrors,
            [
              failure?.message,
              `Cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
            ]
              .filter(Boolean)
              .join("; "),
          )
        }
      }
      if (failure) {
        LOG.error(`FAILED: ${scenarioId} - ${failure}`, false)
        LOG.error(`[${scenarioId}] FAILED - ${failure}`, true)
        Logger.fadeOutOverlay()
        throw combineErrors(
          [failure],
          `FAILED: ${scenarioId} - ${failure.message}`,
        )
      }
      /* Keep the console outcome format consumed by snapos-test's CI regex. */
      LOG.info(`PASSED: ${scenarioId}`, false)
      LOG.info(`[${scenarioId}] PASSED`, true)
      Logger.fadeOutOverlay()
    })()

    return awaitScenarioComplete
  }

  private mergeReservedParams(
    scenarioId: string,
    args?: ScenarioConfig,
  ): ResolvedScenarioConfig {
    const merged = new Map<string, string>(Object.entries(RESERVED_PARAMS))
    // Apply registered parameter defaults before caller-provided overrides.
    const registered = this.registry.getScenario(scenarioId)?.parameters
    if (registered) {
      for (const [key, parameter] of Object.entries(registered)) {
        merged.set(key, parameterDefault(parameter))
      }
    }
    if (args) {
      for (const key of args.keys()) {
        merged.set(key, args.get(key)!)
      }
    }

    const config = new ResolvedScenarioConfig(merged)
    LOG.debug(`Reserved params: ${RESERVED_PARAM_KEYS.join(", ")}`, false)

    return config
  }

  private applyLogLevel(config: ResolvedScenarioConfig): void {
    const logLevel = config.runnerConfig.__leaf__log_level.toUpperCase()

    const level = LogLevel[logLevel as keyof typeof LogLevel]
    if (level !== undefined) {
      Logger.logLevel = level
      LOG.debug(`Log level set to ${logLevel}`, false)
    } else {
      const defaultLevel = RESERVED_PARAMS.__leaf__log_level
      LOG.warn(
        `Unknown log level "${logLevel}". Valid values: DEBUG, INFO, WARN, ERROR. Defaulting to "${defaultLevel}".`,
        false,
      )
      Logger.logLevel = LogLevel[defaultLevel as keyof typeof LogLevel]!
    }
  }

  private resolveDiagnosticPolicy(
    config: ResolvedScenarioConfig,
  ): DiagnosticPolicy {
    const raw = config.runnerConfig.__leaf__diagnostic_policy
    if (raw === "fallback" || raw === "fail-fast") return raw
    const defaultPolicy = RESERVED_PARAMS.__leaf__diagnostic_policy
    LOG.warn(
      `Unknown diagnostic policy "${raw}". Valid values: fallback, fail-fast. Defaulting to "${defaultPolicy}".`,
      false,
    )
    return defaultPolicy
  }

  private resolveDisableUserInput(config: ResolvedScenarioConfig): boolean {
    const raw = config.runnerConfig.__leaf__disable_user_input
    if (raw === "true" || raw === "false") return raw === "true"
    const defaultValue = RESERVED_PARAMS.__leaf__disable_user_input
    LOG.warn(
      `Unknown disable user input value "${raw}". Valid values: true, false. Defaulting to "${defaultValue}".`,
      false,
    )
    return defaultValue === "true"
  }
}
