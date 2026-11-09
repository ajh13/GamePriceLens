import {Timeline} from "Motion.lspkg/Timeline"
import {Intents} from "../../Motion/SpecIntents"
import {FramePanelBackgroundGray, ProgressBarFillGreen} from "../../Themes/System-3.0/Colors"
import {RoundedRectangle} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {FrameAppearanceConfig, FrameVisual} from "./FrameVisual"

// The panel body renders through its own cutout-capable material (CollapsedSquircle
// base + FramePanelCompose), mirroring how FrameRoundedRectVisual uses Frame.mat.
// This keeps the transparent-center cutout off the shared RoundedRectangle base shader.
const framePanelMaterial: Material = requireAsset("../../../Materials/FramePanel.mat") as Material

const PANEL_BODY_COLOR = FramePanelBackgroundGray
const PANEL_TRANSPARENT_BODY_COLOR = new vec4(0, 0, 0, 0)

const PANEL_HOVER_BORDER_COLOR = ProgressBarFillGreen
// System3 panels use a single fixed corner radius, independent of the
// Large/Small appearance preset — the simpler solid body reads better at one
// consistent, tight radius. (Half the prior Large-appearance value of 1.125.)
// const PANEL_CORNER_RADIUS = 0.5625
const PANEL_CORNER_RADIUS = 0.6
// Default cutout edge softness (local units) used until Frame pushes its
// cutOutFeather input via setCutOutFeather. The shader floors it above zero so
// the edge never aliases. See FramePanelCompose.customCode.
const PANEL_CENTER_FEATHER = 0.1
// Close button + follow drawer tray sit below the frame's top edge, inset
// from the outer edge by a fraction of the grabbable margin band (per the
// System 3.0 design mocks). At 1.0 their top edges land at the bottom of the
// interactive border band; 0.5 moves them halfway back up toward the edge.
// See `_margin` / `setFrameMargin`.
const BUTTON_TOP_MARGIN_FACTOR = 0.75
// Prism close-button depth. ButtonHandler creates and resizes the button
// using this, and getButtonAnchor("close", …) returns half of this plus a
// small nudge on z so the back face sits just forward of the frame body's
// front plane (avoids z-fighting on device).
export const PANEL_CLOSE_BUTTON_DEPTH = 0.8
const CLOSE_BUTTON_Z_NUDGE = 0.1
// Local z for the right drawer, behind the frame body so the body occludes
// the drawer when it's parked at its hidden anchor.
const DRAWER_LOCAL_Z = -0.5

/**
 * The System 3.0 Frame visual: a solid-color rounded body backed by the
 * FramePanel material (CollapsedSquircle base + FramePanelCompose, which adds an
 * optional transparent-center cutout). Colors come directly from the
 * System-3.0 FrameParameters — this visual is not theme-switchable.
 *
 * No cursor highlight, no grab-zone shader, no dots pattern. A subtle border
 * fades in on hover, driven by the 0..1 hover-intensity scalar Frame already
 * animates. Buttons are anchored OUTSIDE the frame body — Close on the left,
 * Follow on the right.
 *
 * Owns its SceneObject + RoundedRectangle component lifecycle.
 */
