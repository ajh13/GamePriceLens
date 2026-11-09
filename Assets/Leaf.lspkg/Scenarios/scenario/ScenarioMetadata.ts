import {Scenario} from "./Scenario"

/** Free-form text. */
export type StringParameter = {
  default: string
  /** Omitted means `"string"`. */
  type?: "string"
}

/** One of a fixed set of values, which the LEAF plugin renders as a dropdown. */
export type EnumParameter = {
  default: string
  type: "enum"
  options: string[]
}

/** A declared parameter. */
export type Parameter = StringParameter | EnumParameter

/** Declared type of a parameter, i.e. the parameter without its default. */
export type ParameterType = {type: "string"} | {type: "enum"; options: string[]}

/**
 * Interface for scenario registry entries
 */
export interface ScenarioMetadata {
  id: string
  typename: TypeName<Scenario>
  /**
   * Declared parameters. A bare string is the default value of a
   * {@link StringParameter}.
   */
  parameters?: Record<string, string | Parameter>
}

/**
 * @param parameter - A declared parameter, in either form.
 * @returns Its default value.
 */
export function parameterDefault(parameter: string | Parameter): string {
  return typeof parameter === "string" ? parameter : parameter.default
}

/**
 * @param parameter - A declared parameter, in either form.
 * @returns Its declared type, defaulting to `"string"`.
 */
export function parameterTypeOf(parameter: string | Parameter): ParameterType {
  if (typeof parameter !== "string" && parameter.type === "enum") {
    return {type: "enum", options: [...parameter.options]}
  }
  return {type: "string"}
}
