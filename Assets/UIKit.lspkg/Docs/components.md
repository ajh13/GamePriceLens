# UIKit components

[← Agent usage index](../README.md)

## Use when

Use this as the public import and event index after selecting a capability in
[api-status.md](api-status.md).

All imports use the prefix `UIKit.lspkg/Scripts/`.

Members listed below are the surface each component adds or overrides. Shared
members such as `onInitialized` are inherited from the `Element` base
(`Scripts/Components/Element.ts`); see [lifecycle.md](lifecycle.md).

## Current API

### Buttons and toggles

| Component | Module after prefix | Initialization | Primary public events / state |
|---|---|---|---|
| `Button` | `Components/Button/Button` | explicit | `onTriggerUp`, `setIsToggleable`, `isOn`, `toggle(on)`, `onValueChange`, `onFinished` |
| `RadioButton` | `Components/Button/RadioButton` | explicit | `isOn`, `toggle`, `onValueChange`, `onFinished` |
| `Checkbox` | `Components/Button/Checkbox` | explicit | same toggle API as RadioButton |
| `ToggleGroup` | `Components/Toggle/ToggleGroup` | group-managed | `registerToggleable`, `onToggleSelected`, `allowAllTogglesOff` |
| `Switch` | `Components/Switch/Switch` | explicit | `isOn`, `toggle`, `onValueChange` |

For exclusive sets, register members with `ToggleGroup`; do not enforce
exclusivity in independent handlers. Programmatic toggle writes emit events.
Drive a group's selection with each member's `toggle(on: boolean)` — pass the
desired state (`btn.toggle(isSelected)`); it takes a **required** boolean, so
`toggle()` with no argument is a type error, and do not assign `isOn`. Group
membership is fixed when the members are created (register them at build time). `setIsToggleable(bool)` is a **setter method** (declared on
`BaseButton`), not an `isToggleable` property — call it, do not assign to it.

Set a Button's corner radius with `button.cornerRadius` (cm, before or after
`initialize()`; `resetCornerRadius()` restores the default), not on
`button.visual`: the next `size` write resets a radius written to the visual.
Capsule and Round shapes always derive their radius from size.

### Value controls

| Component | Module after prefix | Initialization | Primary public API |
|---|---|---|---|
| `Slider` | `Components/Slider/Slider` | explicit | `currentValue`, `updateCurrentValue`, `resetToValue`, `onKnobMoved`, `onValueChange`, `isDragging`, `segmented`, `numberOfSegments` |
| `ColorSlider` | `Components/Slider/ColorSlider` | explicit | `mode`, `selectedColor`, `onColorChange` |
| `ConfirmationSlider` | `Components/Slider/ConfirmationSlider` | explicit | `confirmationThreshold`, `onConfirmation`, `reset` |
| `ProgressBar` | `Components/ProgressBar/ProgressBar` | self | `currentValue`, `updateValue`, `onValueChanged`, `onProgressFinished` |
| `Spinner` | `Components/Loaders/Spinner/Spinner` | self | `startSpinning`, `progress`, `complete`, `opacity`, `onCompleted`, `onInitialized` |

Slider values are normalized `0..1`. `onKnobMoved` is continuous;
`onValueChange` is the committed value. Use `resetToValue` when synchronizing
from application state without re-entering the value handler. `resetToValue`
still fires `onKnobMoved`, so a handler that writes live drag values back to
application state writes only while `isDragging` and skips the sync. Write
from `onValueChange` too: taps, Switch toggles and release commits arrive
there, not as a drag. The Slider element
*is* the track, and System3 hides the separate knob — a slider taller than
~1.6 cm renders as a slab. Keep the visual slim while leaving the hit target
comfortable (`colliderFitElement = false` to keep a fat collider under a thin
track).

`setVariant({theme, shape, style})` is a `Button` API — `Slider` (and the other
non-button controls) do **not** have it. A Slider follows the global
`ThemeService` (System3 by default); to pin one instance to a theme call
`setThemeOverride` before `initialize()`. Do not pass `shape`/`style` to a
Slider.

### Text and voice input

| Component | Module after prefix | Initialization | Primary public API |
|---|---|---|---|
| `TextInputField` | `Components/TextInputField/TextInputField` | self | `text`, `placeholderText`, `fontSize`, `inputType`, `onTextChanged`, `onReturnKeyPressed`, `onEditMode` |
| `TextInputArea` | `Components/TextInputArea/TextInputArea` | self | field API plus `overflowMode`, `maxHeight`; Return inserts a newline |
| `VoiceInputButton` | `Components/Button/VoiceInputButton` | explicit | `onListeningUpdate`, `onListeningError`, `toggle` |
| `TextManipulationModule` | `Components/TextInput/TextManipulation/TextManipulationModule` | constructed helper | selection, caret, copy/cut/paste for a Text component |

Create text-input components on enabled SceneObjects. Use `onInitialized` when
work depends on generated input internals. Set `fontSize` explicitly when the
default height-derived size is not desired. The field manages the on-screen
keyboard itself — it opens on focus and closes on blur, so do not open or close
the keyboard manually. Commit events are `onReturnKeyPressed` (field) — there is
no `onSubmit`.

### Choice, date, and collection controls

