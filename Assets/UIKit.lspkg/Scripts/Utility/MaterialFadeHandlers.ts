/**
 * Registry of custom material fade handlers for VisibilityGroup.
 *
 * Built-in fading probes three conventional channels (an `opacity` float
 * param, a `baseColor` vec4's alpha, the engine `opacityFactor`) — but a
 * material only fades through a channel its shader actually consumes.
 * Materials that consume none of the three register a handler here: the
 * registry is consulted BEFORE built-in probing, so a handler can also
 * override a built-in channel that technically exists but does the wrong
 * thing for that material.
 *
 * Register at module scope so handlers exist before any group discovers:
 *
 * ```ts
 * registerMaterialFadeHandler(createUniformFadeHandler("tintAlpha"))
 * ```
 *
 * Groups created before a registration will not see it until their
 * `refresh()` (or `addSubtree`) runs. First-registered handler wins when
 * several match. `registerMaterialFadeHandler` returns an unregister
 * function (primarily for tests and hot-swapped content).
 *
 * Handlers run at discovery only (cold path); the returned state's
 * `apply`/`restore` run on the group's value-gated write path.
 */

/**
 * Per-visual fade state returned by a handler's probe. `apply(factor)`
 * writes the visual's fade however this material fades, where `factor` is
 * the group's composed opacity (1 = authored appearance); implementations
 * multiply their captured initial values by it. `restore()` writes the
 * captured initial values back exactly.
 */
export interface MaterialFadeState {
  apply(factor: number): void
  restore(): void
}

/**
 * A fade strategy for one material family. `probe` returns a state object
 * (closing over whatever it captured from the visual) when this handler owns
 * the visual's material, or null to let other handlers and the built-in
 * channels try. A matching handler covers the WHOLE visual — built-in
 * per-material-slot probing is skipped, so multi-material strategies are the
 * handler's responsibility (capture every slot's surface in the state).
 * Text discovery can also call `probe` with a Text that exposes `mainPass` at
 * runtime; handlers must check before using MaterialMeshVisual slot APIs.
 */
export interface MaterialFadeHandler {
  probe(visual: MaterialMeshVisual): MaterialFadeState | null
}

const handlers: MaterialFadeHandler[] = []

/**
 * Adds a handler to the registry. Returns an unregister function.
 */
export function registerMaterialFadeHandler(handler: MaterialFadeHandler): () => void {
  handlers.push(handler)
  return () => {
    const index = handlers.indexOf(handler)
    if (index !== -1) {
      handlers.splice(index, 1)
    }
  }
}

/**
 * Consulted by VisibilityGroup at discovery, before built-in channel
 * probing. First-registered matching handler wins.
 */
export function probeCustomFade(visual: MaterialMeshVisual): MaterialFadeState | null {
  for (let i = 0; i < handlers.length; i++) {
    const state = handlers[i].probe(visual)
    if (state) {
      return state
    }
  }
  return null
}

/**
 * Factory for the common case: the material fades through a single float
 * uniform with a non-standard name. The handler matches any visual whose
 * main pass exposes `param` as a number, captures its authored value, and
 * multiplies it by the fade factor.
 */
export function createUniformFadeHandler(param: string): MaterialFadeHandler {
  return {
    probe(visual: MaterialMeshVisual): MaterialFadeState | null {
      const mainPass = visual.mainPass
      if (!mainPass) {
        return null
      }
      const passParams = mainPass as unknown as Record<string, unknown>
      const initial = passParams[param]
      if (typeof initial !== "number") {
        return null
      }
      return {
        apply(factor: number): void {
          passParams[param] = initial * factor
        },
        restore(): void {
          passParams[param] = initial
        }
      }
    }
  }
}
