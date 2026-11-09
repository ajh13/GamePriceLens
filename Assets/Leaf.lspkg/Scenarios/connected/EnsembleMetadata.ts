/**
 * A resolved Ensemble as registered with the scenario manager: a topology-
 * agnostic mapping from each Role to the (internal) Scenario id that Role runs.
 * Produced by `ensemble()` from the Role -> Scenario-class map the lens author
 * writes, and discovered by the plugin the same way Scenarios are.
 * The same Ensemble runs on every topology; only the Binding (Role ->
 * Participant) varies per ConnectedRun.
 */
export interface EnsembleMetadata {
  /** Unique id, sharing one namespace with Scenario ids. */
  id: string
  /** Role name (e.g. "host") -> the internal Scenario id that Role runs. */
  roles: Record<string, string>
}

/** One Ensemble as discovered by the plugin: its id and Role names. */
export interface EnsembleInfo {
  id: string
  roles: string[]
}

/** Project registration metadata to its discovery shape; Role order is declaration order. */
export function toEnsembleInfo(metadata: EnsembleMetadata): EnsembleInfo {
  return {id: metadata.id, roles: Object.keys(metadata.roles)}
}
