import {UIKitBrands} from "../Components/Layout2D/UIKitBrands"
import {VisibilityControllable, VisibilityState} from "../Interfaces/VisibilityControllable"
import {registerVisibilityGroupAlpha} from "../Motion/VisibilityGroupAlpha"
import {MaterialFadeState, probeCustomFade} from "./MaterialFadeHandlers"

// The write mechanism wires itself: if VisibilityGroup is in the bundle,
// Motion's alpha channel composes with it — no intent-layer import required.
// (Idempotent; safe under the module cycle because VisibilityGroupAlpha only
// touches this module's exports at bind time, never at load.)
registerVisibilityGroupAlpha()

export type VisibilityGroupOptions = {
  /** Manage `Component.RenderMeshVisual` descendants. Default true. */
  includeMeshes?: boolean
  /** Manage `Component.Image` descendants. Default true. */
  includeImages?: boolean
  /** Manage `Component.Text` and `Component.Text3D` descendants. Default true. */
  includeText?: boolean
  /**
   * When true, renderables that were enabled at discovery are disabled while
   * group opacity is exactly 0 and restored when it rises above 0. Default
   * false — opacity zero never implicitly disables anything.
   */
  disableRenderablesAtZero?: boolean
  /**
   * Exclusion predicate, evaluated once per walked node at discovery/refresh
   * (never per write, never per frame). Return `true` to exclude the node and
   * its entire subtree structurally (nothing captured, nothing written), or a
   * {@link VisibilityExclusion} mask to exempt specific axes. Verdicts are
   * subtree-inherited and combine downward by OR — a deeper verdict can only
   * add exclusions; once both axes are excluded the branch is pruned.
   * See {@link excludeObjects} and {@link excludeUIKitElements} for the
   * common cases.
   */
  excludeIf?: (sceneObject: SceneObject) => boolean | VisibilityExclusion | undefined
}

/**
 * Per-axis exclusion mask returned by `excludeIf`. `fade: true` exempts the
 * subtree from opacity writes (group fades and opacity scales) while
 * enabled-state management still applies; `enabledControl: true` exempts it
 * from enabled-state management (`disableRenderablesAtZero` and
 * `renderableEnabled` overrides) while fades still apply. Both = structural
 * exclusion, same as returning `true`.
 */
export type VisibilityExclusion = {
  fade?: boolean
  enabledControl?: boolean
}

/**
 * Helper predicate: structurally exclude these SceneObjects (and their
 * subtrees), matched by engine identity. The predicate captures the list;
 * pass it to `excludeIf`.
 */
export function excludeObjects(objects: SceneObject[]): (sceneObject: SceneObject) => boolean {
  return (sceneObject: SceneObject) => {
    for (let i = 0; i < objects.length; i++) {
      if (!isNull(objects[i]) && sceneObject.isSame(objects[i])) {
        return true
      }
    }
    return false
  }
}

/**
 * Helper predicate: structurally exclude subtrees rooted at a UIKit Element
 * (detected via the `__uikitBrand` field — no component-graph import).
 * Elements manage their own opacity through their visual state machinery;
 * with this, the group manages only non-self-managing decor and cannot fight
 * an Element's own writes.
 */
export function excludeUIKitElements(sceneObject: SceneObject): boolean {
  return hasElementBrand(sceneObject)
}

// Which uniform actually fades this mesh's material. Probed once at
// discovery: registered custom handlers first (see MaterialFadeHandlers),
// then an explicit `opacity` float param, then a `baseColor` vec4's alpha,
// then the engine-level `opacityFactor`. Measured in-engine: opacityFactor
// only fades materials whose shader graph consumes it — Image-family
// materials ignore it entirely and must fade through baseColor.
// Close enough to 1 that an isolated fade hands its surface back. Below one
// part in ten thousand of alpha there is nothing to see, and holding the
// override past that point costs correctness for nothing.
const NEUTRAL_FADE_FACTOR = 1 - 1e-4

const enum MeshFadeChannel {
  OpacityUniform = 0,
  BaseColorAlpha = 1,
  OpacityFactor = 2,
  Custom = 3
}

type ManagedRenderable = MaterialMeshVisual | Text

type MeshEntry = {
  // Component.RenderMeshVisual or Component.Text3D — Text3D is a
  // MaterialMeshVisual (no textFill) and fades via its material like a mesh.
  visual: ManagedRenderable
  // The pass captured at discovery — one entry per MATERIAL SLOT — and
  // re-resolved from the visual's same slot before every use (see
  // refreshMeshEntryPass), so a runtime material rebind can't leave writes
  // landing on an orphaned pass. Null only for the Custom channel, whose
  // handler owns its surfaces.
  pass: Pass | null
  // Which material slot this entry drives; re-resolution goes through
  // getMaterial(slot), NOT mainPass (which is always slot 0).
  slot: number
  channel: MeshFadeChannel
  // Initial scalar for OpacityUniform/OpacityFactor channels.
  initialScalar: number
  // Initial color for the BaseColorAlpha channel (null otherwise).
  initialColor: vec4 | null
  // Registered-handler state for the Custom channel (null otherwise).
  customState: MaterialFadeState | null
  initialEnabled: boolean
  // Product of every opacity-scale scope covering this entry (1 = neutral).
  localProduct: number
  // Per-axis exclusion flags inherited from the discovery walk.
  excludeFade: boolean
  excludeEnabledControl: boolean
  // True when this entry's fade is written through the VISUAL's own pass
  // override instead of the shared material asset. See writeMeshEntry.
  isolated: boolean
  // True while an override we wrote is live, so releasing only ever touches
  // visuals this group actually faded.
  overrideWritten: boolean
}

type ColorEntry = {
  // Component.Image (mainPass.baseColor) or Component.Text (textFill.color) —
  // both fade through a vec4 color alpha. The kind is captured at discovery;
  // Text is also a mesh visual, so duck-typing on `mainPass` at write time
  // would hit the wrong property.
  component: Image | Text
  isImage: boolean
  // The exact color surface captured at discovery (Image mainPass or Text
  // textFill) — written and restored directly, never re-resolved at write
  // time. Replacing the material/font requires refresh().
  surface: Pass | TextFill
  initialColor: vec4
  initialEnabled: boolean
  localProduct: number
  // Per-axis exclusion flags inherited from the discovery walk.
  excludeFade: boolean
  excludeEnabledControl: boolean
}

type TextWithMainPass = Text & {readonly mainPass: Pass}

function hasMainPass(text: Text): text is TextWithMainPass {
  const candidate = text as unknown as {mainPass?: Pass | null}
  return candidate.mainPass !== undefined && candidate.mainPass !== null
}

// A subtree-scoped opacity multiplier (see setOpacityScale). Membership is
// resolved once per scope (and on refresh) against the cached entries and
// child-group boundaries.
type OpacityScope = {
  node: SceneObject
  factor: number
  meshIndices: number[]
  colorIndices: number[]
  boundaryIndices: number[]
}

// A descendant group's root discovered inside this group's subtree. The
// parent stops walking there and forwards opacity into the child group
// instead of writing its passes.
type GroupBoundary = {
  root: SceneObject
  group: VisibilityGroup
  // Product of scopes covering the boundary root (1 = neutral).
  localProduct: number
  // Fade-masked boundaries are owned but never forwarded into.
  excludeFade: boolean
}

const enum RenderableMode {
  FollowInitial = 0,
  ForcedOff = 1
}

