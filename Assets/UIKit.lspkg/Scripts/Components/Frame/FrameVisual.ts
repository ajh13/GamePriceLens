/**
 * Appearance preset config applied to the frame's visual.
 * The per-appearance values (Large/Small) live on `FrameConstants.appearances`
 * so themes can override them. The `margin` field is consumed by Frame (not
 * the visual) — visuals should cherry-pick what they render.
 */
export type FrameAppearanceConfig = {
  margin: number
  cornerRadius: number
  borderSize: number
  dotsHighlightStop1: number
  dotsScalar: number
}

/**
 * Behavioral contract for Frame's visual implementation.
 *
 * The interface intentionally stays at the behavioral level (setHoverIntensity,
 * setActiveState) rather than exposing shader uniforms. Visuals that don't
 * support a particular feedback mode (e.g. no glow, no cursor tracking) may
 * no-op those methods.
 *
 * The visual owns the SceneObject it creates in `initialize()`. Frame does
 * NOT add it to its `managedSceneObjects` list — the visual's `destroy()` is
 * responsible for cleanup.
 */
export interface FrameVisual {
  // ─── Lifecycle ──────────────────────────────────────────────────────
  /**
   * Create the visual's SceneObject + components as a child of `parent`.
   * @param layer Optional LayerSet. If omitted, the visual inherits the
   *              parent's default layer behavior.
   * @returns The SceneObject root of the visual (used by Frame for layout
   *          reference and as a parent for child UI like buttons).
   */
  initialize(parent: SceneObject, layer?: LayerSet): SceneObject

  /** Destroy all SceneObjects and components the visual created. */
  destroy(): void

  // ─── Geometry ───────────────────────────────────────────────────────
  /** Set the outer size (innerSize + margin*2 + padding, computed by Frame). */
  setSize(size: vec2): void

  /** Read current corner radius. Used by SnappingHandler for ghost matching.
   *  May return 0 for visuals without rounded corners. */
  readonly cornerRadius: number

  /** Write the corner radius directly, bypassing the per-appearance config.
   *  Used by `Frame.cornerRadius` setter for consumer customization that
   *  persists across appearance changes. */
  setCornerRadius(radius: number): void

  // ─── Appearance ─────────────────────────────────────────────────────
  /** Apply an appearance preset. Visual picks what it can render; ignores the rest. */
  applyAppearance(config: FrameAppearanceConfig): void

  // ─── Visibility / Opacity ───────────────────────────────────────────
  setEnabled(enabled: boolean): void
  setOpacity(opacity: number): void

  // ─── Render Order ───────────────────────────────────────────────────
  getRenderOrder(): number
  setRenderOrder(order: number): void

  // ─── Frustum Culling ────────────────────────────────────────────────
  setFrustumCullBounds(min: vec3, max: vec3): void

  // ─── Interaction Feedback (may no-op) ───────────────────────────────
  /** Set hover highlight intensity in [0, 1]. Tracks margin-specific cursor
   *  proximity — dims when the cursor moves onto the frame's content. */
  setHoverIntensity(value: number): void

  /** Set the frame-level hover state: true while the frame's Interactable is
   *  hovered (including when a child element is targeted), false once the
   *  cursor leaves the frame entirely. Distinct from setHoverIntensity. */
  setFrameHovered(hovered: boolean): void

  /** Set active/pinch state. Visual may change color, gradient, or border. */
  setActiveState(isActive: boolean, borderColor: vec4): void

  /** Set cursor position in normalized frame-local coords. */
  setCursorPosition(position: vec2): void

  /** Set cursor radius factor (near-field feedback) in [0, 1]. */
  setCursorRadiusFactor(factor: number): void

  /** Set glow opacity factor (far↔near field transition fade) in [0, 1]. */
  setGlowOpacityFactor(factor: number): void

  // ─── Margin / Interaction Regions (may no-op) ──────────────────────
  /** Set the frame's margin width (used for shader highlighting on supporting visuals). */
  setFrameMargin(margin: number): void

  /** When true, visually indicate that only the margin is interactive. */
  setBorderOnly(borderOnly: boolean): void

  /** When true, render the center transparent. */
  setCutOutCenter(cutOut: boolean): void

  /** Softness (local units) of the cutout edge. Visuals floor/ignore as needed. */
  setCutOutFeather(feather: number): void

  // ─── Grab Zones ─────────────────────────────────────────────────────
  setGrabZones(zones: vec4[]): void

  // ─── Button Layout ──────────────────────────────────────────────────
  /**
   * Return the local-space position (relative to frameObject) where a
   * named frame button should sit. The visual owns button placement so
   * different visuals can put buttons inside the margin (classic) or
   * outside the frame body (panel).
   *
   * @param type Named button slot.
   * @param totalSize Frame's current totalSize (innerSize + margin*2 + padding).
   * @param buttonSize Outer diameter/width of the button in cm.
   * @param offset Small inset/gap value supplied by ButtonHandler — visuals
   *               may use or ignore it based on their layout model.
   */
  getButtonAnchor(type: "close" | "follow", totalSize: vec2, buttonSize: number, offset: number): vec3

  /**
   * Return the local-space position (relative to frameObject) where the
   * System3 right drawer's top-center should sit. The drawer extends
   * downward from this point as items are added.
   *
   * Visuals that don't host a drawer can return any value — the System2
   * frame visual falls back to its single-follow-button layout instead.
   */
  getRightDrawerAnchor(totalSize: vec2, drawerWidth: number, offset: number): vec3
}
