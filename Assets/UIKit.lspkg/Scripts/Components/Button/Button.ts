import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {SYSTEM_2_NAME, SYSTEM_3_NAME} from "../../Themes/Theme"
import {BeveledPrismVisual, BeveledPrismVisualState} from "../../Visuals/BeveledPrism/BeveledPrismVisual"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {BaseButton} from "./BaseButton"

// Default corner radius (cm) for a Rectangle-shape button. Exported so
// containers (e.g. ElementGroup) can derive a concentric outer radius from it
// instead of duplicating the literal.
export const DEFAULT_BUTTON_CORNER_RADIUS: number = 0.5

const log = new NativeLogger("Button")

// Inspector combobox values per theme. setVariant validates against these
// to catch typos at the call site instead of silently falling back at
// resolve time.
// Keyed by canonical theme name (what `theme.name` returns), NOT by the
// exported theme identifiers — those two are deliberately different strings.
const VALID_SHAPES: Record<string, ReadonlyArray<string>> = {
  [SYSTEM_2_NAME]: ["Rectangle", "Capsule", "Round"],
  [SYSTEM_3_NAME]: ["Rectangle", "Capsule", "Round"]
}

// TODO(uikit-visual-factory): Visual selection here uses hardcoded (theme,
// style) checks + per-type instanceof helpers, which won't scale beyond the
// current two Visual subclasses. Follow-up should replace with a
// (theme, style) → VisualFactory registry where each Visual self-registers.
// Specifically:
//   - usesPrismVisual + the parallel branches in createDefaultVisual
//     → factory lookup (one construction path)
//   - getVisualAsRoundedRectVisual / getVisualAsBeveledPrismVisual
//     → a SizableVisual interface (size, cornerRadius) — drops instanceof
//   - shouldOverrideCornerRadius's Prism+Rectangle special-case
//     → Visual.autoCornerRadiusForShape(shape) getter (decision lives on
//       the Visual, not Button)
//   - setTheme's per-theme style-field switch (writes _styleSystem2 vs
//     _styleSystem3): if other components grow multi-style choices, lift
//     to a polymorphic `setStyleField(style)` hook on VisualElement. For
//     now Button is the only multi-style component so the switch is here.
// Tracking ticket: TBD.

/**
 * Main Button component for UIKit
 * Select Theme, Shape and Style
 */
@component
export class Button extends BaseButton implements OpacityControllable {
  @input
  @hint("Size of the element in centimeters")
  protected _size: vec3 = new vec3(9, 3.75, 1)