/**
 * Subtree fade/visibility helper. Replaces per-consumer opacity walkers
 * (like the ones in ToolbarCustomItem and Dropdown) with one cached,
 * value-gated apply path.
 *
 * Scope: the group implements the {@link VisibilityControllable} contract
 * for the VISUAL axes only — opacity and renderable enabled state. Collider
 * and interactable axes in {@link VisibilityState} are component-level
 * concerns (e.g. `Element.inactive`) and are deliberately ignored here;
 * components adopting `VisibilityControllable` own those.
 *
 * Discovery walks the subtree once at construction (and on explicit
 * `refresh()` after structure changes) and caches renderable references with
 * their initial alpha/enabled values — never per opacity write, never per
 * frame. Group opacity multiplies the initial alpha, so `setOpacity(1)`
 * restores the authored appearance exactly. Renderables whose fade surface is
 * not yet realized (a mesh/image with no material, a text with no textFill)
 * are skipped at discovery — call `refresh()` after configuring them.
 *
 * Three tiers of control per subtree: NOT MANAGED (`excludeIf` — e.g. an
 * attached side panel via {@link excludeObjects}, or interactive Elements
 * that own their opacity via {@link excludeUIKitElements}; masks allow
 * per-axis exemption), managed fully (default), and — see `setOpacityScale`
 * — managed but scaled.
 *
 * Nested groups COMPOSE. A group whose root sits inside another group's
 * subtree becomes a BOUNDARY: the outer group stops walking there and
 * forwards its opacity into the inner group's `externalOpacity` instead of
 * writing its passes — opacity only; each group's own options
 * (disable-at-zero, exclusions, scales) govern its own subtree. Registration
 * is automatic on construction and order-independent: whichever group is
 * created later reconciles with the covering group, and a released inner
 * group's subtree is re-absorbed by its parent. Content that CONSTRUCTS its
 * own group when injected therefore needs no coordination calls at
 * construction time. Moving a LIVE group to a new parent (pooling, tab
 * switches) is an explicit lifecycle step instead: call `removeSubtree` on
 * the old parent at detach (the child resets to neutral immediately) and
 * `addSubtree` on the new parent at attach (adoption forwards the new
 * parent's current opacity immediately and transfers ownership) — nothing is
 * polled per write or per frame, so a skipped call means the old parent
 * keeps forwarding until told otherwise. Use {@link VisibilityGroup.groupFor}
 * at the mutation site when the covering group isn't at hand. (Two groups
 * over the SAME root still fight — don't do that.)
 *
 * Mesh visuals fade through channels probed once at discovery, one entry
 * PER MATERIAL SLOT: a registered custom handler first (see
 * `MaterialFadeHandlers` — the hook for materials with non-standard fade
 * uniforms or entirely custom fade approaches; a handler covers the whole
 * visual and owns its surfaces), then per slot an explicit `opacity` float
 * param, then a `baseColor` vec4's alpha, then the engine `opacityFactor`
 * (which only fades materials whose shader graph consumes it). Materials
 * that match none of these — or opaque blend modes (e.g. RoundedRectangle's
 * default `RoundedRectBlendMode.Disabled`), where the renderer ignores
 * alpha — do not fade visually; enable transparency on content meant to
 * fade, or register a handler. Writes re-read the pass from the entry's material
 * slot, but nothing else is re-resolved: a new slot, channel or font needs
 * `refresh()` before it is managed.
 *
 * Color ownership: fade writes replay the RGB captured at discovery, so a
 * runtime tint change is overwritten on the next write unless followed by
 * `refresh()`, which rebaselines it — restores preserve the surface's
 * CURRENT RGB and rewrite only the authored alpha, and at an effective
 * factor of 1 the restore is skipped entirely, so a full color set while
 * undimmed becomes the new baseline wholesale. Leaving the group
 * (`release`/`removeSubtree`) follows the same rule: authored alpha comes
 * back, current tint survives.
 *
 * Enabled ownership follows the same rule. The group writes `enabled` only
 * while it is forcing renderables off (`disableRenderablesAtZero` at zero, or
 * `setVisibility({renderableEnabled: false})`); while it is not forcing, the
 * current flag is the consumer's, so an enable/disable made since discovery
 * survives `refresh()` (which rebaselines it), `removeSubtree` and `release`.
 * A toggle made WHILE forced off is overwritten by the captured initial when
 * the force lifts, until the next `refresh()`.
 *
 * Fade isolation: content that is NOT part of a UIKit Element fades through
 * that visual's own `mainPassOverrides`, so a material shared with something
 * outside the group is never written — this is a public fade boundary, and an
 * unrelated mesh dimming with a Frame would be a bug, not a caveat. The
 * override is removed the moment the fade is neutral again, which is what
 * keeps it from masking whatever the content's own code writes next.
 *
 * Two cases stay on the direct-material path, both deliberately. UIKit's own
 * visuals: Shape clones its material per instance, so there is nothing to leak
 * to, and the component writes that clone directly — an override would mask
 * it. And material slots beyond the first: the engine exposes a per-visual
 * override for the main pass only. That second case still fades a shared
 * material, so it warns once, naming the visual, pointing at either giving it
 * its own material or registering a fade handler for it.
 *
 * Perf: opacity writes are value-gated (same value twice → zero native
 * writes) and allocation-free — color-channel fades stage through a shared
 * scratch vec4, which the engine copies on pass assignment. Negative opacity
 * inputs clamp to 0; values above 1 pass through (they amplify authored
 * alphas, and the engine clamps final output).
 */
export class VisibilityGroup implements VisibilityControllable {
  /**
   * The group managing `node`: the group whose root IS `node`, else the
   * nearest ancestor group, else null. The public entry point for external
   * animation systems that want to route a target through its covering group
   * instead of hand-plumbing group references.
   */
  public static groupFor(node: SceneObject): VisibilityGroup | null {
    if (isNull(node)) {
      return null
    }
    const exact = findRegisteredGroup(node, null)
    return exact ?? findCoveringGroup(node, null)
  }

  private readonly _root: SceneObject
  private readonly _includeMeshes: boolean
  private readonly _includeImages: boolean
  private readonly _includeText: boolean
  private readonly _disableAtZero: boolean
  private readonly _excludeIf: ((sceneObject: SceneObject) => boolean | VisibilityExclusion | undefined) | null
  private readonly _meshes: MeshEntry[] = []
  private readonly _colors: ColorEntry[] = []
  private _opacity: number = 1
  private _externalOpacity: number = 1
  private _renderableMode: RenderableMode = RenderableMode.FollowInitial
  private _appliedRenderableMode: RenderableMode = RenderableMode.FollowInitial
  private _scopes: OpacityScope[] | null = null
  private readonly _boundaries: GroupBoundary[] = []
  // The parent group currently forwarding across this group's root, if any.
  private _boundaryOwner: VisibilityGroup | null = null
  private _warnedContestedExternal: boolean = false
  private _released: boolean = false
  // Fade blend window. Opened directly by a consumer, and/or propagated in
  // from parent groups across a boundary — tracked separately so a parent
  // releases only its OWN hold and cannot close a window the child opened for
  // itself.
  private _ownFadeBlendWindow: boolean = false
  private _propagatedWindowOwners: VisibilityGroup[] = []
  /** Passes this group currently holds, so reconcile can release exactly those. */
  private _heldPasses: Pass[] = []

  public constructor(root: SceneObject, options?: VisibilityGroupOptions) {
    this._root = root
    this._includeMeshes = options?.includeMeshes ?? true
    this._includeImages = options?.includeImages ?? true
    this._includeText = options?.includeText ?? true
    this._disableAtZero = options?.disableRenderablesAtZero ?? false
    this._excludeIf = options?.excludeIf ?? null
    // Reconcile BEFORE discovering: register, then let a covering group
    // refresh — it restores its raw writes under our root (so we capture
    // clean AUTHORED values, not its faded ones), adopts a boundary, and
    // forwards its current opacity into our still-empty group. Construction
    // order never matters to consumers. (Our own walk skips self-lookups.)
    groupRegistry.push({root: root, group: this})
    findCoveringGroup(root, this)?.refresh()
    this.discover(root, false, false)
    if (this._externalOpacity !== 1) {
      // A parent forwarded into us during reconciliation; apply it to the
      // entries we just captured. The forward arrived while we were empty
      // and may have already latched the renderable mode — force a reapply
      // so disable-at-zero reaches these entries.
      this.applyOpacity()
      this._appliedRenderableMode = RenderableMode.FollowInitial
      this.applyRenderableEnabled()
    }
  }

  public static fromRoot(root: SceneObject, options?: VisibilityGroupOptions): VisibilityGroup {
    return new VisibilityGroup(root, options)
  }

  /** Number of managed fade surfaces (one per material slot for meshes). */
  public get size(): number {
    return this._meshes.length + this._colors.length
  }

  public get released(): boolean {
    return this._released
  }

  public get opacity(): number {
    return this._opacity
  }

  /**
   * Multiplies every managed renderable's initial alpha by `value`.
   * Value-gated: writing the current opacity again performs no native writes.
   */
  public set opacity(value: number) {
    // A negative opacity multiplier is never meaningful; values above 1
    // amplify authored alphas (the engine clamps final output).
    if (value < 0) {
      value = 0
    }
    if (this._released || value === this._opacity) {
      return
    }
    this._opacity = value
    this.applyOpacity()
    this.applyRenderableEnabled()
  }

  /** Convenience alias for the `opacity` setter. */
  public setOpacity(value: number): void {
    this.opacity = value
  }

  /** The externally driven multiplier (1 = neutral). */
  public get externalOpacity(): number {
    return this._externalOpacity
  }

