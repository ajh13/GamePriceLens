import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {ElementContent, TextAlignment, TextSizing} from "../Content/ElementContent"
import {addContentToElement} from "../Content/ElementContentFactory"
import {BaseButton} from "./../Button/BaseButton"

/**
 * `Link` — interactable text that restyles per interaction state (default /
 * hovered / triggered / inactive), like a web hyperlink, with an
 * always-visible underline.
 *
 * It reuses the full button interaction stack (Interactable + state machine +
 * theme resolution) by extending `BaseButton`, but its background visual is
 * created and then disabled so nothing draws — zero draw calls, not a
 * transparent quad. The label and underline are an `ElementContent` companion
 * (auto-created here). Per-state colors resolve from the theme's
 * `ContentColors["Link"]` palette: the class name `Link` is the lookup key
 * (`typeString`), so no extra wiring is needed.
 *
 * @extends BaseButton
 */
@component
export class Link extends BaseButton {
  @input
  @label("Text")
  @hint("Link label text.")
  private _text: string = "Link"

  @input
  @label("Text Size")
  @hint("Font size in Lens Studio units.")
  private _textSize: number = 48

  private _content: ElementContent | null = null

  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }
    // The background never draws — it exists only to satisfy VisualElement's
    // interaction/state plumbing.
    this.hideBackgroundMesh()
    this.ensureContent()
    return true
  }

  protected createDefaultVisual(): void {
    if (this._visual) {
      return
    }
    const visual = new RoundedRectangleVisual({sceneObject: this.sceneObject, transparent: true})
    visual.cornerRadius = 0
    this._visual = visual
  }

  // VisualElement re-enables the visual on every enable cycle; re-disable the
  // background mesh afterwards so the Link stays draw-free.
  protected enableVisuals(): void {
    super.enableVisuals()
    this.hideBackgroundMesh()
  }

  private hideBackgroundMesh(): void {
    const rmv = this._visual?.renderMeshVisual
    if (rmv && !isNull(rmv)) {
      rmv.enabled = false
    }
  }

  private ensureContent(): void {
    // Respect an ElementContent authored alongside the Link in a prefab; only
    // create one when none is present.
    const existing = this.sceneObject.getComponent(ElementContent.getTypeName()) as ElementContent | null
    if (existing && !isNull(existing)) {
      this._content = existing
      existing.underline = true
      return
    }
    this._content = addContentToElement(this.sceneObject, {
      text: this._text,
      textSize: this._textSize,
      // Links are always center-aligned.
      textAlignment: TextAlignment.Center,
      // Fit: the label renders at its natural width so it never truncates, and
      // the underline (also natural width) lines up exactly. autoResize then
      // hugs the invisible hit-area to the text.
      textSizing: TextSizing.Fit,
      autoResize: true,
      underline: true
    })
  }

  /**
   * The link's label text.
   */
  public get text(): string {
    return this._content && !isNull(this._content) ? this._content.text : this._text
  }

  public set text(value: string) {
    this._text = value
    if (this._content && !isNull(this._content)) {
      this._content.text = value
    }
  }
}