  @input
  @showIf("_themeOverride", "System2")
  @label("Shape")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Rectangle", "Rectangle"),
      new ComboBoxItem("Capsule", "Capsule"),
      new ComboBoxItem("Round", "Round")
    ])
  )
  protected _shapeSystem2: string = "Rectangle"

  @input
  @showIf("_themeOverride", "System3")
  @label("Shape")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Rectangle", "Rectangle"),
      new ComboBoxItem("Capsule", "Capsule"),
      new ComboBoxItem("Round", "Round")
    ])
  )
  protected _shapeSystem3: string = "Rectangle"

  @input
  @showIf("_themeOverride", "System2")
  @label("Style")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("PrimaryNeutral", "PrimaryNeutral"),
      new ComboBoxItem("Primary", "Primary"),
      new ComboBoxItem("Secondary", "Secondary"),
      new ComboBoxItem("Special", "Special"),
      new ComboBoxItem("Ghost", "Ghost")
    ])
  )
  protected _styleSystem2: string = "PrimaryNeutral"

  @input
  @showIf("_themeOverride", "System3")
  @label("Style")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Prism", "Prism"),
      new ComboBoxItem("PrismGhost", "PrismGhost"),
      new ComboBoxItem("Primary", "Primary"),
      new ComboBoxItem("Secondary", "Secondary"),
      new ComboBoxItem("Ghost", "Ghost"),
      new ComboBoxItem("Tag", "Tag"),
      new ComboBoxItem("Chip", "Chip")
    ])
  )
  protected _styleSystem3: string = "Primary"

  protected get effectiveStyle(): string {
    switch (this.resolveTheme().name) {
      case SYSTEM_2_NAME:
        return this._styleSystem2
      case SYSTEM_3_NAME:
        return this._styleSystem3
      default:
        return this.resolveTheme().defaultStyleName
    }
  }

  protected get effectiveShape(): string {
    switch (this.resolveTheme().name) {
      case SYSTEM_2_NAME:
        return this._shapeSystem2
      case SYSTEM_3_NAME:
        return this._shapeSystem3
      default:
        return this.resolveTheme().defaultShapeName ?? "Rectangle"
    }
  }

  /**
   * Key this button's visual looks up in `theme.styles`. Deliberately NOT
   * `typeString`: subclasses that are only behaviorally different should keep
   * rendering as a Button rather than silently falling back to an unstyled
   * visual because nobody added a `styles` entry under their class name.
   *
   * Override only when a subclass ships its own per-state palette AND registers
   * it in every theme — a missing entry resolves to the theme's default style,
   * and a missing component key entirely leaves the visual unstyled.
   *
   * @see LongPressButton
   */
  protected get visualStyleType(): string {
    return "Button"
  }

  @input
  @widget(new SliderWidget(0, 1))
  protected _opacity: number = 1.0

  public get opacity(): number {
    const roundedRectVisual = this.getVisualAsRoundedRectVisual()
    if (roundedRectVisual) {
      return roundedRectVisual.opacity
    }
    const prismVisual = this.getVisualAsBeveledPrismVisual()
    return prismVisual ? prismVisual.opacity : this._opacity
  }

  public set opacity(opacity: number) {
    this._opacity = opacity
    const roundedRectVisual = this.getVisualAsRoundedRectVisual()
    if (roundedRectVisual) {
      if (!this.isAlwaysTransparent) {
        roundedRectVisual.transparencyEnabled = opacity < 1.0
      }
      roundedRectVisual.opacity = opacity
      return
    }
    const prismVisual = this.getVisualAsBeveledPrismVisual()
    if (prismVisual) {
      prismVisual.opacity = opacity
    }
  }

  // The Rectangle radius pinned by the cornerRadius setter, or null.
  private _cornerRadiusOverride: number | null = null

  /**
   * Corner radius in cm of the button's body, as applied for its shape.
   *
   * Rectangle: the radius set here, else the default,
   * {@link DEFAULT_BUTTON_CORNER_RADIUS} or the theme's radius on the Prism
   * styles. Capsule and Round always derive theirs from size (half the shorter
   * side, half the width): a radius set on them is kept but not applied.
   *
   * Setting pins the Rectangle radius until {@link resetCornerRadius}. Size
   * writes and visual replacement keep it, and after initialization it applies
   * at once, drop shadow included. Safe to set before or after initialization.
   *
   * Set it here, not on `visual.cornerRadius`: size writes re-apply the
   * button's radius, so a direct visual write is lost on the next resize. The
   * one exception is a Prism Rectangle with no radius set, where size writes
   * leave the visual's radius alone.
   */
  public get cornerRadius(): number {
    const visual = this.getVisualAsRoundedRectVisual() ?? this.getVisualAsBeveledPrismVisual()
    if (visual) {
      return visual.cornerRadius
    }
    // No visual yet: the radius initialize will apply.
    return this.shouldOverrideCornerRadius ? this.getCornerRadius() : this.prismStyleCornerRadius
  }

  public set cornerRadius(value: number) {
    if (value === undefined) {
      return
    }
    this._cornerRadiusOverride = value
    if (this._initialized) {
      this.applyCornerRadius()
    }
  }

  /**
   * Clears a {@link cornerRadius} override so the button takes its shape's
   * default radius again, and re-applies that default (drop shadow included)
   * when initialized.
   */
  public resetCornerRadius(): void {
    this._cornerRadiusOverride = null
    if (this._initialized) {
      this.applyCornerRadius()
    }
  }

  /**
   * The button's `Visual`. One assigned after initialization takes the
   * button's corner radius at once, as it would on the next size write.
   */
  public get visual(): Visual {
    return super.visual
  }

  public set visual(value: Visual) {
    const previous = this._visual
    super.visual = value
    if (this._initialized && this._visual !== previous) {
      this.applyCornerRadius()
    }
  }

  public get size(): vec3 {
    return this._size
  }

  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    const shape = this.effectiveShape
    if (shape === "Round") {
      size = new vec3(size.x, size.x, size.z)
    }
    super.size = size
    if (this._initialized) {
      const rrVisual = this.getVisualAsRoundedRectVisual()
      if (rrVisual) {
        rrVisual.size = size
        rrVisual.cornerRadius = this.getCornerRadius()
        // Capsule and Round radii follow size; configureShadow copies the body radius only at
        // initialize, so a resize would otherwise leave the shadow's corner behind.
        if (this.shadowVisual) {
          this.shadowVisual.cornerRadius = rrVisual.cornerRadius
        }
      } else {
        const prismVisual = this.getVisualAsBeveledPrismVisual()
        if (prismVisual) {
          prismVisual.size = size
          if (this.shouldOverrideCornerRadius) {
            prismVisual.cornerRadius = this.getCornerRadius()
          }
        }
      }
    }
  }

  /**
   * Programmatically set the theme override and style before initialize().
   * Must be called before initialize() — createDefaultVisual() reads both
   * fields at init time to pick the Visual subclass. Replaces direct field
   * assignment from runtime callers (tests, dynamic UI factories) that
   * can't drag values in the LS Inspector.
   *
   * Theme half delegates to `VisualElement.setThemeOverride` (reusable by
   * any themeable component); the style switch is Button-specific by
   * current convention — each themeable component declares its own
   * `_styleSystem{N}` fields. If style becomes polymorphic, lift to a
   * `setStyleField` hook on VisualElement (see Visual factory TODO above).
   *
   * @param theme  "System 2.0", "System 3.0", or "Inherited"
   * @param style  style name valid for the chosen theme (e.g. "Prism",
   *               "Primary", "Secondary", "Ghost"). Invalid styles fall
   *               back to the theme's default at resolve time.
   */
  public setTheme(theme: string, style: string): void {
    this.setVariant({theme, style})
  }

  /**
   * Type-safe pre-initialize configuration. Sets theme override, shape,
   * and style in one call so runtime factories don't have to reach into
   * private fields via `as any` casts. Must be called before initialize().
   *
   * Shape and style are written to the theme-specific private fields
   * (`_shapeSystem{2,3}`, `_styleSystem{2,3}`), so they require a concrete
   * theme to be set — either passed in this call as `opts.theme`, or set
   * earlier via `setThemeOverride`. If the effective theme is "Inherited"
   * or anything else, shape/style writes are dropped with a warning.
   *
   * Unknown shape/style values for the chosen theme also warn but still
   * write (matching the framework's "invalid value falls back to theme
   * default at resolve time" semantics).
   *
   * @param opts.theme  "System 2.0" | "System 3.0" | "Inherited" (theme override).
   * @param opts.shape  Shape name valid for the chosen theme — e.g.
   *                    "Rectangle" | "Round" | "Capsule". Requires a
   *                    concrete (non-Inherited) theme to be set.
   * @param opts.style  Style name valid for the chosen theme — e.g.
   *                    "Prism" | "Primary" | "Secondary" | "Ghost" for
   *                    System3; "PrimaryNeutral" | "Primary" | "Secondary"
   *                    | "Special" | "Ghost" for System2. Requires a
   *                    concrete theme to be set.
   */
  public setVariant(opts: {theme?: string; shape?: string; style?: string}): void {
    if (opts.theme !== undefined) {
      this.setThemeOverride(opts.theme)
    }
    const theme = this.normalizedThemeOverride
    const themeIsResolvable = theme === SYSTEM_2_NAME || theme === SYSTEM_3_NAME
    const where = this.sceneObject.name

    if (opts.shape !== undefined) {
      if (!themeIsResolvable) {
        log.w(
          `setVariant on ${where}: dropping shape "${opts.shape}" — theme override is "${theme}". ` +
            `Set theme to "${SYSTEM_2_NAME}" or "${SYSTEM_3_NAME}" first.`
        )
      } else {
        const validShapes = VALID_SHAPES[theme]
        if (!validShapes.includes(opts.shape)) {
          log.w(
            `setVariant on ${where}: shape "${opts.shape}" is not a known ${theme} shape. ` +
              `Valid: ${validShapes.join(", ")}.`
          )
        }
        if (theme === SYSTEM_2_NAME) {
          this._shapeSystem2 = opts.shape
        } else {
          this._shapeSystem3 = opts.shape
        }
      }
    }

    if (opts.style !== undefined) {
      if (!themeIsResolvable) {
        log.w(
          `setVariant on ${where}: dropping style "${opts.style}" — theme override is "${theme}". ` +
            `Set theme to "${SYSTEM_2_NAME}" or "${SYSTEM_3_NAME}" first.`
        )
      } else {
        const buttonStyles = this.resolveTheme().styles?.Button
        if (buttonStyles && !(opts.style in buttonStyles)) {
          log.w(
            `setVariant on ${where}: style "${opts.style}" is not defined for theme "${theme}". ` +
              `Valid: ${Object.keys(buttonStyles).join(", ")}. ` +
              `Invalid styles fall back to the theme default at resolve time.`
          )
        }
        if (theme === SYSTEM_2_NAME) {
          this._styleSystem2 = opts.style
        } else {
          this._styleSystem3 = opts.style
        }
      }
    }
  }

  protected createDefaultVisual(): void {
    if (this._visual) {
      // A visual assigned before initialize keeps its own radius on a Rectangle unless one was set
      // here. A set radius, and Capsule's and Round's size-derived one, apply now, before the
      // shadow copies the body's radius.
      const shape = this.effectiveShape
      if (this._cornerRadiusOverride !== null || shape === "Capsule" || shape === "Round") {
        this.applyCornerRadius()
      }
      return
    }

    const shape = this.effectiveShape
    if (shape === "Round") {
      this._size = new vec3(this._size.x, this._size.x, 1)
    }

    const styleKey = {
      visualElementType: this.visualStyleType,
      style: this.effectiveStyle,
      themeName: this.normalizedThemeOverride !== "Inherited" ? this.normalizedThemeOverride : undefined
    }

    if (this.usesPrismVisual) {
      const prismVisual = new BeveledPrismVisual({
        sceneObject: this.sceneObject,
        style: styleKey
      })
      if (this.shouldOverrideCornerRadius) {
        prismVisual.cornerRadius = this.getCornerRadius()
      }
      prismVisual.opacity = this._opacity
      this._visual = prismVisual
      return
    }

    const alwaysTransparent = this.isAlwaysTransparent
    const defaultVisual: RoundedRectangleVisual = new RoundedRectangleVisual({
      sceneObject: this.sceneObject,
      style: styleKey,
      transparent: alwaysTransparent || this._opacity < 1.0
    })
    defaultVisual.cornerRadius = this.getCornerRadius()
    defaultVisual.opacity = this._opacity
    this._visual = defaultVisual
  }

  protected get isAlwaysTransparent(): boolean {
    const style = this.effectiveStyle
    // Ghost and Secondary are outline styles with a transparent fill, so they
    // need alpha blending (PremultipliedAlphaAuto) even at full opacity.
    // Otherwise the default Disabled (opaque) blend mode ignores the fill's
    // alpha and the transparent background renders as solid.
    return style === "Ghost" || style === "Secondary"
  }

  // Prism style uses the beveled prism shader stack instead of the flat
  // rounded rectangle. Only valid under System3 — earlier themes don't
  // ship the prism material.
  protected get usesPrismVisual(): boolean {
    if (this.resolveTheme().name !== SYSTEM_3_NAME) {
      return false
    }
    const style = this.effectiveStyle
    return style === "Prism" || style === "PrismGhost"
  }

  // Capsule and Round shapes need cornerRadius derived from size to be
  // geometrically correct, so Button always overrides those. Rectangle
  // Prism leaves the corner up to the theme so designers can tune it,
  // unless the consumer set a `cornerRadius` override.
  protected get shouldOverrideCornerRadius(): boolean {
    if (this.usesPrismVisual && this.effectiveShape === "Rectangle") {
      return this._cornerRadiusOverride !== null
    }
    return true
  }

  /**
   * Corner radius in cm a Rectangle button falls back to when no
   * `cornerRadius` is set. The Prism styles take the theme's radius instead.
   * Subclasses with their own default (VoiceInputButton) override this.
   */
  protected get defaultRectangleCornerRadius(): number {
    return DEFAULT_BUTTON_CORNER_RADIUS
  }

  // The radius Button writes when it owns the corner (see
  // shouldOverrideCornerRadius).
  protected getCornerRadius(): number {
    const shape = this.effectiveShape
    switch (shape) {
      case "Capsule":
        return Math.min(this._size.x, this._size.y) * 0.5
      case "Round":
        return this._size.x * 0.5
      default:
        return this._cornerRadiusOverride ?? this.defaultRectangleCornerRadius
    }
  }

  // The Prism style's Rectangle radius, for the getter before the prism
  // visual exists. BeveledPrism's own default is also 0.5.
  private get prismStyleCornerRadius(): number {
    const style = this.resolveTheme().styles[this.visualStyleType]?.[this.effectiveStyle]
    return (style?.default as BeveledPrismVisualState | undefined)?.cornerRadius ?? DEFAULT_BUTTON_CORNER_RADIUS
  }

  // Re-applies the corner radius outside a size write: an override change, a
  // reset, or a replaced visual. The size setter applies it itself.
  protected applyCornerRadius(): void {
    const rrVisual = this.getVisualAsRoundedRectVisual()
    if (rrVisual) {
      rrVisual.cornerRadius = this.getCornerRadius()
      // configureShadow copies the body radius only at initialize.
      if (this.shadowVisual) {
        this.shadowVisual.cornerRadius = rrVisual.cornerRadius
      }
      return
    }
    const prismVisual = this.getVisualAsBeveledPrismVisual()
    if (prismVisual) {
      prismVisual.cornerRadius = this.shouldOverrideCornerRadius
        ? this.getCornerRadius()
        : prismVisual.styleCornerRadius
    }
  }

  private getVisualAsRoundedRectVisual(): RoundedRectangleVisual | undefined {
    if (!this._visual) {
      return undefined
    }
    if (!(this._visual instanceof RoundedRectangleVisual)) {
      return undefined
    }
    return this._visual as RoundedRectangleVisual
  }

  private getVisualAsBeveledPrismVisual(): BeveledPrismVisual | undefined {
    if (!this._visual) {
      return undefined
    }
    if (!(this._visual instanceof BeveledPrismVisual)) {
      return undefined
    }
    return this._visual as BeveledPrismVisual
  }
}