  /**
   * The composition channel: a multiplier driven from OUTSIDE the group —
   * by a parent group forwarding its fade across this group's boundary, or
   * by any external animator that wants to compose with (rather than fight)
   * this group's own fades. Folded into the same product as everything else:
   * effective = authored × external × group × scales. Value-gated.
   *
   * An external factor of 0 counts toward `disableRenderablesAtZero`
   * (a parent fading to nothing triggers this group's own opt-in disable),
   * while `release()` still restores authored values regardless.
   *
   * This is a single last-writer-wins channel: when a parent group owns this
   * group's boundary, the parent is the writer — do not also drive it
   * manually. (Fade-masked boundaries are never owned, so manual driving
   * there is legitimate and never warns. A stale owner left behind by
   * reparenting — e.g. pooled composites parked outside their old parent —
   * self-heals here and on the old parent's next write.)
   */
  public setExternalOpacity(value: number): void {
    // Self-heal a stale owner (released, or we were reparented out of its
    // subtree — e.g. a pooled composite parked on a holding node).
    if (
      this._boundaryOwner !== null &&
      (this._boundaryOwner.released || isNull(this._root) || !isUnder(this._root, this._boundaryOwner._root))
    ) {
      this._boundaryOwner = null
    }
    if (this._boundaryOwner !== null && !this._warnedContestedExternal) {
      this._warnedContestedExternal = true
      print(
        "[VisibilityGroup] setExternalOpacity called manually while a parent group owns this " +
          "group's boundary — the parent forwards into the same channel and will overwrite this value."
      )
    }
    this.applyForwardedExternalOpacity(value)
  }

  // Parent-side forwarding entry point: same channel, no contested-write
  // warning (the owning parent is the legitimate writer).
  private applyForwardedExternalOpacity(value: number): void {
    if (value < 0) {
      value = 0
    }
    if (this._released || value === this._externalOpacity) {
      return
    }
    this._externalOpacity = value
    this.applyOpacity()
    this.applyRenderableEnabled()
  }

  /**
   * Applies the visual axes of a {@link VisibilityState}: `opacity` always;
   * `renderableEnabled` as an explicit override that wins over
   * `disableRenderablesAtZero` until cleared by a `true` value restoring
   * initial state. `colliderEnabled`/`interactableEnabled` are ignored here
   * by design (component-level axes).
   */
  public setVisibility(state: VisibilityState): void {
    if (this._released) {
      return
    }
    if (state.renderableEnabled !== undefined) {
      // `true` CLEARS the override (back to normal management, including
      // disable-at-zero) rather than forcing renderables on forever.
      this._renderableMode = state.renderableEnabled ? RenderableMode.FollowInitial : RenderableMode.ForcedOff
    }
    // Same clamp rule as the opacity setter (this is the only other write
    // path into _opacity), applied before the value gate.
    const opacity = state.opacity < 0 ? 0 : state.opacity
    if (opacity !== this._opacity) {
      this._opacity = opacity
      this.applyOpacity()
    }
    this.applyRenderableEnabled()
  }

  /**
   * A multiplier composed with group opacity for every managed renderable in
   * the subtree rooted at `node` (effective = authored × group × scales).
   * 1 is neutral. Unlike a clamp, the subtree stays proportionally dimmer at
   * EVERY group level — a panel scaled to 0.5 follows a 1→0→1 group fade as
   * 0.5→0→0.5, landing at half brightness, not full.
   *
   * This is the "managed but scaled" tier: use it for grayed-out or
   * independently-animated children that should still ride group fades.
   * External animators drive the scale instead of writing passes directly,
   * so they compose with the group instead of fighting it. (Interactive
   * Elements should be excluded via `excludeUIKitElements` instead — their state
   * machines write opacity absolutely.)
   *
   * Membership is resolved once per scope with a cold subtree walk and
   * re-resolved on `refresh()`; changing the factor costs O(members)
   * value-gated writes, so per-frame animation of a scale is fine. Nested
   * scopes multiply. Scales do not affect `disableRenderablesAtZero`, which
   * keys off group and external opacity only. Opacity channel only — "disabled" tinting
   * belongs to the visual state/theme system.
   */
  public setOpacityScale(node: SceneObject, multiplier: number): void {
    if (multiplier < 0) {
      multiplier = 0
    }
    if (this._released) {
      return
    }
    let scope = this.findScope(node)
    if (!scope) {
      if (multiplier === 1) {
        return
      }
      scope = {node, factor: multiplier, meshIndices: [], colorIndices: [], boundaryIndices: []}
      ;(this._scopes ??= []).push(scope)
      this.resolveScopeMembership(scope)
    } else {
      if (scope.factor === multiplier) {
        return
      }
      scope.factor = multiplier
    }
    this.applyMemberIndices(scope.meshIndices, scope.colorIndices, scope.boundaryIndices)
  }

  /** The current scale for `node`, or 1 if none is set. */
  public getOpacityScale(node: SceneObject): number {
    return this.findScope(node)?.factor ?? 1
  }

  /** Removes `node`'s scale (equivalent to setting 1) and drops the scope. */
  public clearOpacityScale(node: SceneObject): void {
    if (this._released || !this._scopes) {
      return
    }
    for (let i = 0; i < this._scopes.length; i++) {
      const scope = this._scopes[i]
      if (!isNull(scope.node) && node.isSame(scope.node)) {
        this._scopes.splice(i, 1)
        this.applyMemberIndices(scope.meshIndices, scope.colorIndices, scope.boundaryIndices)
        return
      }
    }
  }

  /**
   * Registers a branch that was just added under this group's root, without
   * a full rescan. The branch is discovered with the same rules as
   * construction (exclusions, custom fade handlers, child-group boundaries),
   * captured at its authored values, deduped against already-managed content
   * (re-adding is harmless), and brought to the group's CURRENT state so it
   * matches the rest of the subtree immediately.
   *
   * Ownership story for structural changes: content that constructs its OWN
   * group at attach time needs no calls (construction reconciles
   * automatically); group-less content AND pre-existing live groups should
   * be add/removeSubtree'd at the mutation site (adding a branch that
   * contains a live group adopts it — ownership of its external channel
   * transfers here and the group's current opacity is forwarded
   * immediately); when you don't know what changed, call `refresh()`.
   */
  public addSubtree(root: SceneObject): void {
    if (this._released) {
      return
    }
    // Construction walks from the group root, so exclusion verdicts on
    // ancestors inherit down; this walk starts mid-tree and must inherit
    // them the same way (up to and including the group root).
    let inheritedFade = false
    let inheritedEnabledControl = false
    if (this._excludeIf) {
      let node: SceneObject | null = root.getParent()
      while (node && !isNull(node)) {
        const verdict = this._excludeIf(node)
        if (verdict === true) {
          return // the branch sits under a structurally excluded ancestor
        }
        if (verdict) {
          inheritedFade = inheritedFade || verdict.fade === true
          inheritedEnabledControl = inheritedEnabledControl || verdict.enabledControl === true
        }
        if (inheritedFade && inheritedEnabledControl) {
          return
        }
        if (!isNull(this._root) && node.isSame(this._root)) {
          break
        }
        node = node.getParent()
      }
    }
    const meshStart = this._meshes.length
    const colorStart = this._colors.length
    const boundaryStart = this._boundaries.length
    this.discover(root, inheritedFade, inheritedEnabledControl)

    // Silent dedupe: drop just-discovered entries that were already managed.
    for (let i = this._meshes.length - 1; i >= meshStart; i--) {
      for (let j = 0; j < meshStart; j++) {
        if (!isNull(this._meshes[j].visual) && this._meshes[i].visual.isSame(this._meshes[j].visual)) {
          this._meshes.splice(i, 1)
          break
        }
      }
    }
    for (let i = this._colors.length - 1; i >= colorStart; i--) {
      for (let j = 0; j < colorStart; j++) {
        if (!isNull(this._colors[j].component) && this._colors[i].component.isSame(this._colors[j].component)) {
          this._colors.splice(i, 1)
          break
        }
      }
    }
    for (let i = this._boundaries.length - 1; i >= boundaryStart; i--) {
      for (let j = 0; j < boundaryStart; j++) {
        if (this._boundaries[i].group === this._boundaries[j].group) {
          this._boundaries.splice(i, 1)
          break
        }
      }
    }

    this.resolveAllScopesAndProducts()

    // Bring only the new content to the group's current state (splices above
    // may have shifted indices, so recompute the ranges).
    for (let i = meshStart; i < this._meshes.length; i++) {
      this.writeMeshEntry(this._meshes[i])
    }
    for (let i = colorStart; i < this._colors.length; i++) {
      this.writeColorEntry(this._colors[i])
    }
    for (let i = boundaryStart; i < this._boundaries.length; i++) {
      this.forwardBoundary(this._boundaries[i])
    }
    this._appliedRenderableMode = RenderableMode.FollowInitial
    this.applyRenderableEnabled()
    // New opaque passes and new nested groups must join an open window, or
    // the content added mid-fade renders at full colour.
    this.reconcileFadeBlendWindow()
  }

