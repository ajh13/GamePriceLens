# UIKit lifecycle

[← Agent usage index](../README.md)

## Use when

Read this before creating UIKit components from code or changing their
configuration after startup.

## Current API

UIKit components use one of three lifecycle contracts:

| Contract | Components | Required order |
|---|---|---|
| Explicit initialization | `Button`, `RadioButton`, `Checkbox`, `Switch`, `Slider`, `ScrollWindow`, `NumberPicker`, `Toolbar` | create → set init-only properties → `initialize()` → attach content/events |
| Self-initializing with replay event | `Frame`, `ProgressBar`, `Calendar`, `DatePicker`, text inputs | create → set public configuration → subscribe to `onInitialized` when later work needs generated internals |
| Layout-batched | Flex, Grid, ElementGroup, VirtualizedLayout | configure children → wait for layout completion or call the documented refresh/force method |

Do not call a private `initialize()` method. The component table in
[components.md](components.md) identifies the contract for each surface.

### Shared members come from the base classes

Lifecycle and shared event members such as `onInitialized` and `onTriggerUp`
are declared once on the `Element` base (`Scripts/Components/Element.ts`, from
which every component derives via `VisualElement`) and are inherited rather than
redeclared on each leaf component. When verifying one of these symbols in the
installed source, check `Components/Element.ts` and `Components/VisualElement.ts`,
not only the leaf file. For example, `TextInputField` exposes `onInitialized`
and `Button` exposes `onTriggerUp` through `Element` — those symbols do not
appear in `TextInputField.ts` or `Button.ts` themselves.

### Frame generated internals are unsafe before `onInitialized`

Frame is self-initializing, but its accessors that return **generated
internals** — `content`, `contentTransform`, `closeButton`, `followButton`,
`interactionPlane`, `roundedRectangle`, and `billboardComponent` — resolve
component-owned refs that are seeded null until the Frame initializes. Read
them, or parent children under `frame.content`, only inside
`frame.onInitialized.add(…)`. Setters that touch the generated visual — including
`cutOutCenter` — also deref those refs, so drive them from the Inspector or
after `onInitialized`, not immediately after `createComponent`.

**Parent content under `frame.content`, not `frame.contentTransform`.**
`frame.content` is the content **SceneObject** — pass it as the `parent` to
`createChildSceneObjectWithParentLayer(name, parent)`. `frame.contentTransform`
is that node's **Transform** (for reading/setting local position and scale
only); passing it where a `SceneObject` is expected is a type error.

## Lifecycle

### Configure before initialization

Set properties that choose generated structure before initialization:

- button theme, shape, and style;
- ScrollWindow `contentOrigin`;
- Dropdown pool, selection, and initial expansion options;
- initial dimensions and component-specific mode properties.

Calling `setVariant` or changing an init-only property later is either ignored
or produces a warning.

### Initialize before attaching generated content

For explicitly initialized widgets:

1. create the component;
2. configure it;
3. call `initialize()`;
4. call `addContentToElement` on that same SceneObject when supported;
5. subscribe to public events.

`ElementContent` is one-per-widget SceneObject. Sliders and controls whose
catalog entry says otherwise use separate label content.

**Element widgets and the `Shape` base auto-initialize during `OnStart`** — the
engine calls `initialize()` for you the first frame the widget's `OnStartEvent`
runs, so a widget you create and leave alone still builds. Call `initialize()`
**explicitly** when you need the widget's generated internals — its
`Interactable`, mesh, or collider — synchronously in the same step you create it,
before `OnStart` has run: to wire the widget's own event or read built state
immediately, or when you create the component and cannot wait for its `OnStart`
to run (call `initialize()` rather than depending on frame timing). `.size` is stored
whether you set it before or after `initialize()` (the init pass reads it, and a
later set updates live), so ordering `.size` is not the hazard.

**Visuals retain their pre-init state.** A standalone `RoundedRectangle` (like
other `Visuals/` primitives it derives from `Shape` and also initializes during
`OnStart`) stores `.size`, `.cornerRadius`, and `.backgroundColor` set before
`initialize()` and applies them when its mesh builds — those setters do not
no-op. So set them in either order; call `initialize()` first only when you need
the built mesh/material immediately (for example to read or clone it
synchronously). See [content and theme](content-theme.md).

