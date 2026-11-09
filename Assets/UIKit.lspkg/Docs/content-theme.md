# UIKit content and theme

[← Agent usage index](../README.md)

## Use when

Read this when adding labels/icons, selecting component variants, or applying
the package typography and color system.

## Current API

### Theme selection

Set the global theme before creating themed components:

```ts
import {ThemeService} from "UIKit.lspkg/Scripts/Themes/ThemeService"
import {System3} from "UIKit.lspkg/Scripts/Themes/System-3.0/System3"  // note the versioned -3.0 folder
ThemeService.getInstance().setTheme(System3)
```

`ThemeService` sits directly under `Themes/`, but `System3` sits under the
versioned `Themes/System-3.0/` folder; don't collapse it to `Themes/System3`.

For Button, select theme, shape, and style together before initialization:

```ts
button.setVariant({
  theme: "System3",
  shape: "Rectangle",
  style: "Primary"
})
```

Other visual elements use `setThemeOverride("System3")` when documented.
Theme/style inputs that choose generated visuals are init-only. Theme switching
is **not live** — `setTheme` affects only components created afterwards, so set
it once at the top of the build. `setVariant({shape, style})` without a concrete
`theme` (or while theme is still "Inherited") drops the shape/style with only a
console warning.

### Widget content

Buttons and most visual elements do not create a label automatically. Add one
`ElementContent` to the same SceneObject after the widget initializes:

```ts
const content = addContentToElement(buttonObject, {
  text: "Save",
  trailingIcon: saveIcon
})
content.trailingIconSize = 1.4
```

Factory options and live properties are not interchangeable. Icon *size* is the
most common mistake — `leadingIconSize`/`trailingIconSize` (a single cm number,
uniform, not a vec2) are **live properties set on the returned object**, never
factory options; passing them to `addContentToElement` is a compile error.
`ranking`, `padding`, `opacity`, `renderOrder`, and the color pair below are
also live-only.

Color, size, and preset traps:

- **There is no `textColor`/`color` property.** To set text color, use the pair
  `content.useTextColorOverride = true` + `content.textColorOverride = <vec4>`
  (e.g. an export from `Themes/System-3.0/Colors`); otherwise content follows
  theme state colors.
- **Default `textSize` is 48** when neither `textSize` nor `ranking` is given —
  body-sized, oversized for captions. Set it deliberately.