  /**
   * Restores everything under `root` to its authored state (the same
   * leaving-means-authored rule as `release()`) and stops managing it:
   * entries, opacity scopes, and child-group boundaries under that branch
   * are dropped, and boundary children return to neutral external opacity.
   */
  public removeSubtree(root: SceneObject): void {
    if (this._released) {
      return
    }
    // Destroyed entries are culled here too (matching the boundary/scope
    // loops) — they can never be restored and must not linger in the caches.
    // Enabled follows the restoreEntries rule: undone only while forced off.
    const restoreEnabled = this.isForcingRenderablesOff()
    for (let i = this._meshes.length - 1; i >= 0; i--) {
      const entry = this._meshes[i]
      const destroyed = isNull(entry.visual)
      if (destroyed || isUnder(entry.visual.getSceneObject(), root)) {
        if (!destroyed) {
          if (!entry.excludeFade) {
            restoreMeshEntry(entry, this.entryFactor(entry.localProduct))
          }
          if (restoreEnabled && !entry.excludeEnabledControl) {
            entry.visual.enabled = entry.initialEnabled
          }
        }
        this._meshes.splice(i, 1)
      }
    }
    for (let i = this._colors.length - 1; i >= 0; i--) {
      const entry = this._colors[i]
      const destroyed = isNull(entry.component)
      if (destroyed || isUnder(entry.component.getSceneObject(), root)) {
        if (!destroyed) {
          if (!entry.excludeFade) {
            restoreColorEntry(entry, this.entryFactor(entry.localProduct))
          }
          if (restoreEnabled && !entry.excludeEnabledControl) {
            entry.component.enabled = entry.initialEnabled
          }
        }
        this._colors.splice(i, 1)
      }
    }
    for (let i = this._boundaries.length - 1; i >= 0; i--) {
      const boundary = this._boundaries[i]
      if (isNull(boundary.root) || isUnder(boundary.root, root)) {
        // Reset the child's channel only if we own it and were actually
        // forwarding (fade-masked boundaries are driven by someone else).
        const owned = boundary.group._boundaryOwner === this
        if (owned) {
          boundary.group._boundaryOwner = null
        }
        if (owned && !boundary.excludeFade && !boundary.group.released) {
          boundary.group.applyForwardedExternalOpacity(1)
        }
        this._boundaries.splice(i, 1)
      }
    }
    if (this._scopes) {
      for (let i = this._scopes.length - 1; i >= 0; i--) {
        if (isNull(this._scopes[i].node) || isUnder(this._scopes[i].node, root)) {
          this._scopes.splice(i, 1)
        }
      }
    }
    // Entry splices invalidate scope member indices — re-resolve.
    this.resolveAllScopesAndProducts()
    // Removed passes must stop being held, and a boundary that left must stop
    // being forwarded into.
    this.reconcileFadeBlendWindow()
  }

  private resolveAllScopesAndProducts(): void {
    if (!this._scopes) {
      return
    }
    for (let i = this._scopes.length - 1; i >= 0; i--) {
      const scope = this._scopes[i]
      if (isNull(scope.node)) {
        this._scopes.splice(i, 1)
      } else {
        this.resolveScopeMembership(scope)
      }
    }
    for (let i = 0; i < this._meshes.length; i++) {
      this._meshes[i].localProduct = this.computeLocalProduct(i, true)
    }
    for (let i = 0; i < this._colors.length; i++) {
      this._colors[i].localProduct = this.computeLocalProduct(i, false)
    }
    for (let i = 0; i < this._boundaries.length; i++) {
      this._boundaries[i].localProduct = this.computeBoundaryProduct(i)
    }
  }

  /**
   * Full rescan after structure changes — use when you don't know what
   * changed; prefer `addSubtree`/`removeSubtree` at the mutation site. New
   * renderables are captured with their current values as initial state; the
   * group's current opacity, renderable mode, and opacity scales are then
   * applied so late-added children match the rest of the group. Scopes whose
   * node was destroyed are dropped; surviving scopes re-resolve membership.
   */
  /**
   * Opens the fade blend window: every opaque pass this group manages is held
   * in a blending mode so the alpha this group writes is actually visible.
   * Element bodies default to the cheap opaque pass, which ignores alpha
   * outright — without this they hold full colour through a fade and pop.
   *
   * The group owns this because it already holds the exact per-slot passes
   * (all material slots, not just the first), knows its nested-group
   * boundaries, and re-captures on `refresh()` — a caller walking the subtree
   * itself gets all three wrong.
   *
   * Holds are per-owner and reference-counted across groups, so a pass shared
   * with another group is restored only when the LAST holder closes, and a
   * parent forwarding into a nested group cannot close a window that group
   * opened for itself. Idempotent; reconciled on refresh/addSubtree/
   * removeSubtree; released by `release()`.
   */
  public openFadeBlendWindow(): void {
    this._ownFadeBlendWindow = true
    this.reconcileFadeBlendWindow()
  }

  /**
   * Closes this group's own window. Call once the fade has settled at full
   * opacity — closing at alpha 0 would render the bodies through it. Passes
   * still held by another group, or by a parent forwarding in, stay blending.
   */
  public closeFadeBlendWindow(): void {
    this._ownFadeBlendWindow = false
    this.reconcileFadeBlendWindow()
  }

  /** True while anything is holding this group's passes in a blend window. */
  public get fadeBlendWindowOpen(): boolean {
    return this._ownFadeBlendWindow || this._propagatedWindowOwners.length > 0
  }

  /** A parent group forwarding its window across a boundary. */
  private addPropagatedWindow(owner: VisibilityGroup): void {
    if (this._released || this._propagatedWindowOwners.indexOf(owner) >= 0) {
      return
    }
    this._propagatedWindowOwners.push(owner)
    this.reconcileFadeBlendWindow()
  }

  /** That parent withdrawing — its hold only, never the group's own. */
  private removePropagatedWindow(owner: VisibilityGroup): void {
    const index = this._propagatedWindowOwners.indexOf(owner)
    if (index < 0) {
      return
    }
    this._propagatedWindowOwners.splice(index, 1)
    this.reconcileFadeBlendWindow()
  }

  /**
   * Brings held passes in line with the current entries and window state:
   * acquires what should be held, releases exactly what should not (a pass
   * whose content was removed, or everything once the window closes), and
   * propagates into or withdraws from nested groups.
   *
   * Called on open/close and after every structural change, so reparented or
   * late-built content cannot be left blending — or left opaque mid-fade.
   */
  private reconcileFadeBlendWindow(): void {
    const open = this.fadeBlendWindowOpen && !this._released
    const wanted: Pass[] = []
    if (open) {
      const meshes = this._meshes
      for (let i = 0; i < meshes.length; i++) {
        const entry = meshes[i]
        // Custom-handled visuals fade through a handler uniform, not blending
        // (pass is null); excluded entries are not ours to touch.
        if (entry.pass === null || entry.excludeFade || isNull(entry.visual)) {
          continue
        }
        refreshMeshEntryPass(entry)
        wanted.push(entry.pass)
      }
    }
    // Release holds whose pass is no longer wanted. isSame, not identity: a
    // refresh re-reads the same native pass through a new wrapper.
    for (let i = this._heldPasses.length - 1; i >= 0; i--) {
      const held = this._heldPasses[i]
      let stillWanted = false
      for (let w = 0; w < wanted.length; w++) {
        if (!isNull(held) && !isNull(wanted[w]) && held.isSame(wanted[w])) {
          stillWanted = true
          break
        }
      }
      if (!stillWanted) {
        releaseBlendHold(held, this)
        this._heldPasses.splice(i, 1)
      }
    }
    for (let w = 0; w < wanted.length; w++) {
      acquireBlendHold(wanted[w], this)
      let tracked = false
      for (let i = 0; i < this._heldPasses.length; i++) {
        if (this._heldPasses[i].isSame(wanted[w])) {
          tracked = true
          break
        }
      }
      if (!tracked) {
        this._heldPasses.push(wanted[w])
      }
    }
    // Nested groups own their own subtree — discover() stops at their root, so
    // their passes are absent from _meshes. Forward the window to them, and
    // withdraw from boundaries that have left.
    for (let i = 0; i < this._boundaries.length; i++) {
      const boundary = this._boundaries[i]
      if (boundary.group.released) {
        continue
      }
      if (open && !boundary.excludeFade) {
        boundary.group.addPropagatedWindow(this)
      } else {
        boundary.group.removePropagatedWindow(this)
      }
    }
  }

  /** Withdraws propagation from a boundary this group no longer covers. */
  private withdrawPropagation(child: VisibilityGroup): void {
    if (!child.released) {
      child.removePropagatedWindow(this)
    }
  }

