# UIKit layout and scrolling

[← Agent usage index](../README.md)

## Use when

Read this when composing multiple UIKit children, sizing a Frame from content,
or adding scrollable/virtualized regions.

## Current API

`FlexLayout`/`GridLayout` implement CSS Flexbox and CSS Grid Level 1 in
centimeters: web layout knowledge transfers directly — reason in flex/grid
terms, then translate to the APIs below. Flex/Grid position their content block
**centered** on the container origin by default (`horizontalAlignment`/
`verticalAlignment` default to Center); set `Left`/`Top` when aligning to a
top-left-origin viewport such as a ScrollWindow.

Direction and alignment are **enums, not strings**. Import `FlexDirection` from
`Components/Layout2D/Flex/FlexTypes` and `ContentHorizontalAlignment`/
`ContentVerticalAlignment` from `Components/Layout2D/LayoutTypes`, and assign the
enum member — `flex.direction = FlexDirection.Column`, never the string
`"Column"`. (The enum's value is lowercase `"column"`, so a capitalized string
fails the type check *and* would not match at runtime.)

`horizontalAlignment`/`verticalAlignment` position the whole content block
relative to the origin and accept **only** `ContentHorizontalAlignment`
(`Left`/`Center`/`Right`) and `ContentVerticalAlignment` (`Top`/`Center`/`Bottom`)
— they have no space-between or distribution value. To *distribute* children
along the axis use `justifyContent` (main axis) and `alignItems` (cross axis),
whose values are `FlexJustify`/`FlexAlign` imported from
`Components/Layout2D/Flex/FlexTypes`; `FlexJustify` is
`Start`/`Center`/`End`/`SpaceBetween`/`SpaceAround`/`SpaceEvenly`. A
title-left/close-right header row is `row.justifyContent =
FlexJustify.SpaceBetween`, never `row.horizontalAlignment =
ContentHorizontalAlignment.SpaceBetween`. A per-item `alignSelf` likewise takes
`FlexAlignSelf`, never a `Content*Alignment` member.

**Cross-axis *sizing* is separate from alignment — an unstretched fill child
renders at zero extent (invisible).** `alignItems`/`horizontalAlignment` only
*position* children on the cross axis; they do not stretch them. A background or
plate meant to fill the row (e.g. a header or input-bar `RoundedRectangle`) needs
`layout.alignItems = FlexAlign.Stretch`, or it collapses to zero width — its
`worldScale.x` reads `0` and it never draws, even though it is in the scene tree
and its own `size` is set. Conversely, content-sized items that must NOT fill
(chat bubbles, chips) keep an explicit width and must not be stretched (stretching
them blows the width up instead). Row layouts are the same with axes swapped: an
unstretched fill child collapses to zero height (`worldScale.y = 0`). Symptom to
check when a child is in the tree but invisible: read its `worldScale` — a `0` on
the cross axis is a collapsed child.

### FlexLayout

Use `FlexLayout` for one-dimensional rows and columns. Every managed child
needs a `FlexItem`.

Configure the layout's direction, wrap, alignment, gap, and size. Configure
each item's overrides, grow/shrink, alignment, and order rather than writing
child positions. Call `refreshChildren()` after changing the child set — a
FlexLayout auto-discovers its `FlexItem` children once at start, so items whose
SceneObjects were created a frame later (e.g. data-driven cards spawned in a
deferred `UpdateEvent`) are not laid out until you rescan. A container
`width`/`height` of `-1` means auto (shrink to content); on an item,
`overrideWidth = 0` **pins** that axis to zero — call `clearOverrideWidth()` to
unset it rather than assigning another number.

**To reclaim a hidden item's space, remove it from the layout — do not just
disable its SceneObject.** A `FlexItem` that is still registered keeps reserving
its track even when its SceneObject is disabled, so a column of mostly-hidden
rows (e.g. a filtered list that disables the non-matching cards) still stretches
to full height and pushes following content — a footer button, a CTA — off the
visible panel. Call `removeItems([...])` (and `addItems([...])` to bring them
back), then `forceLayout()`, so the container hugs only its visible items.

Size a top-level FlexLayout on the **layout itself** (`layout.width` /
`layout.height`), not via a `FlexItem` `overrideWidth`/`Height`: `FlexItem`
overrides are read by a *parent* layout, so on a container whose parent has no
FlexLayout they are inert and the container auto-shrinks to content and collapses
(its rows then stack/clip). Only nested children (which do have a parent layout)
are sized through their `FlexItem`.