**Wire the widget's interaction event synchronously, right after `initialize()`
— never from a separate deferred `UpdateEvent` that races the build.** A widget's
`Interactable` is created *by* `initialize()`. A common dead-click pattern is to
`createComponent` the buttons, then wire them in one deferred `UpdateEvent`/
`DelayedCallbackEvent` that looks the `Interactable` up with
`getComponent(...)` — if that deferred pass runs before the widget's own init has
built the `Interactable`, the lookup returns null, `onTriggerEnd.add(...)` never
runs, and the button renders fine but does nothing. Instead call
`btn.initialize()` inline and subscribe to the widget's own inherited event
(`btn.onTriggerUp.add(cb)`, from `Element`) in the same step — no deferred lookup,
no ordering race. (`ElementContent.text` may be set synchronously too: the setter
stashes text before init and applies it on build.)

### Treat programmatic writes as events

`isOn` and `toggle(on)` emit value events when the state changes. Set initial
state before adding handlers, or guard two-way synchronization. Slider
`resetToValue(value)` is the silent value-reset path; `updateCurrentValue`
emits. `resetToValue` still fires `onKnobMoved`; `isDragging` is false for it.

**Do not apply an initial selection/toggle while still building the panel.** If a
widget's value/toggle/select callback reads *other* widgets (a "select room 0"
handler that touches the power switch and sliders), firing it during construction
throws — those siblings do not exist yet — and the exception aborts the rest of
the build, leaving a half-built panel that still type-checks. Build every widget
first, apply the initial state **last** (after all are created), and null-guard
any sibling access inside such callbacks.

### Pause input with `inputPaused`, not the collider

To take a control out of input for a moment, such as while its panel moves or a
command it started runs, set `inputPaused = true` on it (any `Element`) and
`false` to resume. It keeps its look; use `inactive` when it should look
unavailable. Do not turn its `collider` off for this: Element's and IK's
enable paths, Frame and ScrollWindow all turn colliders back on. Pausing drops a
hover or press in flight, and that press ends with `onTriggerEndOutside` or
`onTriggerCanceled`, never `onTriggerUp`.

### Wait for layout

Layout2D computes in a later update. Do not size a Frame from a layout in the
same call that creates the children. Use `onLayoutComplete`, a documented
`forceLayout`/refresh method, or defer the measurement.

`Frame.autoScaleContent` is intended for authored content. For code-sized
content, set it to `false`; enable Frame scaling only when the screen also
implements content reflow.

A layout only discovers children that are enabled when it measures. When a panel
has multiple pages/tabs, build them all enabled so the sizing pass sees every
one, and disable the non-initial pages only *after* the deferred measurement —
disabling a page at the end of the build makes it measure ~0 and can collapse a
panel sized from the max of its pages.

**A hideable panel's backing plate and its content must sit under ONE toggle
node.** A common overlay bug: `hide()` disables only an inner content container
while the panel's backing `RoundedRectangle`/plate lives on a *different*,
still-enabled node — so the panel's translucent slab keeps drawing over whatever
is behind it (an overlay detail panel that "closes" still veils the list beneath
it). Put the backing and the content under the same SceneObject and toggle *that*
object's `enabled` to show/hide the whole panel. (This is the toggle-a-dedicated-
host form of the "never disable the script's OWN SceneObject" rule — the host you
toggle is a node you control, not the script's own object.)

### Public setters can run before lazy content exists

A Frame builds its content during its `OnStart` pass and then fires
`onInitialized`, and a page/panel often builds on its first `show()` — both
**after** `onAwake`. So a public setter an orchestrator
calls right after creation (`setTitle`, `setItems`, `showConfirmation`) can run
*before* the content it targets exists, and a naive `if (this.textRef) …` guard
then silently drops the value. Cache each incoming value to a field, and re-apply
the cached values at the end of `buildContent()` (an `applyCached()` step). Never
assume the target content exists when a setter fires.

## Minimal example

See the compiling [Button example](examples.md#button), which follows
configure → initialize → content → events.

## Limitations

- Inspector-only options are not public code APIs.
- Runtime-created components can initialize sooner than scene-authored
  components; use explicit initialization where public.
- Generated child objects are component-owned. Destroy the component's
  SceneObject or use its public cleanup API rather than selectively destroying
  internals.
