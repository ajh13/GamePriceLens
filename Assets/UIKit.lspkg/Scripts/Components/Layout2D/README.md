# Layout2D

CSS-spec-inspired layout primitives for UIKit: Flexbox (`Flex/`)
and CSS Grid Level 1 (`Grid/`), built on a shared item-resolution layer.

## Mental model

Three layers stack on top of each other:

1. **Pure layout engines** (`Flex/Flexbox2D.ts`, `Grid/Grid2D.ts`).
   Zero Lens Studio imports. Take serialized inputs (intrinsic sizes,
   constraints, placement), return positions and allocated sizes.
2. **Per-item layout components** (`FlexItem`, `GridItem`) — extend
   `LayoutItem2D`. Attach one to each child SceneObject of a container.
   They resolve a content-type _handler_ on `OnStart`, expose Flex / Grid
   properties to the inspector, and serialize their state to the engine
   via `toInput()` / `fillInput()`.
3. **Container components** (`FlexLayout`, `GridLayout`) — thin
   orchestrators. Collect inputs from their `LayoutItem2D` children, run
   the engine, write outputs back via `LayoutItem2D.applyLayout()`.

## ItemHandler — bridging Layout2D to content

Layout2D doesn't know how to size or position any particular kind of
component on its own. That job belongs to `ItemHandler` implementations
registered in `ItemHandlerRegistry`. A handler answers two questions for
the layout pass:

- **`measure(sceneObject, component, transform)`** — what is the
  content's intrinsic size? Returns a `ContentMeasurement`
  `{min, preferred, max}` (CSS Sizing 3 model). `min` is the
  min-content size (smallest the item can shrink to without
  overflow), `preferred` is the natural size, `max` is the
  max-content size (largest the item wants to grow to, often
  `Infinity` for flexible content).
- **`apply(sceneObject, x, y, width, height, component, transform)`** —
  given an allocation, where does the size go? Handlers write to the
  appropriate native channel: Text → `layoutRect`, Image →
  `Transform.localScale`, BaseMeshVisual → AABB-derived `Transform.localScale`,
  Shape → `width/height`. Any of these write `ScreenTransform.offsets` instead
  when a ScreenTransform is present (it supersedes those channels).

Built-in priorities (higher = checked first):

```
120  CustomFlexContainer   — atomic composite widgets
110  LayoutContainer       — FlexLayout / GridLayout
100  Element               — Element-derived UIKit components
 95  StandaloneContent     — standalone ElementContent
 90  Shape                 — Shape visuals
 70  Text / Text3D
 60  Image
 50  BaseMeshVisual        — predicate-gated on finite AABB
 45  ScreenTransform
 40  BoxCollider
 38  SphereCollider
 37  Capsule/CylinderCollider
```

Register custom handlers with
`ItemHandlerRegistry.register(handler, priority)`; replace a built-in
with `ItemHandlerRegistry.unregisterByName(name)` + `register(replacement, priority)`.

## Fit-content heights — `measureHeightForWidth`

`measure()` runs before the layout knows any widths, so a wrapping Text
can only report its _authored_ rect height there. Content whose height
depends on width gets a second, optional hook:

- **`measureHeightForWidth(sceneObject, component, transform, width)`** —
  the height the content needs when laid out `width` cm wide, `null` for
  "no applicable answer" (keep the measured intrinsics, nothing to retry),
  or `FIT_CONTENT_PENDING` for "the answer exists but a rate-limited host
  call prevented measuring it this frame". The handler reports
  availability; the container owns scheduling, the retry budget, and the
  fallback. Text answers only when `horizontalOverflow` is `Wrap`
  (Overflow / Truncate render one line whatever the width; Shrink does
  depend on width but is **not supported** by this path and is declined)
  with its wrapped height: rect swapped to `width × tall`, `getBoundingBox`,
  rect and `verticalOverflow` restored on every exit; several widths cached
  per content/style key. `LayoutContainerHandler` answers by running the
  nested layout with its width pinned and height auto, so wrapped text
  several levels down still drives the outermost row, and forwards a
  child's pending state. Rigid handlers omit it.