### GridLayout

Use `GridLayout` for two-dimensional placement. Every managed child needs a
`GridItem`.

Use definite centimeter tracks when a nested grid is measured on an indefinite
axis. Clear `templateRows` when `autoRows` should size every row; its default
explicit row otherwise remains in the grid.

### Custom content in Flex/Grid

Layout2D resolves how each child is measured through `ItemHandlerRegistry`
(`Components/Layout2D/ItemHandlerRegistry`), a **public extension point**:
`register(handler, priority)` / `unregister` / `unregisterByName` /
`listHandlerNames` are public, and the highest priority that matches a
SceneObject wins. Built-in order (highest→lowest): CustomContainer `120` >
LayoutContainer (nested layout) `110` > Element `100` > standalone
ElementContent `95` > Shape `90` > Text `70` > Image `60` > mesh visual `50`.
Register a handler above the built-in that would otherwise claim your object to
make a custom visual participate in Flex/Grid measurement instead of
hand-positioning it.

### ElementGroup

ElementGroup is an authored single-axis group with shared background behavior.
Its direction, size, spacing, padding, background, and ScrollWindow binding are
inspector options in this revision. Code-first screens that require those
choices should use FlexLayout.

### Frame

Frame is the current panel/window surface. For code-sized content:

- set `autoScaleContent = false`;
- wait for layout completion before assigning measured `innerSize`;
- set `allowScaling = false` unless `onSizeChanged` also reflows content.

Use `RoundedRectangle` when only a lightweight custom background is needed.
Do not use deprecated BackPlate.

The Frame's content area is its `innerSize` (the size you set and read); a
grabbable `margin` (default ~2.5 cm) surrounds that content and contributes to
the frame's total size, and `padding` adds fixed-size space that survives frame
scaling. The Frame does **not** reserve or mask a band at the top of its content,
so do not offset the content root down or reserve a top pad to "clear chrome" —
that only pushes otherwise valid content past the panel's bottom edge. Size your
content to `innerSize` and let `margin`/`padding` define the surround. A
self-managed `RoundedRectangle` plate remains an option when you want to own the
whole surface, but it is not required to avoid a nonexistent top band.

### Positioning, layering, and render setup

- **Elements are centered on their SceneObject origin.** A 20 cm-wide panel
  spans x ∈ [−10, +10] around its object; compute child positions from center,
  not a top-left corner.
- **Arrange siblings only through Flex/Grid** (see the mental model above).
  Reserve manual `localPosition` for *floating* content — an overlay above a
  panel, a badge pinned to a corner — and for the small depth offsets below.
  Hand-placed sibling stacks overlap and overflow because the author cannot see
  the render. **Do NOT position a whole panel by computing each element's
  `localPosition` from panel half-width/half-height** (`vec3(-halfW+4, halfH-4, …)`
  for the header, `vec3(halfW-4, 0, …)` for the close button, a per-item X/Y for
  every row): that hand-layout overlaps and clips, can't be edited in the
  Hierarchy, and is an antipattern. Build a Flex column/row, give each child a
  `FlexItem`, and let the engine place them; use `alignSelf`
  (`FlexAlignSelf.Start`/`End`) to push a chat bubble left/right rather than an X
  offset. Setting X or Y on more than a couple of floating elements is flagged by
  the generated-source lint that rejects absolute (X/Y) positioning.
- **Layer with hierarchy order plus small depth offsets, not `renderOrder`
  wars.** Later siblings render on top. Content that sits on a surface needs a
  small toward-camera offset (**+Z local**, ~0.05–0.1 cm) or it z-fights /
  depth-rejects. Set that offset as a single absolute local `+Z` on the node
  that begins the stacked layer; `FlexLayout`/`GridLayout` write only the x and y
  of a managed item and never touch its Z, so the offset survives the layout
  pass (see the depth-offset section below). Avoid
  hand-setting `renderOrder` broadly: the package bumps internal orders
  (knob/content), so global edits cause whack-a-mole. Anything that expands over
  other content (a Dropdown drawer, a popup) must be separated by a +Z float —
  depth wins regardless of draw order.
- **A Frame's content is coplanar with its body — lift the content root, not
  just individual elements.** Everything you parent under `frame.content`
  renders on the same plane as the panel body, so a whole panel of
  buttons/plates/text z-fights the body **even with a Canvas present** (the
  Canvas orders *siblings*; it does not separate content from the body). Give the
  single content root you create under `frame.content` one small toward-camera
  offset — `contentRoot.getTransform().setLocalPosition(new vec3(0, 0, 0.3))` —
  instead of nudging every child. `frame.content` is a plain parent (not a
  layout item), so this offset is safe and is not overwritten. Round/extruded
  controls whose `size.z` gives them thickness may need a slightly larger offset
  so their back face clears the body.