export class FramePanelVisual implements FrameVisual {
  private _sceneObject: SceneObject | null = null
  private _rr: RoundedRectangle | null = null
  private _hoverIntensity: number = 0
  private _highlightTimeline: Timeline | null = null
  // Width of the grabbable margin band, mirrored from Frame via setFrameMargin.
  // Used to inset the close button + follow drawer tray so their top edges sit
  // at the bottom of the interactive border area (totalSize/2 - margin).
  private _margin: number = 0
  // Whether the transparent-center cutout is requested. Cached so setFrameMargin
  // can refresh the ring width, which follows the grab margin.
  private _cutOutCenter: boolean = false
  // Cutout edge softness (local units), driven by Frame's cutOutFeather input.
  // Cached so applyCutOut re-pushes it; the shader floors it above zero.
  private _cutOutFeather: number = PANEL_CENTER_FEATHER
  // Set from Frame.onlyInteractOnMargin OR Frame.hideBody -- either one makes
  // the panel body fully transparent while the hover-border pass remains
  // available. Both terms matter: a compact owner mode drops margin-only
  // interaction (so the mini frame is body-draggable) while keeping the body
  // hidden, so there this is reached entirely through hideBody.
  private _borderOnly: boolean = false
  // Whether the hover border is currently visible or fading. In border-only mode the body
  // color is fully transparent and the border is hidden at rest, so the pass then draws
  // nothing visible, but the GPU still shades every fragment of the quad (measured on Lens
  // Explorer: ~3 M shaded samples/frame for the 41.5×55 cm store frame). While nothing of the
  // pass can be seen, the body's rendering is suppressed; it comes back for the hover border
  // and stays on until the fade-out completes.
  private _hoverBorderShowing: boolean = false
  private _enabled: boolean = true
  // The material's own depth write, restored when the body stops being border-only. A
  // border-only body never writes depth: it's invisible, and writing depth only while the hover
  // border shows made content behind the frame vanish on hover and reappear at rest.
  private _authoredDepthWrite: boolean = true

  // ─── Lifecycle ──────────────────────────────────────────────────────

  public initialize(parent: SceneObject, layer?: LayerSet): SceneObject {
    this._sceneObject = global.scene.createSceneObject("FramePanelObject")
    if (layer !== undefined) {
      this._sceneObject.layer = layer
    }
    this._sceneObject.setParent(parent)

    this._rr = this._sceneObject.createComponent(RoundedRectangle.getTypeName())
    this._rr.material = framePanelMaterial.clone()
    this._rr.initialize()
    this._rr.cornerRadius = PANEL_CORNER_RADIUS
    this.applyBodyColor()
    // Enable border once (sets _border=true and borderSize without tripping
    // the `enabled=false` side effect that clobbers borderSize). After this
    // we toggle render on/off via borderVisible so borderSize survives hover
    // exits.
    this._rr.border = true
    this._rr.borderSize = 0.25
    this.applyBorderColor()
    this._rr.borderVisible = false
    this._rr.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    this._rr.renderMeshVisual.mainPass.twoSided = true
    this._authoredDepthWrite = this._rr.renderMeshVisual.mainPass.depthWrite
    this.applyBodyDepthWrite()
    this.applyCutOut()
    this.refreshBodyVisibility()

    return this._sceneObject
  }

  // The body pass renders only when something of it can be seen: a solid body, or the hover
  // border while it is showing/fading. Everything else about the pass (color, border state,
  // cutout uniforms) keeps being maintained so re-enabling is instantaneous. Goes through
  // renderSuppressed so a SceneObject enable cycle keeps the body off.
  private refreshBodyVisibility(): void {
    if (!this._rr) return
    const anythingVisible = !this._borderOnly || this._hoverBorderShowing
    this._rr.renderSuppressed = !(this._enabled && anythingVisible)
  }

  private applyBodyDepthWrite(): void {
    if (!this._rr) return
    this._rr.renderMeshVisual.mainPass.depthWrite = this._borderOnly ? false : this._authoredDepthWrite
  }

  public destroy(): void {
    this._highlightTimeline?.kill()
    this._highlightTimeline = null
    if (!isNull(this._sceneObject) && this._sceneObject) {
      this._sceneObject.destroy()
    }
    this._rr = null
    this._sceneObject = null
  }

  // ─── Geometry ───────────────────────────────────────────────────────

  public setSize(size: vec2): void {
    if (this._rr) this._rr.size = size
  }

  public get cornerRadius(): number {
    return this._rr?.cornerRadius ?? 0
  }

  // ─── Appearance ─────────────────────────────────────────────────────

  public applyAppearance(config: FrameAppearanceConfig): void {
    if (!this._rr) return
    // System3 ignores the per-appearance cornerRadius — Large/Small share one
    // fixed panel radius. Only the border size still follows the appearance.
    this._rr.cornerRadius = PANEL_CORNER_RADIUS
    this._rr.borderSize = config.borderSize
  }

  public setCornerRadius(radius: number): void {
    if (this._rr) this._rr.cornerRadius = radius
  }

  // ─── Visibility / Opacity ───────────────────────────────────────────

