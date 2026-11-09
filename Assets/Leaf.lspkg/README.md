# LEAF

LEAF is an **automated testing framework for AR developers** that helps validate Lens behavior. It lets you define repeatable test scenarios, simulate user interactions (hand input, gestures, ray-based targeting), and catch regressions caused by Lens changes, UI updates, or platform evolution — for faster debugging, less manual on-device testing, and more reliable releases.

## Features

- **Scenarios**: Author repeatable, async test flows by extending the `Scenario` base class and registering them with the `@scenariosIndex` decorator
- **Simulated Interactors**: Drive hands, gestures, and SIK-compatible interactors programmatically — no physical device interaction required
- **IK Solver**: Body, arm, wrist, and finger inverse-kinematics that pose a Bitmoji avatar to realistically reproduce direct and indirect (ray) interactions
- **Messaging Bridge**: A pub/sub messaging system that lets an external runner discover, configure, and start scenarios inside a running Lens
- **Configurable Runs**: Per-scenario parameters plus reserved framework controls for log level, timeout, diagnostic policy, diagnostic report duration, and user-input suppression (the `__leaf__*` keys)
- **SIK Compatible**: Works alongside Spectacles Interaction Kit interactables and interactors

## Quick Start

Define a scenario by extending `Scenario` and implementing `run`:

```typescript
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {ScenarioConfig} from "Leaf.lspkg/Scenarios/scenario/ScenarioConfig"
import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"

@component
export class TapButtonScenario extends Scenario {
  // Prefix every async call with `await` so failures throw instead of
  // being silently swallowed.
  async run(config?: ScenarioConfig): Promise<void> {
    const buttonName = config?.getOrThrow("buttonName")
    print(`Running scenario against button: ${buttonName}`)

    // Simulate interaction, advance frames, and assert on the result here.
  }
}

// Register scenarios so the ScenarioManager can discover and run them by ID.
@component
export class ScenarioIndex extends BaseScriptComponent {
  @scenariosIndex
  static readonly scenarios: ScenarioMetadata[] = [
    {
      id: "tap_button",
      typename: TapButtonScenario.getTypeName(),
      parameters: {buttonName: "PrimaryButton"},
    },
  ]
}
```

Scenarios are discovered, configured, and started through the `ScenarioManager` — `listScenarioIds()`, `listScenarioParameters(id)`, and `startScenario(id, args)` — which an external runner reaches over the messaging bridge.

## Layout overview

| Area | Purpose |
|------|---------|
| **`Scenarios/`** | Scenario base class, config, metadata, the `@scenariosIndex` decorator, and the `ScenarioManager` that registers and runs scenarios |
| **`Interactors/`** | Simulated interactors — hand input, gestures, IK-based direct/indirect interaction, and SIK/replay interactors |
| **`IKSolver/`** | Inverse-kinematics controllers (body, arm, wrist, head, finger) and math utilities used to pose the avatar |
| **`Utils/`** | Shared utilities: lifecycle, update dispatch, events, logging, serialization, camera providers, and the messaging system |

## Script highlights

### Scenarios/scenario/Scenario.ts
Abstract base class for every test. Implement the async `run(config?)` method; the framework instantiates the component only when the scenario is started, keeping the scene hierarchy clean. As a best practice, `await` every async call inside `run` so errors propagate.

### Scenarios/decorator/ScenarioIndexDecorator.ts
The `@scenariosIndex` field decorator auto-registers an array of `ScenarioMetadata` (each an `id` + `typename` + optional `parameters`) with the `DefaultScenarioManager` at initialization, so scenarios become runnable by ID without manual wiring.

### Scenarios/scenario/ScenarioConfig.ts
Typed wrapper over a `Map<string, string>` for scenario parameters, with `get`/`getOrThrow`/`getNumber` accessors. `ResolvedScenarioConfig` guarantees the reserved `__leaf__` framework params are present and can strip them to hand a scenario only its own parameters.

### Interactors/interactor/manager/
`LeafInteractorManager` registers simulated interactors and starts them by ID, mirroring the scenario manager pattern so tests can spin up the input sources they need.

### Interactors/interactor/voiceInput/LeafVoiceInteractor.ts
`LeafVoiceInteractor` simulates the results of an `AsrModule` transcription
session. `say()` delivers interim or final transcription events and
`triggerError()` delivers ASR errors to the lens's registered handlers.

It is an ASR-result test seam, not a microphone or audio emulator. It never
sends audio samples to `AsrModule` or invokes the real ASR service. Use it to
test deterministic lens behavior after ASR, such as session state, caption
handling, and error recovery. Cover microphone capture, recognition quality,
and service latency with hardware or platform-level tests.

## Dependencies

This package declares **InteractionKit** and **Bitmoji 3D** in **`package_dependencies.json`**. Match editor and package versions to avoid compile or runtime mismatches.

## Built with 👻 by the Spectacles team