- **`invalidateMeasurements(sceneObject, component)`** — optional; drops
  whatever the handler cached for this component. Reached through
  `LayoutItem2D.invalidateMeasure()` (below).

`LayoutItem2D.heightForWidthProvider()` exports it to the engines as
`GridItemInput.heightForWidth` / `FlexItemInput.heightForWidth`, and
returns nothing when `overrideHeight` pins the axis or the handler can't
answer. Only the preferred-size probe carries it; the min/max probes
never lay the item out at a real width. The engines call it once the
horizontal axis is known:

- **Grid** — after column track sizing, at the width Step 5 will give the
  item (spanned cell width when `justify` is `Stretch`, else its intrinsic
  width). The answer replaces `intrinsicHeight` / `contentMaxHeight`
  before rows are sized, so `auto` rows and auto-height containers grow
  with the wrapped text. Fixed `cm` rows are unaffected.
- **Flex** — iteratively. Each pass runs Steps 1–8.5 from the current
  refined heights, then re-fits every height-for-width item at the width
  it was just allocated (row: its main size; column: its cross size). A
  pass that changes no height and no aspect-transferred size is the fixed
  point: every rendered height is the height measured at the rendered
  width. Columns start from an estimate (`Stretch` in a `nowrap` column →
  the line width: inner container width when definite, else the widest
  item; otherwise the item's own width) that the first re-fit corrects.
  Aspect-ratio items carry their transferred main size into the next pass
  as their flex base, so siblings settle around it instead of re-measuring
  at the pre-transfer width forever. Without height-for-width items exactly
  one pass runs, as before.

  The loop is bounded by `FLEX_FIT_MAX_PASSES` (8) and stops early when a
  pass signature repeats (a cycle). Both end in the same deterministic
  fallback: freeze the last pass's line membership and aspect sizes, re-fit
  heights at the widths that pass produced, and run one final pass with no
  aspect transfer. With membership and aspect sizes frozen, widths no longer
  depend on heights, so the final widths equal the widths the heights were
  measured at. What yields: an aspect item may leave its ratio (hard
  min/max still hold) and a column's frozen lines may overflow the main
  axis. Priority: hard constraints, then measured text, then aspect ratio.
  The output does not flag this; it is the bounded fallback for content
  without a fixed point, not convergence. Line membership in a wrapping
  column is the first self-consistent one reached from the estimate; the
  engine does not search for a tighter packing. Within one call a callback
  is asked at most once per distinct width, so a declined or pending answer
  is not retried in the same frame.

The probe is skipped when its answer is provably discarded: a `Stretch`
item in fixed `cm` grid rows, or in a single flex line with a definite
cross size, renders at the cell/line size whatever it measures. This
keeps UIKit's own wrapped button labels from spending a `getBoundingBox`
per resize.

**Coordinated measurement (`TextMeasurement.ts`).** TextHandler and
ElementContent share native access, semantic caches, and one `getBoundingBox`
attempt per Text per frame. The allowance is claimed before touching host state.
Throwing, empty (0 × 0 for non-whitespace text), and non-finite results spend it;
cache hits do not. Invalidation, changed content/style/width, nested probes,
`forceLayout()`, and new retry generations cannot reset it.

Wrapped probes and nested content caches use the exact allocated width;
rounding across a line-break boundary can invalidate the measured height.

Requests return `ready` with a current value or `pending` with an optional
previous-key display fallback. Callers schedule retries. A fresh multi-word
wrapped Text needs three successful measurement frames: natural size, longest
word, then wrapped height. Probes restore text, overflow modes, and rect values
on every exit. Frame identity defaults to `getTime()`; its assumed per-frame
constancy remains unverified against a device trace. `setFrameTokenProvider`
replaces the source.

**ElementContent label changes.** On a content-sized control (Auto-Resize
or `TextSizing.Fit`) a replacement label is _staged_: the rendered Text
keeps the committed label until the new one's natural size is ready (the
coordinator measures it through a scoped probe on the same Text and keeps
both labels' results in its two slots), then the new text, its fitting
knowledge, the child allocation, and the parent size are committed in one
synchronous flush, so no frame shows new text in old geometry. `text` is
the requested label, `displayedText` the rendered one. A cached label
commits in the flush itself with no extra frame. Fixed-size labels and clearing
write immediately. A content-sized label's first appearance, including its
underline, stays hidden until sizing resolves; `displayedText` is empty while
it waits. Explicit rendering-off state is preserved. Owners can gate a whole
panel's reveal on `onPresentationReady`, which fires once per request generation
after sizing resolves. `presentationReady` becomes false immediately when a new
request has deferred work. Gating panel visibility on it is optional.

The commit goes through the owning layout: `LayoutItem2D.parentLayout`
exposes the owner (`LayoutOwner`), and FlexLayout / GridLayout implement
`presentSynchronously(request)` through the shared `LayoutPresentation`
transaction. It locks the owner chain and preflights the affected layout tree
using the proposed control size. This pass warms measurement caches without
applying geometry, emitting layout callbacks, or consuming layout retry budgets.
If any required measurement is pending, the old presentation stays visible and
the control's bounded retry remains armed. Once ready, it commits the label and
settles geometry from the outermost owner inward, including affected sibling
containers, before emitting presentation readiness.

If any participating owner is laying out or notifying listeners, the whole
request waits in that owner's queue. Draining re-resolves the chain and
checks the component's label revision, Text identity, immediate owner, and
prepared natural-size sample. A changed owner or stale measurement leaves
the old label displayed and the existing bounded retry active. Validation
reads the cache without making a native measurement attempt. The completion
callback fires only after the full transaction settles, so queued commits
also emit `onPresentationReady`.

Manual `textSize` changes on content-sized controls share this transaction:
the requested font size is measured with the staged label, while the rendered
font size stays unchanged until the label and owner geometry can commit together.
The `textSize` getter reports the requested value during that wait. A size change
advances the presentation revision even when the label is unchanged. Switching
to fixed-size mode applies any staged size immediately. Ranking presets still
control font size when selected; this guarantee concerns manual `textSize` edits,
not asynchronous font loading or preset changes.

One drain processes at most eight queued requests, including requests added
by completion callbacks; remaining work schedules a continuation. Destroying
an owner removes its queued requests. Transactions accept owner chains up to eight levels deep and reject cycles before changing the label. A chain
outside that bound keeps the previous presentation and eventually reports
measurement exhaustion through the component's normal retry lifecycle.
These passes do not replenish native measurement allowances or retry frames.
Every accepted label request supersedes the previous
one (immediate writes, clearing, and first appearance included); a request
staged while the control was content-sized follows a later mode change
(written immediately once neither Auto-Resize nor Fit stages).
Controls without a Text own no font work: no revalidation window opens, and
clearing or destroying the label cancels its staged, pending, and sample
state. The continuation's single bounded
budget covers unresolved sizing, staged commits, and owed font samples
(`STYLE_REVALIDATION_FRAMES` successful samples after a metric-affecting
change; `_revalidationsLeft` counts samples, not attempts). Two samples do
not cover arbitrarily late font updates; that is the accepted bound, not
polling.

**Rate limiting, retries, and the budget.** A fresh wrapped Text needs
three attempts (natural extent, longest word, wrapped height) and gets one
per frame. When the wrapped measure is refused or the frame's attempt is
already spent the handler returns `FIT_CONTENT_PENDING`; the item records
it for the rest of that pass (sticky: a later success at another width
does not hide an earlier unresolved one), and the container:

- does not memoize that pass's result (the inputs would compare equal
  next frame and the stale answer would stick),