- **Give every screen root a Canvas.** Put a Canvas on the Frame's SceneObject
  (the package's `Utility/CanvasController` — `new CanvasController(root).ensure(panelSize)`).
  Its World-units + hierarchy-sorting defaults make sibling render order follow
  hierarchy deterministically; without it, coplanar translucent surfaces (row
  cards, labels, badges) z-fight and flicker with no error.
- **The visible symptom of this z-fight is a dithered CHECKERBOARD / speckle
  over stacked panels, rows, and button faces**, not an obvious flicker. The device
  renders translucent materials with screen-door (stipple) transparency, so two
  or more coplanar semi-transparent surfaces (a plate + a row background + a
  button face + its label, all left at local Z=0) compound into a static
  checkerboard mess with text half-punched-through. If a hand-built panel renders
  as speckled noise instead of clean surfaces, it is coplanar z-fight, not a
  texture or material bug. The durable fix is the Canvas above **plus** a small
  deliberate depth offset between surfaces that would otherwise share a plane.
- **When a depth offset is needed, and when it is not.** You need one wherever you
  stack more than one visual surface on the same plane: content sitting on the
  Frame body (the `frame.content` offset above), or a hand-built tree of custom
  visuals where nested plates/rows/labels land coplanar. You do NOT need one for a
  single surface, and you do NOT need to protect it from the layout. `FlexLayout`
  and `GridLayout` are 2D-only: they write only the x and y of a managed child's
  `localPosition` (via the shared `setLocalXY` read-modify-writeback in
  `Components/Layout2D/ItemHandlerRegistry`) and never touch Z, so a `+Z` you
  author survives a layout pass unchanged. Set the offset once, as an absolute
  local Z, on the node that begins a new coplanar layer, when you build it:

  ```ts
  // Lift a stacked layer toward the viewer (~0.05-0.3 cm; +Z is toward the
  // camera). Absolute set, not accumulate, so it is idempotent and survives
  // Flex/Grid layout (which rewrite only x/y).
  const t = layerRoot.getTransform()
  const p = t.getLocalPosition()
  t.setLocalPosition(new vec3(p.x, p.y, 0.2))
  ```

  Do NOT walk the subtree adding `+Z` per nesting level on every build: that is
  non-idempotent (a second run, e.g. after dynamic row population, shifts
  everything again) and it is unnecessary, since the layout does not stomp the Z
  you set. Caveat: pushing a node forward with a `+Z` on `localPosition` only
  works when that node is positioned by its Transform. A child that has a
  `ScreenTransform` is placed by its screen-space `offsets`, not `localPosition`,
  so a `+Z` won't move it; separate those layers by render order (Canvas /
  hierarchy) instead.
- **Do depth separation by construction, not after "seeing" the checkerboard.**
  This z-fight is invisible to the type-check, the render gate (which counts
  objects, not dither), and the source-lint gate, and it is equally invisible in
  any headless / no-preview session, exactly where you cannot screenshot to catch
  it. So a "capture the frame and look" check is not a safety net. Any panel that
  stacks more than one surface on a plane should get its deliberate `+Z` as it is
  built, alongside a Canvas on the screen root for sibling ordering. The most
  robust choice is to avoid stacking many translucent plates at all: give the
  panel one backing and let rows be text/opaque. But if layers do stack, separate
  them in Z.
- **Create UI child objects on the parent's render layer.** New SceneObjects
  default to a layer that may not match the UI camera — a mismatch renders the
  subtree invisible with no error. Use
  `Utility/SceneUtilities` → `createChildSceneObjectWithParentLayer(name, parent)`
  for children of existing UI rather than raw `createSceneObject`. `parent` is a
  **SceneObject** — to nest under a Frame, pass `frame.content`, not
  `frame.contentTransform` (that accessor is a Transform and will not type-check).
- **Keep UIKit host transforms at identity scale.** Controls compute geometry in
  host-local centimeters and map interactor points through the host's inverted
  world transform, so a non-1 parent/host scale silently breaks Slider fill/knob
  positioning and Dropdown drawer layout even though the chrome still renders. To
  resize, scale the authored `size`/position **constants** together and leave the
  host at scale 1 — do not shrink a panel by scaling its transform.

