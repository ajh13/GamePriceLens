const LEAF_PREFIX = "__leaf__"

/**
 * Reserved parameter keys consumed by the LEAF framework before the scenario runs.
 * Prefixed with `__leaf__` to distinguish them from scenario-specific parameters.
 * Included in every scenario's parameter listing so callers can discover them.
 *
 * - `__leaf__log_level` — Sets the global log level (DEBUG, INFO, WARN, ERROR).
 * - `__leaf__timeout_secs` — Maximum time (in seconds) a scenario may run before being aborted. -1 means no timeout.
 * - `__leaf__diagnostic_policy` — How firing diagnostics interact with the in-flight IK action: `fallback` (record + skip IK + run the IK-simulated fallback so downstream events still fire) or `fail-fast` (record + throw at the firing call site).
 * - `__leaf__diagnostic_report_duration_ms` — How long the in-world diagnostic report overlay stays visible after the run. Negative leaves it shown indefinitely (default), `0` hides immediately so the next scenario starts clean, positive values hide after that many ms.
 * - `__leaf__disable_user_input` — When `true` (default), real user input is disabled while the scenario runs. Set to `false` to keep interacting with the lens by hand during development.
 */
export const RESERVED_PARAMS = {
  __leaf__log_level: "INFO",
  __leaf__timeout_secs: "600",
  __leaf__diagnostic_policy: "fallback",
  __leaf__diagnostic_report_duration_ms: "-1",
  __leaf__disable_user_input: "true",
} as const

export type ReservedParamKey = keyof typeof RESERVED_PARAMS
export const RESERVED_PARAM_KEYS = Object.keys(
  RESERVED_PARAMS,
) as ReservedParamKey[]

/**
 * Class representing a scenario configuration. Wrapper around a Map<string, string>.
 *
 * @param config - Map<string, string> to initialize the ScenarioConfig.
 */
export class ScenarioConfig {
  constructor(private config: Map<string, string>) {}

  /** Build a ScenarioConfig from a plain record of string parameters. */
  static fromRecord(config: Record<string, string>): ScenarioConfig {
    return new ScenarioConfig(new Map(Object.entries(config)))
  }

  /**
   * @param key - The key to retrieve the value for.
   * @returns The value associated with the key, or undefined if the key is not found.
   */
  get(key: string): string | undefined {
    return this.config.get(key)
  }

  /**
   * @param key - The key to retrieve the value for.
   * @returns The value associated with the key.
   * @throws Error if the key is not found in the scenario config.
   */
  getOrThrow(key: string): string {
    const value = this.get(key)
    if (value === undefined) {
      throw new Error(
        `Key ${key} not found in scenario config. Available keys: ${this.keys()}`,
      )
    }
    return value
  }

  /**
   * @param key - The key to retrieve the numeric value for.
   * @returns The parsed number, or undefined if the key is missing or not a valid number.
   */
  getNumber(key: string): number | undefined {
    const num = Number(this.get(key))
    return Number.isNaN(num) ? undefined : num
  }

  /**
   * @param key - The key to retrieve the numeric value for.
   * @returns The parsed number.
   * @throws Error if the key is missing or not a valid number.
   */
  getNumberOrThrow(key: string): number {
    const num = Number(this.getOrThrow(key))
    if (Number.isNaN(num)) {
      throw new Error(
        `Key ${key} has non-numeric value "${this.get(key)}" in scenario config.`,
      )
    }
    return num
  }

  /**
   * @returns All available keys in the scenario config.
   */
  keys(): string[] {
    return Array.from(this.config.keys())
  }

  /**
   * String representation of the scenario config.
   * Has the format: [(key1: value1), (key2: value2), ...]
   * @returns String representation of the scenario config.
   */
  toString(): string {
    const argsString = Array.from(this.config.entries())
      .map(([key, value]) => `(${key}: ${value})`)
      .join(", ")
    return `[${argsString}]`
  }
}

export type RunnerConfig = {readonly [K in ReservedParamKey]: string}

/**
 * A ScenarioConfig where all reserved parameters are guaranteed to be present.
 * Produced by merging caller-provided args with {@link RESERVED_PARAMS} defaults.
 *
 * Use {@link scenarioConfig} to get a config with only the scenario-specific
 * parameters (all `__leaf__` prefixed keys stripped).
 */
export class ResolvedScenarioConfig extends ScenarioConfig {
  readonly runnerConfig: RunnerConfig
  private _scenarioConfig: ScenarioConfig | undefined

  constructor(config: Map<string, string>) {
    super(config)
    const runnerConfig = {} as Record<ReservedParamKey, string>
    for (const key of RESERVED_PARAM_KEYS) {
      runnerConfig[key] = this.getOrThrow(key)
    }
    this.runnerConfig = runnerConfig
  }

  /**
   * @returns A ScenarioConfig containing only scenario-specific parameters,
   * with all `__leaf__` prefixed reserved params stripped.
   */
  getScenarioConfig(): ScenarioConfig {
    if (!this._scenarioConfig) {
      const filtered = new Map<string, string>()
      for (const key of this.keys()) {
        if (!key.startsWith(LEAF_PREFIX)) {
          filtered.set(key, this.getOrThrow(key))
        }
      }
      this._scenarioConfig = new ScenarioConfig(filtered)
    }
    return this._scenarioConfig
  }
}
