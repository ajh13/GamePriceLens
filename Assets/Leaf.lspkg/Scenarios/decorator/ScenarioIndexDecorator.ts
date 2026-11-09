import {DefaultScenarioManager} from "../scenario/manager/DefaultLeafScenarioManager"
import {ScenarioManager} from "../scenario/manager/ScenarioManager"
import {Scenario} from "../scenario/Scenario"
import {ScenarioMetadata} from "../scenario/ScenarioMetadata"

/**
 * A Scenario class with the static type name used for registration.
 *
 * The instance type carries the Scenario check: from Lens Studio 5.25 a
 * component's inherited static `getTypeName()` is typed
 * `TypeName<BaseScriptComponent>`, so it can't be matched against
 * `TypeName<Scenario>` structurally.
 */
type ScenarioClass = (abstract new (...args: never[]) => Scenario) & {
  getTypeName(): string
}

/** Declarative Role-to-Scenario mapping consumed by @scenariosIndex. */
export interface EnsembleDeclaration {
  readonly kind: "ensemble"
  readonly id: string
  readonly roles: Readonly<Record<string, ScenarioClass>>
}

/** Plain Scenario metadata or an Ensemble declaration in a @scenariosIndex. */
export type ScenarioIndexEntry = ScenarioMetadata | EnsembleDeclaration

/** Register the plain Scenarios and Ensembles declared on a static index field. */
export function scenariosIndex(
  _target: undefined,
  context: ClassFieldDecoratorContext<unknown, ScenarioIndexEntry[]>,
): void {
  if (!context.static)
    throw new Error("@scenariosIndex must be applied to a static field.")
  context.addInitializer(function (this) {
    const manager = DefaultScenarioManager.getInstance()
    context.access.get(this).forEach((entry) => registerEntry(manager, entry))
  })
}

/** Opt the @scenariosIndex component into ConnectedRuns; otherwise Role starts are refused. */
export function enableConnectedRuns(): ClassDecorator {
  return function (_constructor: Function) {
    DefaultScenarioManager.getInstance().enableConnectedRuns()
  }
}

/**
 * Declare an Ensemble in a @scenariosIndex; its Role Scenarios are hidden from the ordinary list.
 * @param id Ensemble id, sharing one namespace with Scenario ids.
 * @param roles At least two Role names, none integer-like, mapped to Scenario classes.
 *   Declaration order binds p1, p2, etc.; the last Role runs on the device in device mode.
 * @example ensemble("shared_value", {host: HostScenario, joiner: JoinerScenario})
 */
export function ensemble(
  id: string,
  roles: Record<string, ScenarioClass>,
): EnsembleDeclaration {
  return {kind: "ensemble", id, roles: {...roles}}
}

function registerEntry(
  manager: ScenarioManager,
  entry: ScenarioIndexEntry,
): void {
  if (!("kind" in entry)) {
    manager.registerScenario(entry)
    return
  }
  const {id, roles} = entry
  const names = Object.keys(roles)
  if (names.length < 2) {
    throw new Error(
      `Ensemble "${id}" declares ${names.length} Role(s); an Ensemble needs at least two.`,
    )
  }
  const scenarios = names.map((role) => {
    /* JavaScript reorders integer-like keys, changing which Role binds to the device. */
    if (/^\d+$/.test(role)) {
      throw new Error(
        `Ensemble "${id}": Role name "${role}" is integer-like; use a descriptive name to preserve declaration order.`,
      )
    }
    if (typeof roles[role]?.getTypeName !== "function") {
      throw new Error(
        `Ensemble "${id}": Role "${role}" is not a Scenario class (no static getTypeName()). Check the import.`,
      )
    }
    return {
      id: `${id}:${role}`,
      typename: roles[role].getTypeName() as unknown as ScenarioMetadata["typename"],
    }
  })
  const roleScenarioIds: Record<string, string> = {}
  scenarios.forEach((scenario, i) => {
    manager.registerScenario(scenario)
    roleScenarioIds[names[i]] = scenario.id
  })
  manager.registerEnsemble({id, roles: roleScenarioIds})
}