| Component | Module after prefix | Initialization | Primary public API |
|---|---|---|---|
| `Dropdown`, `DropdownOption` | `Components/Dropdown/Dropdown` | self | `setData`, `onItemTapped`, `selectionMode`, `getSelectedIndices`, `expand`, `collapse`, `onCollapsed`, `drawerObjects`, `topButton` |
| `NumberPicker` | `Components/NumberPicker/NumberPicker` | explicit | `setFieldData`, `getSelectedValues`, `setSelectedValues`, `onSelectedValuesChange` |
| `Calendar` | `Components/Calendar/Calendar` | self | `selectionMode`, `setSelectedRange`, `clearSelection`, `onSelectionChanged` |
| `DatePicker` | `Components/Calendar/DatePicker` | self | `mode`, `width`, `fieldHeight`, `calendarMaxHeight`, `setSelectedRange`, `onSelectionChanged` |
| `VirtualizedLayout<T>` | `Components/VirtualizedLayout/VirtualizedLayout` | layout-managed | `adapter`, `applySnapshot`, `onEndReached`, viewport/item sizing |

Dropdown config that controls generated rows is init-only. Set
`startExpanded = false` unless an initially open drawer is intentional. Handle
pool-mode selection with `onItemTapped` and `getSelectedIndices`. A Dropdown
whose item set is empty silently refuses to expand (the drawer no-ops when item
count is 0, with no log) — pass a non-empty list to `setData` before wiring
`onItemTapped`.

### Containers and layout

| Surface | Module after prefix | Primary public API |
|---|---|---|
| `Frame` | `Components/Frame/Frame` | `innerSize`, `autoScaleContent`, `allowScaling`, `cutOutCenter` (transparent/border-only center), depth clamping/scaling properties, `onInitialized`, `onSizeChanged` |
| `RoundedRectangle` | `Visuals/RoundedRectangle/RoundedRectangle` | `size` is a **`vec2`** (it extends `Shape`, not the vec3 `.size` of components/visuals), `cornerRadius` (not `roundness`); it has **no** `color` property — tint via its material |
| `FlexLayout`, `FlexItem` | `Components/Layout2D/Flex/FlexLayout`, `.../FlexItem` | direction, wrap, alignment, gap, item sizing/order |
| `GridLayout`, `GridItem` | `Components/Layout2D/Grid/GridLayout`, `.../GridItem` | tracks, flow, alignment, placement |
| `ElementGroup` | `Components/ElementGroup/ElementGroup` | authored group plus `addItem`, `removeItemAt`, size/item events |
| `ScrollWindow` | `Components/ScrollWindow/ScrollWindow` | `contentOrigin`, `windowSize`, `scrollDimensions`, axes, `scrollPosition`/`scrollPositionNormalized`/`tweenTo(pos, time)` (not `scrollToPosition`), `addObject`, scroll events |
| `ScrollBar` | `ScrollBar` (package **root**, not under `Components/`) | `setScrollWindow`, `setOrientation`, `setThemeOverride` (before it starts), `size`, `inactive`, `onScrolled`; creates its own Slider internally |
| `Toolbar` | `Components/Toolbar/Toolbar` | `addItem`, direction, wrapped control access |

Read [layout.md](layout.md) before nesting layouts or scrolling content.
To build a `ScrollBar` from code, create it and call `setScrollWindow(window)`
before it starts, plus `setOrientation` and `setThemeOverride` if needed. One
that starts without a window builds once it gets one. The setters do nothing
once the bar has built. A bar always draws along its object's X axis, whatever
its orientation, so rotate a vertical bar's object 90 degrees about Z. See
[troubleshooting.md](troubleshooting.md).

There is no dialog/modal component — compose one: a full-screen scrim
(`RoundedRectangle`) plus a Frame, floated above the page with a +Z offset
(see layout.md § Positioning, layering, and render setup). A scrim has no
collider, so block the content behind it by sweeping those elements to
`inactive`; a Dropdown has no `inactive` state, so `collapse()` and disable its
SceneObject instead. Do not sweep the dialog's own controls to `inactive`.

### Content and theme

| Surface | Module after prefix | Primary public API |
|---|---|---|
| `addContentToElement` | `Components/Content/ElementContentFactory` | creates widget text/icon content |
| `ElementContent` | `Components/Content/ElementContent` | text, icons, alignment, `ranking`, color overrides |
| `Ranking` (enum) | `Components/TextStylePresets/TextStylePresets` | import the `Ranking` enum from **here** — it is not exported by `ElementContent` — then assign it to `ElementContent.ranking` |
| `ThemeService` | `Themes/ThemeService` | global runtime theme |
| `System3` | `Themes/System-3.0/System3` | current theme object |
| Theme colors | `Themes/System-3.0/Colors` | package-aligned palette |
| `VisibilityGroup` | `Utility/VisibilityGroup` | subtree opacity/visibility, exclusions, `refresh` |
| Motion tokens | `Motion/MotionTokens` | package transition constants backed by `Motion.lspkg` |
| Motion intents | `Motion/SpecIntents` | package transition composition backed by `Motion.lspkg` |

Set the global theme before creating themed components. Pass a concrete theme
when using `Button.setVariant`.

Frame depth behavior uses `useDepthClamping`, `minimumDepth`, `maximumDepth`,
and `useDepthScaling`. Depth scaling endpoint properties are documented by the
installed declarations; do not infer values from an older guide.

## Lifecycle

Follow [lifecycle.md](lifecycle.md). If a component is not listed here, inspect
the package's public declarations before use and update this index when making
that API part of the supported agent surface.

## Limitations

- Do not import deprecated subclasses.
- Do not write protected or underscore-prefixed inspector storage.
- Component defaults and event semantics are version-specific; this file is
  authoritative only for the package revision that ships it.