- requests a _continuation_ — another LateUpdate for the same measurement
  generation, without advancing the generation, dropping caches, or
  notifying the parent (the parent learns through its own probe of this
  container returning pending),
- charges one retry opportunity per distinct frame. Nested probes,
  `forceLayout()`, and content-size queries inside one frame spend one.

The LateUpdate callback consumes its dispatch _before_ laying out, so a
request made during the pass (a continuation, or a listener calling
`markDirty()` from `onLayoutComplete`) survives to the next frame.

After `FIT_CONTENT_RETRY_FRAMES` (8) frames of pending work following the
first pending frame, the container gives up for that generation: it
memoizes the result it has (measured heights where available, the
intrinsic fallback where not), reports `fitContentPending = false` so
ancestors stop retrying, sets `fitContentExhausted = true` for
diagnostics, and goes idle. Exhaustion is an accepted fallback, not
convergence. The next external `markDirty()` starts a fresh generation
with a fresh budget. A cached height for a _different_ width is never
substituted, and settled layouts make no host measurements on unchanged
frames.

**Notifying the layout of host changes.** Nothing observes host state.
After mutating a Text's `text`, font, `size`, spacing, or
`horizontalOverflow` directly, call `item.invalidateMeasure()` on its
`GridItem` / `FlexItem`: it clears the item's optional intrinsic cache,
asks the handler to drop its caches for that component, and marks the
parent layout dirty. `markDirty()` on a container is an _external_
invalidation: it advances the measurement generation (dropping the
memoized engine result and the nested content-size caches), resets the
retry budget, and bubbles to the parent layout. The engine memo is reused
only across `forceLayout()` calls with no invalidation in between. Text
caches also self-invalidate when the content / font / size / spacing
fingerprint changes, so `invalidateMeasure()` is the guaranteed path, not
the only one that happens to work.

