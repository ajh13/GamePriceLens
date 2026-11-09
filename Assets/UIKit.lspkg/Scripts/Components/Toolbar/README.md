# Toolbar

A themeable action bar that lays out buttons, sliders, switches, text
fields, separators, and custom items horizontally or vertically, either
standalone or docked to a `Frame`. Built on the Layout2D engines
(`../Layout2D/`) — read that README first for the Flex/Grid model this
sits on.

## Item hierarchy

A canonical item is two SceneObjects, not one:

    ToolbarItem_<id>          (anchor)               — ToolbarItem wrapper
      └─ Content              (flow member if unattached) — canonical Element + ToolbarFlexItem

- **Anchor** (`ToolbarItem_<id>`) hosts the `ToolbarItem` wrapper
  subclass (`ToolbarButton`, `ToolbarSlider`, `ToolbarToggle`,
  `ToolbarTextField`). For a **flow** item it stays at container-local
  origin — the layout writes only its Content child's position, not the
  anchor's. For an **attached** item (`attachTo`) the anchor is instead
  positioned by `ToolbarAttachedItemPositioner` so its Content lands at
  target-relative geometry (see Attachments). Either way the layout
  contract assumes the anchor keeps identity rotation/scale; that is the
  supported usage, not something the toolbar re-asserts every frame.
- **Content child** (named `Content`) hosts the canonical UIKit
  component (`Button`, or the `LongPressButton` / `VoiceInputButton` a
  button behaviour asks for; `Slider`, `Switch`, `TextInputField`) and the one
  `ToolbarFlexItem` for that item. When the item is unattached this child
  is the flow member: the container's FlexLayout / GridLayout writes
  _its_ local position, in the anchor's (container-local) frame, and it
  carries the item's z-offset (0.1 cm ahead of the background plate). An
  attached (`attachTo`) item is excluded from Flex/Grid flow entirely;
  `ToolbarAttachedItemPositioner` places its anchor and Content geometry
  relative to the target instead (see Attachments).

Keeping a flow item's anchor at origin lets the Content child's
flex-written position land directly in container space, and gives
anything measuring the item (tooltips, attachments) one well-defined
transform to read.

## Button behaviours

A Button item's `behavior` (`ToolbarButtonConfig.behavior`,
`ToolbarButtonBehavior`; the Behaviour dropdown under Button in the
inspector) picks what a press does, and which `Button` subclass the Content
child hosts:

- `tap` (default): a plain `Button`; `onTriggerUp` fires on release.
- `toggle`: the same `Button` in BaseButton's toggle mode. It latches on and
  off with the theme's toggled states. `isOn` in the config sets the start
  state, `onToggled(isOn)` reports changes, and `ToolbarButton.isOn` reads
  and writes it.