- **A standalone `ElementContent` left at its default `sizeOverride` renders only
  a SLIVER — often a SINGLE GLYPH** (e.g. a headline shows as just "N"). A bare
  content box is sized only by `sizeOverride`, which defaults to a small
  `vec2(10, 3)` cm box (or by its host element's size); it does not grow to fit
  its text and never re-pins, and `flexGrow`/stretch resize an *Element's*
  `size`, not the content box — so a growing item just reserves empty
  space around an unchanged sliver of text. **Give every standalone label an
  explicit `sizeOverride` (a real cm box) plus a deliberate `textSize`**, and
  re-set `sizeOverride` when the row width changes. This one-glyph clip is the
  single most common "my text is missing / clipped" bug. If you want the text to
  auto-fit, host it on an initialized Element (a `Button`/plate whose `.size` is
  set) instead of a bare content box. `sizeOverride` is live only on standalone
  content — on companion content it is stored and ignored.
- **Never put a bare `TextStylePresets` component on an ElementContent's
  SceneObject.** The content adopts a sibling preset automatically, and an
  unconfigured preset defaults to `Title1` (~109) — the label renders enormous
  for no visible reason.

Controls such as Slider whose catalog entry does not support companion content
use a separate label SceneObject. Text/voice-input components manage their own
text and refuse an ElementContent.

### Typography

Use `ElementContent.ranking` with the `Ranking` enum (imported from
`Components/TextStylePresets/TextStylePresets`) when the package type scale fits
the surface. Ranking controls rendered size and weight; do not also budget the
same label from a conflicting `textSize`. The **only** valid members are
`Title1`, `Title2`, `HeadlineXL`, `Headline1`, `Headline2`, `Subheadline`,
`Button`, `Callout`, `Body`, `Caption` — there is no `Headline`, `Title3`, or
`Caption1`; use `Ranking.Headline1` / `Ranking.Title1` (or `Title2`) /
`Ranking.Caption` accordingly.

`Ranking` presets are calibrated for far-viewing HUD distances (their point
sizes run ~37–109pt); on a small hand/near panel (tens of cm) a preset overflows
its box, and a label given only a `ranking` with no `sizeOverride` collapses to
one glyph. On compact/near panels prefer an explicit `textSize` with a matching
`sizeOverride`, rather than a Ranking preset.

**`textSize` is a font-scale number in the same family as the default `48`, NOT a
centimeter value — legible copy on a world panel needs tens, not single digits.**
The readable band on a ~30–40 cm panel is roughly **caption ~28–32, body ~40–48
(the default), title ~56–72**; drop these by ~25% for a compact ~20–25 cm panel,
but never to single/low-double digits. Setting `textSize` to a small cm-looking
number (5, 8, 12) because it "feels panel-sized" renders text far too small to
read — a recurring legibility bug. Size the `sizeOverride` box to match the larger
text so it is not clipped.

Use explicit `textSize` when a component or compact surface needs a size outside
the ranking relationship. Text-input components have their own public
`fontSize`.

### Icons and colors

UIKit's built-in controls resolve their own iconography internally from the
companion `Icons.lspkg` package. That resolution is an **internal package
detail**: the catalog paths it uses (e.g. `Icons.lspkg/Iconography/System/close.png`)
are not a stable consumer contract — categories and filenames change between
revisions and are not guessable. Do not hand-type any package icon path.

For your own content, feed a real `Texture` that already exists in the project:
import one with `/icon-selector` and reference the exact path it returns, or wire
an experience-supplied `Texture` through an `@input`. The package-specific fact to
know is that there is **no** `UIKit.lspkg/Icons/` folder (package textures
ship under `Textures/`), so an invented `<Package>.lspkg/Icons/<name>.png` path
never resolves. The general rules for loading assets safely (never `requireAsset()`
an invented path, and never at module top level), choosing an icon, and avoiding
emoji are Lens scripting / scene-authoring concerns owned by the `/icon-selector`
skill and the Lens API skill, not this package doc.

Use the exports from `Themes/System-3.0/Colors` for custom surfaces that must
match themed components. Package colors, rankings, and style names can change
with the package and therefore belong here rather than in a CLAD skill.

Keep text and its backing plate at contrasting colors. Text the same color as the
card/plate it sits on is invisible even though it renders — e.g. white
`textColorOverride` on a light `RoundedRectangle` face. A translucent backing color
is not a safe substitute: a low-alpha fill can render as a near-opaque light face on
some builds, so do not rely on the background showing through to create contrast —
choose a text color that reads against the plate's actual rendered color.

For a **textured control face** (skinning a button with captured or brand art),
prefer a child `Component.Image` over `RoundedRectangleVisual.baseTexture`:
some installed builds render the `baseTexture` path as a flat gray face. The
child Image needs its own cloned material; the material-clone and `mainPass`
mechanics are generic engine API, so follow the materials CLAD skill (or
`Component.Image` in the installed `StudioLib.d.ts`) for them.

## Lifecycle

1. set the global theme;
2. create the widget;
3. set its variant/theme override before initialization;
4. initialize when public;
5. attach ElementContent and set live content properties.

A standalone visual you create yourself — e.g. a `RoundedRectangle` background or
plate — retains `.size`, `.cornerRadius`, and `.backgroundColor` set before
`initialize()`: the setters store the values and apply them when the mesh builds,
so you can set them in either order. Like other `Visuals/` primitives it derives
from `Shape` and initializes during `OnStart`; call `.initialize()` yourself only
when you need the built mesh immediately (for example to read or clone it
synchronously the same frame).

## Limitations

- One ElementContent instance is supported per widget SceneObject.
- A component's inspector-only style is not a public code API.
- Raw Lens `Component.Text` remains available for non-UIKit needs, but it is
  engine API, not a package surface: its sizing, `Text` vs `Text3D`, fonts
  (`font` / `fontSource`), and scene behavior are owned by the Lens API skill
  and the installed `StudioLib.d.ts`, not this guide. The one package-specific
  note here: size a raw `Component.Text` box with the package's `setTextRect`
  utility.
