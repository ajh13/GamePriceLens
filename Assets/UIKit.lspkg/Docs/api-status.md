# UIKit API status

[← Agent usage index](../README.md)

## Use when

Check this file before choosing a component or copying an older UIKit example.
It is the compatibility index for the package revision that contains it.

## Status meanings

- **Current** — recommended public surface for new work.
- **Deprecated** — still present; migrate to the named replacement.
- **Experimental** — public, but compatibility is not guaranteed.
- **Removed** — unavailable in this revision.

## Current API

| Capability | Current surface |
|---|---|
| Buttons | `Button` with `setVariant({theme, shape, style})` |
| Toggle sets | `ToggleGroup` with `Button`, `RadioButton`, or `Checkbox` |
| Binary value | `Switch` |
| Continuous value | `Slider`, `ColorSlider`, `ConfirmationSlider` |
| Text entry | `TextInputField`, `TextInputArea`, `VoiceInputButton` |
| Choice and date input | `Dropdown`, `NumberPicker`, `Calendar`, `DatePicker` |
| Progress | `ProgressBar`, `Spinner` |
| Window/backing | `Frame` |
| Visibility and fades | `VisibilityGroup`; Motion-backed UIKit transitions |
| Lightweight custom surface | `RoundedRectangle` |
| Layout | Layout2D `FlexLayout`/`FlexItem` and `GridLayout`/`GridItem` |
| Simple authored groups | `ElementGroup` |
| Scrolling | `ScrollWindow`; `VirtualizedLayout` for large data sets |
| Widget content | `ElementContent` and `addContentToElement` |
| Theme | `ThemeService`, `ThemeManager`, `setThemeOverride`, `setVariant` |
| Typography | `ranking` property on `ElementContent`; import the `Ranking` enum from `TextStylePresets` (not from `ElementContent`) |
| Icons | `Icons.lspkg` iconography supplied as Texture content |

Exact modules and public members are listed in
[components.md](components.md).

## Deprecated

| Deprecated surface | Current replacement |
|---|---|
| `RectangleButton` | `Button` with `shape: "Rectangle"` |
| `CapsuleButton` | `Button` with `shape: "Capsule"` |
| `RoundButton` | `Button` with `shape: "Round"` |
| `BackPlate` | `Frame` for panels; `RoundedRectangle` for lightweight custom surfaces |
| `Frame.border` | `Frame.margin` |
| `Frame.roundedRectangle` | `Frame.cornerRadius` or the `FrameVisual` interface |
| `Frame.smoothFollow` | `setUseFollow(true)` or follow/translation/scaling/size events |
| `Frame.onlyInteractOnBorder` | `Frame.onlyInteractOnMargin` |
| DropShadow `spread` / `sizeOffset` | `blur` / `spreadRadius` |
| `SceneUtilities.findAllChildComponents` | IK `findAllComponentsInSelfOrChildren` |
| `SceneUtilities.findComponentInAncestors` | IK `findComponentInSelfOrParents` |
| FlexItem numeric `flexBasis = -1` | `"auto"` |

Do not use deprecated surfaces in new examples. Rows whose replacement is prefixed `IK` reference InteractionKit APIs, which version independently of UIKit — confirm the current name against IK's own `Docs/api-status.md`.

## Experimental

No package API is designated Experimental in this revision.

## Removed

| Removed surface | Replacement |
|---|---|
| `Components/Layout/*` legacy single-axis layout | `Components/Layout2D/` Flex or Grid |

Consult the package release notes for migrations from versions older than the
one installed. This file records only the surface available in this package
revision.