- `hold`: a `LongPressButton`. It fills while held and completes after
  `holdSeconds` (unset: the theme's 1 s); `drainSeconds` empties the fill
  after an early release (unset: 0.25 s); `repeatable` re-arms when the
  trigger ends, otherwise it stays complete until
  `longPressButton.reset()`. `onHoldComplete` is the action event, since
  `onTriggerUp` still fires on a short tap; `onHoldStart` and
  `onHoldCanceled(progress)` bracket a hold. The fill needs a gradient
  style: each theme defines one hold style (its default), and a Prism style
  has no fill (the component warns, and the hold still completes).
- `voice`: a `VoiceInputButton` in its standalone form. It listens while on
  (`ToolbarButton.isOn`, `onToggled`), reports `onListeningUpdate(text,
isFinal)` and `onListeningError`, and takes `voiceFormat`. It keeps its
  own System 3.0 look and mic icon, so `buttonType`, `theme`, `style`,
  `icon` and `text` are ignored (icon and text warn through the IK logger,
  at its Warning level). It needs the
  ASR module.

All four size, fade, dim and band alike, and none transposes in a vertical
bar. `Prefabs/ToolbarButtonBehaviors.prefab` is an authored bar with one
button per behaviour.

## Separator and Custom — the anchor-only exception

Separator and Custom items keep **no** Content child;
`ToolbarItem.contentObject` / `contentTransform` are `null`. Their anchor
_is_ the flow member, carrying the `ToolbarFlexItem` directly, and is
positioned by the priority-130 `ToolbarItemLayoutHandler` (position only
— it never scales). Both are sized from `computedSize` in the toolbar's
own apply pass. A Custom item is never scaled to its cell: it receives
the computed size through `ToolbarCustomItemConfig.onResize(size)` and
fits its own content.

## Sizing ownership

For an unattached (flow) canonical item the **Content child's
`ElementHandler`** (resolved from the Layout2D registry) owns component
sizing: it issues the single `component.size` write during the flex pass.
The toolbar does not write the canonical component's size itself. The
wrapper observes the logical `computedSize` (via `onSizeChanged`) and
keeps only type-specific post-size behavior (e.g. a Slider re-deriving its
knob size). An attached canonical item is excluded from Flex/Grid, so no
layout allocation is recorded for it; `ToolbarAttachedItemPositioner`
applies the toolbar's once-per-rebuild normalized attached size to the
component manually — swapping axes for a transposed vertical slider /
text field — instead. Reservation and rendering consume that same stored
size; `resolveAttachedItemSize` remains the fallback only when the target
is not an active flow item.

For a flow item, `ToolbarFlexItem` carries the per-item flex
configuration each pass — grow / shrink / basis, min / max, and
attachment margins — plus the two axis hooks below.

## Logical `allocatedSize` and the two axis hooks

For a flow item, `ToolbarFlexItem` inherits `allocatedSize` from
`LayoutItem2D`, and records the logical layout-axis allocation unchanged:
the primary axis is always the layout direction (horizontal → x, vertical
→ y), independent of any 90° content rotation. (An attached item is
excluded from Flex/Grid, so it records no allocation — see Sizing
ownership.) The two hooks below change how that logical allocation is
measured and applied to the canonical component — not the recorded logical
value:

- **`transposeAxes`** — a vertical Slider or TextField rotates its
  Content child 90° (`shouldTransposeToolbarAxes`). For a flow item the
  measurement and handler-apply hooks swap axes so the rotated component
  still reports and fills the logical cell; for an attached vertical
  Slider / TextField `ToolbarAttachedItemPositioner` sets the same Content
  rotation and manually swaps the resolved component size (no layout
  allocation). Button, Switch, Separator, and Custom never transpose.
- **`applyWidthOverride`** (flow only) — a vertical FILL Toggle spans the
  toolbar's content width while its cell stays a primary-axis grow member
  (`getContentApplyWidthOverride`). The override pins the applied width
  without changing the logical allocation.

## Attachments and tooltips read Content geometry

Both features measure from the canonical Content geometry, not the
anchor:

- **Tooltip** parents to the anchor and offsets from its own item's
  Content local geometry — the flow position the layout wrote when
  unattached, with `ToolbarAttachedItemPositioner` accounting for the same
  Content offset when attached — sitting on the toolbar's cross axis and
  0.1 cm ahead in z. For Separator / Custom (no Content child) the base is
  the anchor origin, which the layout placed directly.
- **Attached items** (`attachTo`) are placed by
  `ToolbarAttachedItemPositioner`. It reads the target's laid-out Content
  geometry, then writes the attached item's _anchor_ position —
  subtracting the attached item's own Content local offset first, so the
  z and any retained x / y offset are not double-counted — leaving its
  Content 0.1 cm ahead of the target's Content plane. Primary-axis
  attachments also reserve flow space beside the target
  (`computeAttachmentReservations`) so the next sibling does not pack
  over them.

## Draw order

The toolbar owns one Hierarchy-sorting `Canvas` on its own SceneObject, or
inherits a compatible authored ancestor's (a panel root with an authored
Canvas above a Frame, for instance), following the kit-wide model in the
repo-level `docs/uikit_canvas_depth_migration_plan.md`. Under it every
renderable the toolbar owns sits flat at `Toolbar.renderOrder` (default 0)
and **child order is draw order**:

    Toolbar                      (Canvas: World units, Hierarchy sorting)
      ├─ ToolbarBackground       — the plate, created first, draws behind
      └─ FlexContainerContent | ToolbarGrid → ToolbarGroup_*
           └─ ToolbarItem_<id> → Content (+0.1 cm z)  — canonical component + companions

- Items sit 0.1 cm ahead of the plate (≥ `Z_LAYER_STEP`), so a depth-tested
  item is never rejected against it and the no-Canvas fallback still degrades
  to "correct by distance".
- The canonical `Button` / `Slider` / `Switch` / `TextInputField` on each
  Content child inherits the toolbar's Canvas instead of minting its own, and
  an `ElementContent` label suppresses its +1 content bump under it.
- Custom items are developer-owned: at the flat default the toolbar writes no
  render order into the subtree (authored orders stand), and it re-resolves the
  subtree's Canvas bindings when it adopts the object.
- Every object the toolbar creates copies the toolbar's `layer`.