  public setEnabled(enabled: boolean): void {
    this._enabled = enabled
    this.refreshBodyVisibility()
  }

  public setOpacity(opacity: number): void {
    // Frame.ts decides whether to actually drive this — for System3 the body
    // fades only when autoShowHide is on. When autoShowHide is off the
    // setter is simply never called from the show/hide tween, so the body
    // stays at full opacity.
    if (this._rr) this._rr.opacity = opacity
  }

  // ─── Render Order ───────────────────────────────────────────────────

  public getRenderOrder(): number {
    return this._rr?.renderMeshVisual.getRenderOrder() ?? 0
  }

  public setRenderOrder(order: number): void {
    if (this._rr) this._rr.renderMeshVisual.setRenderOrder(order)
  }

  // ─── Frustum Culling ────────────────────────────────────────────────

  public setFrustumCullBounds(min: vec3, max: vec3): void {
    if (!this._rr) return
    const pass = this._rr.renderMeshVisual.mainMaterial.mainPass
    pass.frustumCullMin = min
    pass.frustumCullMax = max
  }

  // ─── Interaction Feedback ───────────────────────────────────────────

  public setHoverIntensity(_value: number): void {
    // no-op: Panel uses setFrameHovered for its border fade, not the
    // margin-specific cursor proximity scalar.
  }

  public setFrameHovered(hovered: boolean): void {
    if (!this._rr) return
    if (hovered) {
      this._rr.borderVisible = true
      this._hoverBorderShowing = true
      this.refreshBodyVisibility()
    } else if (this._hoverIntensity <= 0) {
      // Nothing to fade out, so hide immediately rather than waiting on a no-op timeline.
      this._rr.borderVisible = false
      this._hoverBorderShowing = false
      this.refreshBodyVisibility()
    }
    // Retained "highlight" timeline: hover-out mid-hover-in reverses from the
    // current intensity (the legacy tween replayed its full fixed duration
    // from wherever it was).
    if (this._highlightTimeline === null) {
      this._highlightTimeline = Intents.highlight(
        {
          apply: (value: number) => {
            this._hoverIntensity = value
            this.applyBorderColor()
          },
          read: () => this._hoverIntensity,
          onComplete: (forward: boolean) => {
            if (!forward && this._rr) {
              this._rr.borderVisible = false
              this._hoverBorderShowing = false
              this.refreshBodyVisibility()
            }
          }
        },
        {direction: hovered ? "forward" : "reverse"}
      )
    } else {
      this._highlightTimeline.play(hovered)
    }
  }

  public setActiveState(_isActive: boolean, _borderColor: vec4): void {
    // Hook point for System 3.0 active/pinch feedback. Intentionally empty —
    // the hover fade alone carries interaction feedback for now.
  }

  public setCursorPosition(_position: vec2): void {
    // no-op: Panel has no cursor highlight
  }

  public setCursorRadiusFactor(_factor: number): void {
    // no-op: Panel has no cursor highlight
  }

  public setGlowOpacityFactor(_factor: number): void {
    // no-op: Panel has no glow
  }

  // ─── Margin / Interaction Regions ──────────────────────────────────

  public setFrameMargin(margin: number): void {
    // Cache the margin so getButtonAnchor / getRightDrawerAnchor can inset the
    // close button + follow tray to the bottom of the interactive border band.
    // Also feeds the cutout ring width (the opaque band kept around a cut-out
    // center), mirroring the System2 frame where the ring width = frameBorder.
    this._margin = margin
    this.applyCutOut()
  }

  public setBorderOnly(borderOnly: boolean): void {
    this._borderOnly = borderOnly
    this.applyBodyDepthWrite()
    this.refreshBodyVisibility()
    this.applyBodyColor()
    // The resting border matches the body, so it moves with it. Without this a
    // frame that becomes border-only while unhovered keeps an opaque resting
    // color, and the next hover shows it for the frame between the border pass
    // switching on and the fade's first tick.
    this.applyBorderColor()
  }

  public setCutOutCenter(cutOut: boolean): void {
    this._cutOutCenter = cutOut
    this.applyCutOut()
  }