### ScrollWindow

Create scrolling content in this order:

1. create `ScrollWindow`;
2. set init-only `contentOrigin` plus viewport options;
3. call `initialize()`;
4. attach content only with `addObject`;
5. set `scrollDimensions` from the content extent.

See the compiling [ScrollWindow example](examples.md#scrollwindow).

**A `contentOrigin: "TopLeft"` ScrollWindow puts the content's origin at the
viewport's top-left CORNER (world x = −width/2), so a Flex column added to it
MUST set `horizontalAlignment = Left` and `verticalAlignment = Top` — otherwise
Flex centers the column's content block *on* that corner and every row's left
half spills off-panel and is clipped.** Symptom: the list renders shoved to one
side with each headline/row cut off on the left (e.g. text starting mid-word),
even though the panel backing is centered. This is one of the most common feed/
list-panel bugs. The column's `width` should equal the ScrollWindow `windowSize.x`
so, once Left-aligned, it fills the viewport and its stretched rows center in the
panel. (Same rule, axes swapped, for a horizontal strip.) This is the X-axis
counterpart of the Center-default rule at the top of this doc — a TopLeft
ScrollWindow is the canonical case where the default is wrong.

When ScrollWindow participates in Flex/Grid, make a plain wrapper the layout
item and put ScrollWindow on its child. ScrollWindow creates a ScreenTransform
that otherwise competes with layout positioning.

Changing content after initialization requires both a fresh layout measurement
and a `scrollDimensions` update. That update also refreshes ScrollWindow's
managed collider set. **Appending items one at a time (a chat transcript, a
growing feed) needs this on every append, not just once.** Each new row must be
a `FlexItem` in the column and the column must be re-measured
(`refreshChildren()`/`forceLayout()`) after adding it; skip that and every new
row lays out at the column origin, so all messages/rows pile on top of one
another at the same spot and read as one smear of overlapping text. Add the row,
refresh the column layout, then update `scrollDimensions` (and scroll to the
end).

ScrollWindow's `onScrollPositionUpdated`, `onSnapIndexChanged`, and
`onScrollDimensionsUpdated` hand back a **reused scratch `vec2`** — read or copy
its `x`/`y` inside the callback; a reference kept past the callback reads
whatever the next event wrote.

`edgeFade` is **off by default** and is meant for dark content: it paints a fade
toward `edgeFadeColor` (defaults to `vec3(32/255, 32/255, 32/255)`, a near-black
gray) with a depth-biased mesh band — rendered coplanar via a polygon-offset
depth bias plus a render-order headroom so it sits above the rows and is
depth-tested against UI outside the window. It does **not** allocate an
additional mask: the ScrollWindow's own `windowSize` mask still does the
clipping. If you enable it over light content, match `edgeFadeColor` to your
backing panel color; otherwise leave it off, since stencil clipping to the
window already works without it. See [troubleshooting.md](troubleshooting.md).

Use `VirtualizedLayout<T>` rather than creating every row when the data set is
large. Subscribe row interactions in `onCreateView`; update a mutable holder in
`onBindView` so recycled rows do not accumulate handlers.

## Lifecycle

Layout2D batches computation. Read sizes from `onLayoutComplete` or after a
documented force/refresh operation, not immediately after creating children.
Nested containers should receive size through their wrapper item's constraints;
parent layout write-back can overwrite direct size writes.

## Minimal example

For a fixed panel:

1. create the Frame and set `autoScaleContent = false`;
2. create a Flex column under it;
3. give every child a FlexItem;
4. after layout completion, apply the measured content size plus padding to
   `frame.innerSize`.

This is a package lifecycle sequence. Spatial placement, target sizing, and
viewing distance come from the calling UI skill.

## Limitations

- Layout-managed children must have the matching item component.
- Flex/Grid updates are not synchronous.
- ScrollWindow and VirtualizedLayout need wrapper objects inside parent
  layouts.
- Masking is finite — Lens Studio caps the number of concurrently enabled masks
  (an engine limit, not a package constant). Each ScrollWindow consumes one and
  each Dropdown contains a ScrollWindow, so avoid nesting scroll regions or
  spawning many dropdowns at once; consolidate when clipping artifacts appear.
  A ScrollWindow whose content stays inside its window doesn't need its mask.
  The GPU saving comes from never enabling it (a camera can keep a mask's cost
  after the mask is disabled), so set `maskingEnabled = false` before
  `initialize()` when content won't cross the window's edge, and turn it on
  only while content can cross it.
