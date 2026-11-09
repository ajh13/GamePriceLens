export enum Ranking {
  "Title1" = "Title1",
  "Title2" = "Title2",
  "HeadlineXL" = "HeadlineXL",
  "Headline1" = "Headline1",
  "Headline2" = "Headline2",
  "Subheadline" = "Subheadline",
  "Button" = "Button",
  "Callout" = "Callout",
  "Body" = "Body",
  "Caption" = "Caption"
}

export enum FontWeight {
  "Thin" = 100,
  "ExtraLight" = 200,
  "Light" = 300,
  "Normal" = 400,
  "Medium" = 500,
  "SemiBold" = 600,
  "Bold" = 700,
  "ExtraBold" = 800,
  "Black" = 900
}

type FontSettings = {
  size: number
  weight?: FontWeight // see chart below
}

// Far-distance (110cm) sizes, by design.
const RankingToSettings: Record<Ranking, FontSettings> = {
  [Ranking.Title1]: {size: 109, weight: FontWeight.Bold},
  [Ranking.Title2]: {size: 88, weight: FontWeight.Bold},
  [Ranking.HeadlineXL]: {size: 64, weight: FontWeight.Bold},
  [Ranking.Headline1]: {size: 56, weight: FontWeight.Bold},
  [Ranking.Headline2]: {size: 50, weight: FontWeight.Bold},
  [Ranking.Subheadline]: {size: 46, weight: FontWeight.Bold},
  [Ranking.Button]: {size: 45, weight: FontWeight.Medium},
  [Ranking.Callout]: {size: 43, weight: FontWeight.Bold},
  [Ranking.Body]: {size: 42, weight: FontWeight.Medium},
  [Ranking.Caption]: {size: 37, weight: FontWeight.Medium}
}

/**
 * TextStylePresets is a utility component designed to standardize and easily apply consistent text styles
 * (including font size and optionally font weight) to a Text component based on a selected "ranking" (such as Title1, Headline, Body, etc.).
 *
 * The component uses a predefined mapping from ranking to font settings,
 * ensuring design consistency throughout the UI.
 *
 * Intended usage: Attach to a SceneObject that already contains a Text component, or alongside
 * ElementContent, which binds its generated Text component after content creation. Select the
 * desired ranking using the inspector property to update styling to match design guidelines.
 */
@component
export class TextStylePresets extends BaseScriptComponent {
  @input
  @hint(
    "Preset text style ranking (e.g. Title, Headline, Caption). Applies a consistent font size and weight by design."
  )
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Title 1", "Title1"),
      new ComboBoxItem("Title 2", "Title2"),
      new ComboBoxItem("Headline XL", "HeadlineXL"),
      new ComboBoxItem("Headline 1", "Headline1"),
      new ComboBoxItem("Headline 2", "Headline2"),
      new ComboBoxItem("Subheadline", "Subheadline"),
      new ComboBoxItem("Button", "Button"),
      new ComboBoxItem("Callout", "Callout"),
      new ComboBoxItem("Body", "Body"),
      new ComboBoxItem("Caption", "Caption")
    ])
  )
  private _ranking: string = "Title1"

  private textComponent: Text | null = null

  /**
   * get current text ranking
   */
  public get ranking(): Ranking {
    return this._ranking as Ranking
  }
  /**
   * set current text ranking
   */
  public set ranking(value: Ranking) {
    if (value === undefined || value === this._ranking) return
    this._ranking = value
    if (this.textComponent) {
      this.updateTextStyle()
    }
  }

  /** Bind a generated Text component, or null to release the current target. */
  public bindTextComponent(textComponent: Text | null): void {
    if (textComponent === this.textComponent) return
    this.textComponent = textComponent
    if (this.textComponent) {
      this.updateTextStyle()
    }
  }

  public onAwake() {
    const textComponent = this.sceneObject.getComponent("Text") as Text | null
    if (textComponent) {
      this.bindTextComponent(textComponent)
    }
  }

  private updateTextStyle() {
    if (!this.textComponent) return
    const settings = RankingToSettings[this._ranking as Ranking]
    this.textComponent.size = settings.size
    if (settings.weight !== undefined) {
      ;(this.textComponent as any).weight = settings.weight
    }
  }
}