  public refresh(): void {
    if (this._released) {
      return
    }
    // Restore existing entries to their captured initials BEFORE
    // re-discovering. Discovery captures CURRENT pass values as authored
    // state; without this, a refresh while the group is mid-fade would
    // record the group's own writes as the new initials, compounding the
    // group opacity into the baseline (release() would then "restore"
    // half-faded values instead of authored ones).
    this.restoreEntries()
    this._meshes.length = 0
    this._colors.length = 0
    // Snapshot boundaries so children that leave this subtree get their
    // external channel released back to neutral after re-discovery.
    const previousBoundaries = this._boundaries.slice()
    for (let i = 0; i < previousBoundaries.length; i++) {
      if (previousBoundaries[i].group._boundaryOwner === this) {
        previousBoundaries[i].group._boundaryOwner = null
      }
    }
    this._boundaries.length = 0
    this.discover(this._root, false, false)
    for (let i = 0; i < previousBoundaries.length; i++) {
      const previous = previousBoundaries[i]
      if (previous.group._boundaryOwner === null && !previous.excludeFade && !previous.group.released) {
        // No longer under this group (and not adopted during re-discovery):
        // release the channel we were driving.
        previous.group.applyForwardedExternalOpacity(1)
      }
    }
    this.resolveAllScopesAndProducts()
    // Force reapply to cover newly discovered entries.
    this._appliedRenderableMode = RenderableMode.FollowInitial
    this.applyOpacity()
    this.applyRenderableEnabled()
    // Late-built content joins an open window, and content that left stops
    // being held, on the frame it happens.
    this.reconcileFadeBlendWindow()
  }

  /**
   * Restores every managed renderable to its authored alpha and initial
   * enabled state (current tint survives — see the color-ownership rules)
   * and drops the caches. Idempotent. Suitable for
   * `ManagedResourceSet.addCleanup(() => group.release())`.
   */
  public release(): void {
    if (this._released) {
      return
    }
    this._released = true
    this._scopes = null
    // Give back our own holds and stop forwarding into children. Other
    // owners' holds on the same passes survive.
    this._ownFadeBlendWindow = false
    this._propagatedWindowOwners.length = 0
    for (let i = 0; i < this._heldPasses.length; i++) {
      releaseBlendHold(this._heldPasses[i], this)
    }
    this._heldPasses.length = 0
    for (let i = 0; i < this._boundaries.length; i++) {
      this.withdrawPropagation(this._boundaries[i].group)
    }

    // Release the boundaries we drive: children return to neutral external
    // opacity and stop being owned. Only reset channels we actually drove.
    const boundaries = this._boundaries
    for (let i = 0; i < boundaries.length; i++) {
      const child = boundaries[i].group
      const owned = child._boundaryOwner === this
      if (owned) {
        child._boundaryOwner = null
      }
      if (owned && !boundaries[i].excludeFade && !child.released) {
        child.applyForwardedExternalOpacity(1)
      }
    }
    boundaries.length = 0

    // Leave the registry, then let a covering group (if any) re-absorb our
    // subtree as raw entries — the reverse of construction reconciliation.
    for (let i = groupRegistry.length - 1; i >= 0; i--) {
      if (groupRegistry[i].group === this) {
        groupRegistry.splice(i, 1)
      }
    }
    this._boundaryOwner = null

    this.restoreEntries()
    this._meshes.length = 0
    this._colors.length = 0

    // Reverse reconciliation: a covering group re-absorbs our (now restored)
    // subtree as raw entries. The root may already be destroyed when release
    // runs from teardown cleanup — nothing to reconcile then.
    if (!isNull(this._root)) {
      findCoveringGroup(this._root, this)?.refresh()
    }
  }

  /**
   * Restores every managed renderable: the group's fade contribution is
   * undone (authored alpha/scalars come back; current RGB survives) and, while
   * the group is forcing renderables off, enabled state returns to its captured
   * initial. When it is not forcing, its last enabled write (if any) already
   * equals the baseline, so the current flag is left alone: a consumer's toggle
   * made since discovery survives and, on refresh, becomes the new initial. The
   * same rule the opacity restore applies at factor 1.
   */
  private restoreEntries(): void {
    // Restore only the axes this group managed for each entry.
    const restoreEnabled = this.isForcingRenderablesOff()
    const meshes = this._meshes
    for (let i = 0; i < meshes.length; i++) {
      const entry = meshes[i]
      if (!isNull(entry.visual)) {
        if (!entry.excludeFade) {
          restoreMeshEntry(entry, this.entryFactor(entry.localProduct))
        }
        if (restoreEnabled && !entry.excludeEnabledControl) {
          entry.visual.enabled = entry.initialEnabled
        }
      }
    }

    const colors = this._colors
    for (let i = 0; i < colors.length; i++) {
      const entry = colors[i]
      if (!isNull(entry.component)) {
        if (!entry.excludeFade) {
          restoreColorEntry(entry, this.entryFactor(entry.localProduct))
        }
        if (restoreEnabled && !entry.excludeEnabledControl) {
          entry.component.enabled = entry.initialEnabled
        }
      }
    }
  }

  // True while the group's last enabled write was `false` for every managed
  // entry, i.e. the current flags are the group's, not the consumer's.
  private isForcingRenderablesOff(): boolean {
    return this._appliedRenderableMode === RenderableMode.ForcedOff
  }

  private discover(sceneObject: SceneObject, excludeFade: boolean, excludeEnabledControl: boolean): void {
    // Evaluate the exclusion predicate once per node; verdicts inherit down
    // the subtree and combine by OR. Both axes excluded = structural prune.
    if (this._excludeIf) {
      const verdict = this._excludeIf(sceneObject)
      if (verdict === true) {
        return
      }
      if (verdict) {
        excludeFade = excludeFade || verdict.fade === true
        excludeEnabledControl = excludeEnabledControl || verdict.enabledControl === true
      }
      if (excludeFade && excludeEnabledControl) {
        return
      }
    }
    // Another group's root is a BOUNDARY: that group owns the subtree. Stop
    // walking, record the child, and forward opacity instead of writing.
    // Never at our own root: two groups sharing a root is unsupported and
    // must not become a mutual-forwarding cycle.
    const childGroup =
      !isNull(this._root) && sceneObject.isSame(this._root) ? null : findRegisteredGroup(sceneObject, this)
    if (childGroup) {
      this._boundaries.push({
        root: sceneObject,
        group: childGroup,
        localProduct: 1,
        excludeFade: excludeFade
      })
      // Ownership means ACTIVELY FORWARDING: fade-masked boundaries are
      // recorded (so we never descend) but their channel stays free for
      // whoever legitimately drives it.
      if (!excludeFade) {
        childGroup._boundaryOwner = this
      }
      return
    }
    if (this._includeMeshes) {
      const meshVisuals = sceneObject.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]
      for (let i = 0; i < meshVisuals.length; i++) {
        probeMeshEntries(meshVisuals[i], excludeFade, excludeEnabledControl, this._meshes)
      }
    }
    if (this._includeImages) {
      const images = sceneObject.getComponents("Component.Image") as Image[]
      for (let i = 0; i < images.length; i++) {
        const image = images[i]
        const pass = image.mainPass
        // No material yet — nothing to capture or fade. refresh() picks the
        // component up once it is configured.
        if (!pass) {
          continue
        }
        this._colors.push({
          component: image,
          isImage: true,
          surface: pass,
          initialColor: pass.baseColor,
          initialEnabled: image.enabled,
          localProduct: 1,
          excludeFade: excludeFade,
          excludeEnabledControl: excludeEnabledControl
        })
      }
    }
    if (this._includeText) {
      this.discoverText(sceneObject, excludeFade, excludeEnabledControl)
      // Text3D is a MaterialMeshVisual — it has no textFill and fades via its
      // material like a mesh. Runtime-created Text3D has a null mainPass
      // until a font/material is assigned; probeMeshEntries skips it until a
      // refresh() after that.
      const texts3d = sceneObject.getComponents("Component.Text3D") as Text3D[]
      for (let i = 0; i < texts3d.length; i++) {
        probeMeshEntries(texts3d[i], excludeFade, excludeEnabledControl, this._meshes)
      }
    }