**Escape hatches.** `renderOrder` outranks any Canvas, so reach for these only
for content that hierarchy sorting cannot reach — content outside the
toolbar's own subtree:

| Property                        | Scope                                          | Use when                                                                  |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `Toolbar.renderOrder`           | plate + every item without an explicit order   | the whole bar must cover content outside its subtree (an overlapping bar) |
| `ToolbarItemConfig.renderOrder` | one item, verbatim (custom content: see below) | an attached item hangs past the bar over a Frame's content                |
| `Toolbar.backgroundRenderOrder` | deprecated alias of `renderOrder`              | existing callers only; it bands the whole toolbar, not the plate alone    |

A non-zero band is written into a custom item's subtree, and written back as
`0` when the band is reset — authored orders inside custom content are only
preserved while the toolbar stays at the flat default.

**Known limitation: the toolbar stamps raw components, not kit components.** When
the toolbar does write orders into a custom subtree — because `config.renderOrder`
is set (any value, including `0`), or because `Toolbar.renderOrder` changed — it
writes `renderOrder` onto every `RenderMeshVisual`, `Component.Text` and
`Component.Image` it finds. It does **not** go through the setter of a UIKit
component nested inside the subtree, so that component's own stored order
(`VisualElement.renderOrder`, `ElementContent.renderOrder`) keeps its old value
while the renderables underneath move. Three consequences:

- A renderable an `ElementContent` creates afterwards — setting a label's `text`,
  adding an icon — takes the stored order, so it does not match the order its
  siblings were given.
- `invalidateCanvasBinding()` re-pushes the stored order over the whole content,
  reverting the renderables the toolbar wrote. Note the paragraph below asks you
  to trigger exactly that after a reparent.
- Toggling `hasShadow` on a nested element writes its shadow at
  `storedOrder − 1`, which can sink it behind the toolbar plate. This one does not
  depend on the `ElementContent` conditions below.

The first two only bite when the nested `ElementContent` has no discoverable
sibling visual, or when its order was set explicitly by its owner (a nested
`Dropdown`, `Calendar` or `DatePicker` does this). A plain nested Button with a
label reads its own written visual live and stays consistent. If you nest a UIKit
component inside a custom item whose order the toolbar writes, set that
component's `renderOrder` yourself rather than relying on the walk to reach it.

After reparenting a toolbar through raw Lens APIs, call
`invalidateCanvasBindingsIn(toolbar.sceneObject)` (from `Utility/CanvasController`)
or cycle the object's `enabled` flag, so the toolbar re-resolves its Canvas
before its items do.

## Supported access

Reach items through the toolbar, and the underlying component through its
typed wrapper — never by walking the anchor's children.

| From               | Use                                                                                                                                                                                            | Returns                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Toolbar`          | `getItem(id)` / `getToolbarItem(input)`                                                                                                                                                        | `ToolbarItem \| undefined`                                                                                                         |
| `Toolbar`          | `allItems`                                                                                                                                                                                     | `ToolbarItem[]`                                                                                                                    |
| `Toolbar`          | `addItem(config)` / `removeItem(id)` / `hasItem(id)`                                                                                                                                           | item / `boolean`                                                                                                                   |
| `ToolbarButton`    | `buttonComponent` / `elementContent` / `behavior` / `isOn` / `longPressButton` / `voiceInputButton`                                                                                            | `Button` / `ElementContent \| null` / `ToolbarButtonBehavior` / `boolean` / `LongPressButton \| null` / `VoiceInputButton \| null` |
| `ToolbarSlider`    | `sliderComponent` / `value` / `min` / `max` / `step`                                                                                                                                           | `Slider` / `number` / `number` / `number` / `number \| undefined`                                                                  |
| `ToolbarToggle`    | `switchComponent` (or `sliderComponent`) / `isOn`                                                                                                                                              | `Switch` / `boolean`                                                                                                               |
| `ToolbarTextField` | `textFieldComponent` / `text`                                                                                                                                                                  | `TextInputField` / `string`                                                                                                        |
| any item           | `id`, `config`, `tooltip`, `computedSize`, `size`, `transform`, `inactive`, `getToolbarDirection()`, events (`onTriggerUp` / `onTriggerDown`, `onHoverEnter` / `onHoverExit`, `onSizeChanged`) | —                                                                                                                                  |

`ToolbarItem.contentObject` / `contentTransform` are factory-managed
geometry-read handles (`setContentObject` is called by the toolbar
factory, not by consumers), not supported mutation points. To change an
item's visual or behavior, use the typed wrapper accessor above; to fit a
Custom item's content to its cell, implement
`ToolbarCustomItemConfig.onResize`.