**Compatibility.** Three distinct behaviour changes:

1. _Automatic fit-content sizing._ Existing unpinned wrapping Text
   (`horizontalOverflow: Wrap`, no `overrideHeight`) inside content-sized
   Layout2D containers now takes its wrapped height instead of the
   authored rect. Fixed rows, definite `nowrap` flex cross sizes, non-Wrap
   text, and pinned items are unaffected.
2. _Wrapping-line cross size._ A `FlexLayout` with `wrap` enabled that
   produces a single line no longer widens that line to the container: per
   CSS Flexbox §9.4 step 8 only a `nowrap` container does that. The line is
   content-sized (its widest item) unless `alignContent: Stretch` expands
   it. Stretched items in such layouts get narrower; this applies to rigid
   items too, not only text. `nowrap` layouts are unchanged.
3. _Indefinite fractional tracks._ `fr` rows in an auto-height grid, and
   `fr` columns in an auto-width grid, used to resolve to 0 and now size
   from content. This includes `GridLayout`'s default `templateRows:
"1fr"`: an auto-height grid left on the default no longer has a
   collapsed first row. Any layout that relied on the collapse (a spacer
   row that vanished) moves. Grids with no wrapping Text are affected too.
   Definite-size grids are unchanged.

Consumer-authored scenes may depend on the previous behavior, so treat all
three as behavioral changes rather than no-ops.

The user's `minHeight` / `maxHeight` clamp the answer like any other
intrinsic. A `null`, non-finite, or negative answer keeps the measured
intrinsics. Transposed items (`ToolbarFlexItem` with `transposeAxes`)
opt out via `supportsHeightForWidth()`, since their layout-axis "height"
is the content's width.

Practical recipe for a content-driven panel: one auto-height column
(`GridLayout` with `templateColumns: "1fr"`, `height: -1`, `justifyItems:
Stretch`) whose children are Text items with `horizontalOverflow: Wrap`
and no `overrideHeight`. Rows may be `auto` or `fr`: in an auto-height
container an `fr` row sizes from its content (below). Put text alignment
on the Text component itself (`horizontalAlignment`), not on the grid —
the item is stretched to the column so it can wrap at that width.

## Fractional tracks in an indefinite axis

When a grid's size along an axis is auto (`width` / `height` = -1), its
`fr` tracks have no free space to divide. Grid2D follows CSS Grid §12.7.1
"Expand Flexible Tracks" for that case: a bare `fr` is `minmax(auto, fr)`,
so the track first takes its content's base size like an `auto` track,
then every flexible track grows to `usedFraction × factor` where the used
fraction is the largest of each flexible track's base ÷ factor (the base
itself for factors ≤ 1) and, for each item crossing a flexible track, the
"size of an fr" that fills the item's max-content contribution over the
tracks it crosses (gutters count as fixed; the factor sum floors at 1;
tracks whose share would drop below their base are treated as
inflexible and the fraction is re-found). So `1fr 2fr` with contributions
20 and 10 resolves to 20 and 40, a 30 cm item spanning `1fr 2fr` gives 10
and 20, and `0.5fr` never shrinks below its content. The spec's follow-up
re-run against a container min/max size is not implemented (no such
constraint exists on the container input). In a definite axis the
existing free-space division is unchanged; its missing `auto` minimum for
`fr` tracks is a separate, recorded gap.

## "Naked" LayoutItem2D — no handler

A SceneObject can host a `FlexItem` / `GridItem` even when no built-in
handler recognizes its content. There are two well-defined patterns:

### 1. Override-pinned (the canonical pattern)

Set `overrideWidth` and/or `overrideHeight` in the inspector or via
script. `measureIntrinsic()` reports those as the preferred size,
`hasOverride*` flags drop the handler's min/max, and `applyLayout`:

- writes `Transform.localPosition` for x/y,
- writes `Transform.localScale` to make the SceneObject's children
  _render at the allocated size_, treating the override as the natural
  scale-1 size. So a SceneObject authored at `overrideWidth = 10` cm
  and allocated 20 cm will render at `localScale.x = 2`.

This is the right escape hatch for prefab roots or empty containers
whose children can't be introspected by the handler registry.

### 2. No override, no handler (zero-size warning)

If neither an override nor a recognized content component is present,
the layout sees the item as `0×0`. `applyLayout` still writes
`Transform.localPosition`, but **does not touch `localScale`** —
otherwise we would clobber child meshes / text at their authored size.
A one-shot `print()` warning fires on the first apply so the misconfig
is visible:

> `WARNING: <SceneObject> has a LayoutItem2D but no recognized content
component and no overrideWidth/overrideHeight. The layout will treat
its intrinsic size as 0×0.`

To clear the warning:

- attach a recognized content component, or
- set `overrideWidth` / `overrideHeight`, or
- register a custom `ItemHandler` for the SceneObject's content.

## Scale-warp semantic

The "no-handler + override" branch above is sometimes called
_scale-warping_: the layout pass writes a non-uniform `localScale` that
warps everything under the SceneObject. This is intentional for that
exact case (you have _declared_ a natural size and want the whole
subtree to scale to match the allocation), but is the wrong default for
recognized content — that's why scale-warp only happens when the user
explicitly opted in via `overrideWidth` / `overrideHeight`.

If you find a child unexpectedly stretched, the SceneObject above it
probably has a `LayoutItem2D` with an override and no handler.
Solutions: drop the override (let the handler pick the natural size),
or insert a recognized content component (the handler's `apply` will
write the size to the right channel without warping the subtree).

## Composite widgets — `measureOverride`

`LayoutItem2D.measureOverride()` is an opt-in subclass hook returning
either a `ContentMeasurement` or `null`. Composite widgets that
aggregate their own internal layout (Tooltip, Dropdown, your own
`LabeledSlider`, …) should override it to report a meaningful
intrinsic size to _their_ parent layout without going through the
registry. User overrides and clamps (`overrideWidth`, `minWidth`,
`maxWidth`) still apply on top of the result.

See the labeled-slider example in the development project for a worked example.