    const childCount = sceneObject.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      this.discover(sceneObject.getChild(i), excludeFade, excludeEnabledControl)
    }
  }

  private discoverText(sceneObject: SceneObject, excludeFade: boolean, excludeEnabledControl: boolean): void {
    const texts = sceneObject.getComponents("Component.Text") as Text[]
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]
      // A Text can render through a custom material that ignores textFill.
      // A matching handler owns the whole Text, including its background, so
      // skip every standard fill when one matches.
      const textVisual = hasMainPass(text) ? (text as unknown as MaterialMeshVisual) : null
      const customState = textVisual ? probeCustomFade(textVisual) : null
      if (customState) {
        this._meshes.push({
          visual: text,
          pass: null,
          slot: 0,
          channel: MeshFadeChannel.Custom,
          initialScalar: 1,
          initialColor: null,
          customState,
          initialEnabled: text.enabled,
          localProduct: 1,
          excludeFade,
          excludeEnabledControl,
          isolated: false,
          overrideWritten: false
        })
        continue
      }
      const fill = text.textFill
      // textFill is unrealized until the text has a material/font — skip;
      // refresh() picks it up once realized.
      if (!fill) {
        continue
      }
      this._colors.push({
        component: text,
        isImage: false,
        surface: fill,
        initialColor: fill.color,
        initialEnabled: text.enabled,
        localProduct: 1,
        excludeFade: excludeFade,
        excludeEnabledControl: excludeEnabledControl
      })
      // Text backgrounds have an independent fill surface. This captures only
      // backgrounds enabled at discovery; call refresh() after enabling one.
      const background = text.backgroundSettings
      const backgroundFill = background && background.enabled ? background.fill : null
      if (backgroundFill) {
        this._colors.push({
          component: text,
          isImage: false,
          surface: backgroundFill,
          initialColor: backgroundFill.color,
          initialEnabled: text.enabled,
          localProduct: 1,
          excludeFade,
          excludeEnabledControl
        })
      }
    }
  }

  private applyOpacity(): void {
    const meshes = this._meshes
    for (let i = 0; i < meshes.length; i++) {
      this.writeMeshEntry(meshes[i])
    }
    const colors = this._colors
    for (let i = 0; i < colors.length; i++) {
      this.writeColorEntry(colors[i])
    }
    const boundaries = this._boundaries
    let pruned = false
    for (let i = boundaries.length - 1; i >= 0; i--) {
      if (!this.forwardBoundary(boundaries[i])) {
        boundaries.splice(i, 1)
        pruned = true
      }
    }
    if (pruned) {
      // Splices invalidate scope boundary indices.
      this.resolveAllScopesAndProducts()
    }
  }

  // Opacity-only forwarding (contract decision): the child's own options
  // govern its subtree; the parent's contribution at the boundary arrives as
  // the child's externalOpacity, so chains compose to any depth.
  //
  // Staleness is detected without scene-graph walks — write-time checks are
  // identity comparisons only. A destroyed boundary root relinquishes and
  // resets the channel; an unmasked boundary whose child is owned by someone
  // else (adopted by a new group via addSubtree, self-healed after a manual
  // drive, or released) is pruned WITHOUT touching the channel the current
  // owner drives. Reparenting a live child out of this subtree is an
  // explicit lifecycle step — call removeSubtree at the detach site.
  // Returns false for boundaries the caller should prune.
  private forwardBoundary(boundary: GroupBoundary): boolean {
    if (isNull(boundary.root)) {
      const child = boundary.group
      if (child._boundaryOwner === this) {
        child._boundaryOwner = null
        if (!boundary.excludeFade && !child.released) {
          child.applyForwardedExternalOpacity(1)
        }
      }
      return false
    }
    if (!boundary.excludeFade) {
      if (boundary.group.released) {
        return false
      }
      if (boundary.group._boundaryOwner !== this) {
        return false
      }
      boundary.group.applyForwardedExternalOpacity(this._externalOpacity * this._opacity * boundary.localProduct)
    }
    return true
  }

  private writeMeshEntry(entry: MeshEntry): void {
    if (entry.excludeFade || isNull(entry.visual)) {
      return
    }
    const factor = this._externalOpacity * this._opacity * entry.localProduct
    // The Custom channel's handler owns its surfaces end to end — no pass
    // guard here; the handler's own state decides what is still writable.
    if (entry.channel === MeshFadeChannel.Custom) {
      ;(entry.customState as MaterialFadeState).apply(factor)
      return
    }
    refreshMeshEntryPass(entry)
    const pass = entry.pass as Pass
    if (isNull(pass)) {
      return // the material asset was destroyed; refresh() re-captures
    }
    if (entry.isolated) {
      // Neutral means hand the surface back, rather than pin an override at
      // whatever value it holds now. Tolerance, not equality: a consumer
      // driving setOpacity from its own curve can land on 0.99999 and never
      // exactly 1, and an override left at 0.99999 masks every later write
      // for a difference nobody can see.
      if (factor >= NEUTRAL_FADE_FACTOR) {
        clearIsolatedFade(entry, pass)
      } else {
        writeIsolatedFade(entry, pass, factor)
      }
      return
    }
    switch (entry.channel) {
      case MeshFadeChannel.OpacityUniform:
        ;(pass as unknown as Record<string, number>)["opacity"] = entry.initialScalar * factor
        break
      case MeshFadeChannel.BaseColorAlpha:
        ;(pass as unknown as Record<string, vec4>)["baseColor"] = stageColor(entry.initialColor as vec4, factor)
        break
      case MeshFadeChannel.OpacityFactor:
        pass.opacityFactor = entry.initialScalar * factor
        break
    }
  }

  private writeColorEntry(entry: ColorEntry): void {
    if (!entry.excludeFade && !isNull(entry.component)) {
      writeColor(entry, stageColor(entry.initialColor, this._externalOpacity * this._opacity * entry.localProduct))
    }
  }

  // The effective fade factor an entry is currently written at — the value
  // restores must undo.
  private entryFactor(localProduct: number): number {
    return this._externalOpacity * this._opacity * localProduct
  }

  private findScope(node: SceneObject): OpacityScope | null {
    const scopes = this._scopes
    if (!scopes) {
      return null
    }
    for (let i = 0; i < scopes.length; i++) {
      if (!isNull(scopes[i].node) && node.isSame(scopes[i].node)) {
        return scopes[i]
      }
    }
    return null
  }

  private resolveScopeMembership(scope: OpacityScope): void {
    scope.meshIndices.length = 0
    scope.colorIndices.length = 0
    scope.boundaryIndices.length = 0
    const candidates: ManagedRenderable[] = []
    collectRenderables(scope.node, candidates)
    for (let i = 0; i < this._meshes.length; i++) {
      if (containsComponent(candidates, this._meshes[i].visual)) {
        scope.meshIndices.push(i)
      }
    }
    for (let i = 0; i < this._colors.length; i++) {
      if (containsComponent(candidates, this._colors[i].component)) {
        scope.colorIndices.push(i)
      }
    }
    for (let i = 0; i < this._boundaries.length; i++) {
      if (isUnder(this._boundaries[i].root, scope.node)) {
        scope.boundaryIndices.push(i)
      }
    }
  }

  private computeBoundaryProduct(index: number): number {
    const scopes = this._scopes
    let product = 1
    if (!scopes) {
      return product
    }
    for (let i = 0; i < scopes.length; i++) {
      if (scopes[i].boundaryIndices.indexOf(index) !== -1) {
        product *= scopes[i].factor
      }
    }
    return product
  }

  private computeLocalProduct(index: number, isMesh: boolean): number {
    const scopes = this._scopes
    let product = 1
    if (!scopes) {
      return product
    }
    for (let i = 0; i < scopes.length; i++) {
      const indices = isMesh ? scopes[i].meshIndices : scopes[i].colorIndices
      if (indices.indexOf(index) !== -1) {
        product *= scopes[i].factor
      }
    }
    return product
  }

  private applyMemberIndices(meshIndices: number[], colorIndices: number[], boundaryIndices: number[]): void {
    for (let i = 0; i < meshIndices.length; i++) {
      const entry = this._meshes[meshIndices[i]]
      entry.localProduct = this.computeLocalProduct(meshIndices[i], true)
      this.writeMeshEntry(entry)
    }
    for (let i = 0; i < colorIndices.length; i++) {
      const entry = this._colors[colorIndices[i]]
      entry.localProduct = this.computeLocalProduct(colorIndices[i], false)
      this.writeColorEntry(entry)
    }
    for (let i = 0; i < boundaryIndices.length; i++) {
      const boundary = this._boundaries[boundaryIndices[i]]
      boundary.localProduct = this.computeBoundaryProduct(boundaryIndices[i])
      this.forwardBoundary(boundary)
    }
  }

  private applyRenderableEnabled(): void {
    let mode = this._renderableMode
    if (mode === RenderableMode.FollowInitial && this._disableAtZero && this._externalOpacity * this._opacity === 0) {
      mode = RenderableMode.ForcedOff
    }
    if (mode === this._appliedRenderableMode) {
      return
    }
    this._appliedRenderableMode = mode

    const enabledForEntry = (initialEnabled: boolean): boolean =>
      mode === RenderableMode.ForcedOff ? false : initialEnabled

    const meshes = this._meshes
    for (let i = 0; i < meshes.length; i++) {
      const entry = meshes[i]
      if (!entry.excludeEnabledControl && !isNull(entry.visual)) {
        entry.visual.enabled = enabledForEntry(entry.initialEnabled)
      }
    }

    const colors = this._colors
    for (let i = 0; i < colors.length; i++) {
      const entry = colors[i]
      if (!entry.excludeEnabledControl && !isNull(entry.component)) {
        entry.component.enabled = enabledForEntry(entry.initialEnabled)
      }
    }
  }
}

/**
 * Builds mesh entries with their fade channels probed once. Registered
 * custom handlers win over built-in channels and cover the WHOLE visual
 * (one entry — the handler owns its surfaces, including any multi-material
 * strategy). Otherwise every material slot gets its own entry, each probed
 * independently: explicit `opacity` float param → `baseColor` vec4 alpha →
 * engine `opacityFactor`. Material-less visuals (null mainPass — nothing
 * renders, nothing to fade) contribute nothing; refresh() picks them up once
 * a material exists. Cold path: string-keyed pass reads happen only here.
 */