  public setCutOutFeather(feather: number): void {
    this._cutOutFeather = feather
    this.applyCutOut()
  }

  // Drives the FramePanel material's cutOutCenter / frameBorder / centerFeather
  // uniforms so the panel center goes transparent, leaving an opaque ring of
  // width _margin (the grab margin, matching the System2 frame). Guarded on
  // uniform existence so the panel keeps rendering if FramePanel.mat has not been
  // wired to expose them yet.
  private applyCutOut(): void {
    if (!this._rr) return
    const pass = this._rr.renderMeshVisual.mainPass
    if (typeof pass.cutOutCenter !== "undefined") {
      pass.cutOutCenter = this._cutOutCenter
      pass.frameBorder = this._margin
      if (typeof pass.centerFeather !== "undefined") {
        pass.centerFeather = this._cutOutFeather
      }
    } else if (this._cutOutCenter) {
      print(
        "[FramePanelVisual] cutOutCenter requested but FramePanel.mat has no cutOutCenter uniform; " +
          "check that FramePanelShader exposes it. Body stays solid."
      )
    }
  }

  private applyBodyColor(): void {
    if (!this._rr) return
    this._rr.backgroundColor = this.bodyColor()
  }

  private bodyColor(): vec4 {
    return this._borderOnly ? PANEL_TRANSPARENT_BODY_COLOR : PANEL_BODY_COLOR
  }

  /**
   * Repaints the hover band from the current intensity, resting on the body's
   * own color.
   *
   * The band and the body are two regions of one pass, so an unhovered band is
   * hidden by matching the body rather than by any alpha of its own — which is
   * why the rest endpoint has to be the live body color and not the solid-body
   * constant. Border-only mode makes the body fully transparent, so a hardcoded
   * opaque rest endpoint left the ring popping on at full strength and off
   * again at the end of the fade, over nothing. Reusing
   * PANEL_TRANSPARENT_BODY_COLOR also keeps rgb zeroed with alpha, as the
   * premultiplied blend mode set in initialize requires.
   */
  private applyBorderColor(): void {
    if (!this._rr) return
    this._rr.borderColor = vec4.lerp(this.bodyColor(), PANEL_HOVER_BORDER_COLOR, this._hoverIntensity)
  }

  // ─── Grab Zones ─────────────────────────────────────────────────────

  public setGrabZones(_zones: vec4[]): void {
    // no-op: Panel does not highlight grab zones
  }

  // ─── Button Layout ──────────────────────────────────────────────────

  public getButtonAnchor(type: "close" | "follow", totalSize: vec2, buttonSize: number, _offset: number): vec3 {
    // Center each button on the frame's vertical edge so it half-overlaps
    // the frame body (System 3.0 look). Classic visual stays inset. z is
    // half the Prism depth plus CLOSE_BUTTON_Z_NUDGE so the back face sits
    // just in front of the frame body's front plane (z=0) rather than
    // coplanar with it — coplanar faces z-fight on device.
    // Inset by a fraction of the margin so the button's TOP edge lands within
    // the interactive border band (totalSize/2 - margin * BUTTON_TOP_MARGIN_FACTOR).
    const topY = totalSize.y * 0.5 - this._margin * BUTTON_TOP_MARGIN_FACTOR - buttonSize * 0.5
    const x = type === "close" ? -totalSize.x * 0.5 : totalSize.x * 0.5
    return new vec3(x, topY, PANEL_CLOSE_BUTTON_DEPTH * 0.5 + CLOSE_BUTTON_Z_NUDGE)
  }

  public getRightDrawerAnchor(totalSize: vec2, drawerWidth: number, _offset: number): vec3 {
    // Drawer left edge sits flush with the frame's right edge (no overlap).
    // Top edge insets by the same margin fraction as the close button so the
    // two align (totalSize/2 - margin * BUTTON_TOP_MARGIN_FACTOR).
    const drawerTopY = totalSize.y * 0.5 - this._margin * BUTTON_TOP_MARGIN_FACTOR
    return new vec3(totalSize.x * 0.5 + drawerWidth * 0.5, drawerTopY, DRAWER_LOCAL_Z)
  }
}