function probeMeshEntries(
  visual: MaterialMeshVisual,
  excludeFade: boolean,
  excludeEnabledControl: boolean,
  out: MeshEntry[]
): void {
  if (!visual.mainPass) {
    return
  }
  const customState = probeCustomFade(visual)
  if (customState) {
    out.push({
      visual: visual,
      pass: null,
      slot: 0,
      channel: MeshFadeChannel.Custom,
      initialScalar: 1,
      initialColor: null,
      customState: customState,
      initialEnabled: visual.enabled,
      localProduct: 1,
      excludeFade: excludeFade,
      excludeEnabledControl: excludeEnabledControl,
      isolated: false,
      overrideWritten: false
    })
    return
  }
  // One parent walk per visual, not per material slot.
  const uikitOwned = insideUIKitElement(visual)
  const overridable = supportsPassOverrides(visual)
  const materialCount = visual.getMaterialsCount()
  for (let i = 0; i < materialCount; i++) {
    const material = visual.getMaterial(i)
    const pass = !material || isNull(material) ? null : material.mainPass
    if (!pass) {
      continue
    }
    // Slot 0 is the main pass, the only one the engine gives us a per-visual
    // override for.
    const isolated = i === 0 && !uikitOwned && overridable
    // Only warn where a leak is actually possible. A UIKit visual writes a
    // material it cloned for itself, so there is nobody on the other end of
    // it — warning about those buries the one case that matters (author
    // content on a slot we cannot isolate) under a screenful of noise.
    if (!isolated && !uikitOwned && !excludeFade) {
      warnUnisolatedFade(visual, i)
    }
    out.push(probePassEntry(visual, pass, i, excludeFade, excludeEnabledControl, isolated))
  }
}

/**
 * Per-visual pass overrides are how a fade stays inside this group: the engine
 * applies them on top of the material for THIS visual only, so a material
 * shared with content outside the group is not touched.
 *
 * Cloning the material would isolate it too, but it would also strand every
 * write the owning component makes to the material it thinks it owns — UIKit
 * visuals clone per instance and then keep writing colours to that clone. An
 * override layers over whatever the material currently holds, so both keep
 * working.
 */
/**
 * UIKit's own visuals are left on the direct-material path on purpose. Shape
 * clones its material per instance, so there is nobody to leak to, and the
 * component keeps writing that clone directly — layering an override over it
 * would mask those writes the moment the group stopped writing. Author content
 * is the case that both can leak and does not have a clone to rely on.
 */
function insideUIKitElement(visual: MaterialMeshVisual): boolean {
  let node = visual.getSceneObject()
  while (node !== null && node !== undefined && !isNull(node)) {
    if (hasElementBrand(node)) {
      return true
    }
    node = node.getParent()
  }
  return false
}

function supportsPassOverrides(visual: MaterialMeshVisual): boolean {
  const overrides = (visual as unknown as {mainPassOverrides?: unknown}).mainPassOverrides
  return overrides !== undefined && overrides !== null && !isNull(overrides as ScriptObject)
}

const unisolatedWarned: string[] = []
function warnUnisolatedFade(visual: MaterialMeshVisual, slot: number): void {
  const key = `${visual.getSceneObject()?.name ?? "?"}#${slot}`
  if (unisolatedWarned.indexOf(key) >= 0) {
    return
  }
  unisolatedWarned.push(key)
  print(
    `VisibilityGroup: fading "${key}" through its MATERIAL, not a per-visual override` +
      ` — anything else using that material fades with it. Give this visual its own material,` +
      ` or register a material fade handler for it.`
  )
}

function probePassEntry(
  visual: MaterialMeshVisual,
  pass: Pass,
  slot: number,
  excludeFade: boolean,
  excludeEnabledControl: boolean,
  isolated: boolean
): MeshEntry {
  const passParams = pass as unknown as Record<string, unknown>
  const opacityParam = passParams["opacity"]
  if (typeof opacityParam === "number") {
    return {
      visual: visual,
      pass: pass,
      slot: slot,
      channel: MeshFadeChannel.OpacityUniform,
      initialScalar: opacityParam,
      initialColor: null,
      customState: null,
      initialEnabled: visual.enabled,
      localProduct: 1,
      excludeFade: excludeFade,
      excludeEnabledControl: excludeEnabledControl,
      isolated: isolated,
      overrideWritten: false
    }
  }
  const baseColorParam = passParams["baseColor"]
  if (baseColorParam instanceof vec4) {
    return {
      visual: visual,
      pass: pass,
      slot: slot,
      channel: MeshFadeChannel.BaseColorAlpha,
      initialScalar: 1,
      initialColor: baseColorParam,
      customState: null,
      initialEnabled: visual.enabled,
      localProduct: 1,
      excludeFade: excludeFade,
      excludeEnabledControl: excludeEnabledControl,
      isolated: isolated,
      overrideWritten: false
    }
  }
  return {
    visual: visual,
    pass: pass,
    slot: slot,
    channel: MeshFadeChannel.OpacityFactor,
    initialScalar: pass.opacityFactor,
    initialColor: null,
    customState: null,
    initialEnabled: visual.enabled,
    localProduct: 1,
    excludeFade: excludeFade,
    excludeEnabledControl: excludeEnabledControl,
    isolated: isolated,
    overrideWritten: false
  }
}

/**
 * The isolated write path: the fade lands on the VISUAL, never on the shared
 * material, so nothing outside this group changes.
 *
 * Reads the material's CURRENT value each write rather than the value captured
 * at discovery. That is deliberate twice over: a component that re-tints its
 * own material mid-fade keeps showing through, and at factor 1 the override
 * equals the material exactly — which is what lets the settled state be a
 * visual no-op without needing an API to delete an override.
 */
function writeIsolatedFade(entry: MeshEntry, pass: Pass, factor: number): void {
  const overrides = (entry.visual as unknown as {mainPassOverrides: Record<string, unknown>}).mainPassOverrides
  entry.overrideWritten = true
  switch (entry.channel) {
    case MeshFadeChannel.OpacityUniform: {
      const live = (pass as unknown as Record<string, number>)["opacity"]
      overrides["opacity"] = (typeof live === "number" ? live : entry.initialScalar) * factor
      break
    }
    case MeshFadeChannel.BaseColorAlpha: {
      const live = (pass as unknown as Record<string, vec4>)["baseColor"]
      overrides["baseColor"] = stageColor(live instanceof vec4 ? live : (entry.initialColor as vec4), factor)
      break
    }
    case MeshFadeChannel.OpacityFactor:
      overrides["opacityFactor"] = pass.opacityFactor * factor
      break
  }
}

/**
 * Hands the surface back so the material speaks for itself again. An override
 * left sitting at the last value we wrote would mask whatever the content's
 * own code writes next — the reason overrides were avoided here for so long.
 *
 * Releasing REPLACES the whole override bag: `delete` on an individual key does
 * not reach it, so there is no way to drop just the key we wrote. Assigning an
 * object replaces the bag wholesale; assigning null/undefined clears it.
 *
 * The consequence, and it is a real one: this group OWNS `mainPassOverrides`
 * on non-UIKit content it fades. Content that sets its own pass overrides on a
 * visual inside a faded group will lose them when the fade settles. Only
 * visuals this group actually wrote to are touched.
 */
function clearIsolatedFade(entry: MeshEntry, pass: Pass): void {
  if (!entry.overrideWritten) {
    return
  }
  entry.overrideWritten = false
  try {
    ;(entry.visual as unknown as {mainPassOverrides: unknown}).mainPassOverrides = {}
    return
  } catch {
    // Fall through: leaves the surface looking right, and no worse than the
    // direct material write this path replaced.
  }
  writeIsolatedFade(entry, pass, 1)
  entry.overrideWritten = true
}

// Restores undo the group's own fade contribution (`factor`) and no more.
// At factor 1 the group's last write already equals the baseline, so the
// restore is skipped entirely — any value a consumer set since then survives
// and (on refresh) becomes the new captured baseline. For color channels a
// live restore preserves the surface's CURRENT RGB and rewrites only the
// authored alpha: the group owns opacity, not tint (cold path — the current
// read may allocate).
// The variant ladder (and consumer material overrides) rebind materials at
// runtime, orphaning a cached pass. Re-resolve from the live visual's SAME
// SLOT before every use (mainPass would repoint every entry at slot 0) — the
// swap carries opacityFactor across, so a fade in flight continues
// seamlessly, and entry.initialScalar (sampled at registration) is
// deliberately kept so restore() still lands on the true resting value.
// A null pass (custom-handled) and a dead visual keep their meaning.
function refreshMeshEntryPass(entry: MeshEntry): void {
  if (entry.pass === null || isNull(entry.visual)) {
    return
  }
  // Text entries are custom-handled and always return above with a null pass.
  const visual = entry.visual as MaterialMeshVisual
  if (entry.slot >= visual.getMaterialsCount()) {
    return // slot removed since discovery; refresh() re-captures
  }
  const material = visual.getMaterial(entry.slot)
  if (material && !isNull(material)) {
    entry.pass = material.mainPass
  }
}

function restoreMeshEntry(entry: MeshEntry, factor: number): void {
  if (entry.channel === MeshFadeChannel.Custom) {
    ;(entry.customState as MaterialFadeState).restore()
    return
  }
  if (factor === 1) {
    return
  }
  refreshMeshEntryPass(entry)
  const pass = entry.pass as Pass
  if (isNull(pass)) {
    return
  }
  if (entry.isolated) {
    clearIsolatedFade(entry, pass)
    return
  }
  switch (entry.channel) {
    case MeshFadeChannel.OpacityUniform:
      ;(pass as unknown as Record<string, number>)["opacity"] = entry.initialScalar
      break
    case MeshFadeChannel.BaseColorAlpha: {
      const current = (pass as unknown as Record<string, vec4>)["baseColor"]
      const initial = entry.initialColor as vec4
      ;(pass as unknown as Record<string, vec4>)["baseColor"] = new vec4(current.x, current.y, current.z, initial.w)
      break
    }
    case MeshFadeChannel.OpacityFactor:
      pass.opacityFactor = entry.initialScalar
      break
  }
}

// Same restore contract as restoreMeshEntry, for Image/Text color surfaces.
function restoreColorEntry(entry: ColorEntry, factor: number): void {
  if (factor === 1 || isNull(entry.surface)) {
    return
  }
  if (entry.isImage) {
    const pass = entry.surface as Pass
    pass.baseColor = new vec4(pass.baseColor.x, pass.baseColor.y, pass.baseColor.z, entry.initialColor.w)
  } else {
    const fill = entry.surface as TextFill
    fill.color = new vec4(fill.color.x, fill.color.y, fill.color.z, entry.initialColor.w)
  }
}

function collectRenderables(sceneObject: SceneObject, out: ManagedRenderable[]): void {
  const meshVisuals = sceneObject.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]
  for (let i = 0; i < meshVisuals.length; i++) {
    out.push(meshVisuals[i])
  }
  const images = sceneObject.getComponents("Component.Image") as Image[]
  for (let i = 0; i < images.length; i++) {
    out.push(images[i])
  }
  const texts = sceneObject.getComponents("Component.Text") as Text[]
  for (let i = 0; i < texts.length; i++) {
    out.push(texts[i])
  }
  const texts3d = sceneObject.getComponents("Component.Text3D") as Text3D[]
  for (let i = 0; i < texts3d.length; i++) {
    out.push(texts3d[i])
  }
  const childCount = sceneObject.getChildrenCount()
  for (let i = 0; i < childCount; i++) {
    collectRenderables(sceneObject.getChild(i), out)
  }
}

function containsComponent(candidates: ManagedRenderable[], component: ManagedRenderable): boolean {
  if (isNull(component)) {
    return false
  }
  for (let i = 0; i < candidates.length; i++) {
    if (component.isSame(candidates[i])) {
      return true
    }
  }
  return false
}

// Module-level registry of live group roots. Matched with isSame during
// discovery walks (JS identity on engine objects is unreliable — the reason
// the codebase compares engine objects with isSame, never ===). Groups
// register on construction and unregister on release(); a never-released
// group therefore leaks its slot — release() is contractual.
type GroupRegistration = {root: SceneObject; group: VisibilityGroup}
const groupRegistry: GroupRegistration[] = []

/**
 * Passes currently held open for a fade, the mode to put each back to, and
 * every group holding it. A pass is released only when its LAST holder lets go.
 *
 * Matched with `pass.isSame(...)`, never JS identity: `Pass` extends
 * ScriptObject, each `entry.pass` is an independent `mainPass` read, and this
 * file's rule (see the note above groupRegistry) is not to trust wrapper
 * identity on engine objects. That is also what makes a hold survive a
 * `refresh()` re-capturing the same native pass through a new wrapper.
 */
interface BlendHold {
  pass: Pass
  /** The mode the pass had before the first holder flipped it. */
  restoreTo: BlendMode
  owners: VisibilityGroup[]
}

const blendHolds: BlendHold[] = []

function findBlendHold(pass: Pass): BlendHold | null {
  for (let i = 0; i < blendHolds.length; i++) {
    const held = blendHolds[i].pass
    if (!isNull(held) && !isNull(pass) && held.isSame(pass)) {
      return blendHolds[i]
    }
  }
  return null
}

/** Takes (or joins) a hold, flipping the pass to blending if needed. */
function acquireBlendHold(pass: Pass, owner: VisibilityGroup): void {
  if (isNull(pass)) {
    return
  }
  const existing = findBlendHold(pass)
  if (existing !== null) {
    if (existing.owners.indexOf(owner) < 0) {
      existing.owners.push(owner)
    }
    // Re-assert: a component's own opacity path writes blendMode
    // unconditionally and can flip a held pass back mid-fade.
    if (pass.blendMode !== BlendMode.Normal) {
      pass.blendMode = BlendMode.Normal
    }
    return
  }
  const restoreTo = pass.blendMode
  if (restoreTo !== BlendMode.Normal) {
    pass.blendMode = BlendMode.Normal
  }
  blendHolds.push({pass, restoreTo, owners: [owner]})
}

/** Drops one holder; restores the pass when the last holder goes. */
function releaseBlendHold(pass: Pass, owner: VisibilityGroup): void {
  const hold = findBlendHold(pass)
  if (hold === null) {
    return
  }
  const index = hold.owners.indexOf(owner)
  if (index >= 0) {
    hold.owners.splice(index, 1)
  }
  if (hold.owners.length > 0) {
    return
  }
  // Only undo our own flip, and only if nothing else has claimed the mode
  // since. The pass can also have been destroyed with its content.
  if (!isNull(hold.pass) && hold.pass.blendMode === BlendMode.Normal) {
    hold.pass.blendMode = hold.restoreTo
  }
  const slot = blendHolds.indexOf(hold)
  if (slot >= 0) {
    blendHolds.splice(slot, 1)
  }
}

function findRegisteredGroup(node: SceneObject, self: VisibilityGroup | null): VisibilityGroup | null {
  for (let i = 0; i < groupRegistry.length; i++) {
    // A leaked (never-released) group's root may be destroyed — never let it
    // break other groups' discovery walks.
    if (groupRegistry[i].group !== self && !isNull(groupRegistry[i].root) && node.isSame(groupRegistry[i].root)) {
      return groupRegistry[i].group
    }
  }
  return null
}

// Nearest registered group whose root is a strict ancestor of `root`.
function findCoveringGroup(root: SceneObject, self: VisibilityGroup | null): VisibilityGroup | null {
  let node: SceneObject | null = root.getParent()
  while (node && !isNull(node)) {
    const group = findRegisteredGroup(node, self)
    if (group) {
      return group
    }
    node = node.getParent()
  }
  return null
}

// True when `node` is `ancestor` or sits anywhere under it.
function isUnder(node: SceneObject, ancestor: SceneObject): boolean {
  if (isNull(ancestor)) {
    return false
  }
  let current: SceneObject | null = node
  while (current && !isNull(current)) {
    if (current.isSame(ancestor)) {
      return true
    }
    current = current.getParent()
  }
  return false
}

function hasElementBrand(sceneObject: SceneObject): boolean {
  const scripts = sceneObject.getComponents("Component.ScriptComponent")
  for (let i = 0; i < scripts.length; i++) {
    if ((scripts[i] as {__uikitBrand?: string}).__uikitBrand === UIKitBrands.Element) {
      return true
    }
  }
  return false
}

// Shared staging vec4 for color writes: the engine copies on pass/textFill
// assignment, so mutating one module-level instance keeps the fade hot path
// allocation-free. Never hand this out — callers must assign it to a native
// property immediately.
let colorScratch: vec4 | null = null

function stageColor(initial: vec4, alphaFactor: number): vec4 {
  const scratch = (colorScratch ??= new vec4(0, 0, 0, 0))
  scratch.x = initial.x
  scratch.y = initial.y
  scratch.z = initial.z
  scratch.w = initial.w * alphaFactor
  return scratch
}

function writeColor(entry: ColorEntry, color: vec4): void {
  // The captured surface may have been destroyed after discovery — skip
  // until a refresh re-captures the component. A REPLACED (still-live)
  // surface keeps being driven; the replacement is untouched until refresh.
  if (isNull(entry.surface)) {
    return
  }
  if (entry.isImage) {
    ;(entry.surface as Pass).baseColor = color
  } else {
    ;(entry.surface as TextFill).color = color
  }
}
