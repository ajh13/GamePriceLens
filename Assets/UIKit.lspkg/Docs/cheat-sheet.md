# UIKit cheat sheet (load-bearing invariants)

[← Agent usage index](../README.md)

## Use when

Read this **first**, and re-read it right before building. It is a terse index of
the rules that most often break a generated lens, with a pointer to the full
detail. It is intentionally small so it stays resident in context even when the
larger docs are compacted away — but it is a pointer, not a substitute: read the
linked section for the how.

## The rules

1. **Layout = Flex/Grid, never absolute.** `FlexLayout`/`GridLayout` + a `FlexItem`
   per child; `justifyContent`/`alignItems`/`alignSelf`/`gap`. Never set an
   element's X/Y `localPosition` from panel half-width/height. `localPosition` is
   for a small **+Z depth offset only**. → [layout](layout.md), [examples](examples.md)
2. **Depth-separate stacked surfaces, by construction.** >1 stacked visual on the
   same plane → Canvas on the screen root **+** a single absolute `+Z` on the node
   that begins each stacked layer (only where surfaces are coplanar). Flex/Grid
   preserve Z, so set it once — do not stagger a `+Z` per nesting level. (Coplanar
   transparent surfaces screen-door z-fight into a checkerboard; invisible to every
   gate and to a no-preview session.) → [layout](layout.md)
3. **`initialize()` auto-runs in `OnStart`; call it explicitly to build now.** Element
   widgets and Visuals (`RoundedRectangle`) auto-initialize during `OnStart`; call
   `initialize()` yourself only to access generated internals (Interactable, mesh)
   synchronously the same frame. Visuals retain `.size`/`.cornerRadius`/`.backgroundColor`
   set before init. Wire the widget's own event synchronously after `initialize()`,
   never from a deferred `UpdateEvent`. →
   [lifecycle](lifecycle.md)
4. **Text size is a font number, not cm.** `ElementContent.textSize` ~28-48 (default 48);
   single or low-double digits render microscopic. Standalone labels need an explicit
   `sizeOverride`. (Raw `Component.Text.size` is the same font-scale family but is engine
   API: see the Lens API skill / `StudioLib.d.ts`.) → [content-theme](content-theme.md)
5. **Cross-axis fill needs `alignItems: Stretch`** or the child collapses to
   `worldScale 0` (invisible). Re-`refreshChildren()` after adding rows; append to a
   scroll list per-item or rows pile at the origin. → [layout](layout.md)
5b. **A `TopLeft` ScrollWindow's content column MUST set `horizontalAlignment: Left`
   + `verticalAlignment: Top`** (column `width` = `windowSize.x`). Otherwise Flex
   centers the column on the top-left corner (x = −width/2) and every row is clipped
   on the left / shoved off-panel — a very common feed/list bug. → [layout](layout.md)
6. **Hide a panel by toggling ONE host** carrying both backing and content — not an
   inner container (leaves the backing plate veiling what's behind). → [lifecycle](lifecycle.md)
7. **Author hosts in the scene; discover peers typed.** Panel/host SceneObjects in
   `Scene.scene`; `obj.getComponent(MyScript.getTypeName())` in `OnStartEvent`, never
   duck-typed `getComponents("Component.ScriptComponent")`. → CLAD skills.
8. **Icons: `/icon-selector` path or a text glyph only.** Never a hand-typed
   `requireAsset` path; never `requireAsset` at module top level. → [content-theme](content-theme.md)
9. **Frame is self-initializing (async `onInitialized`)** — set `innerSize`/read
   generated internals there, not synchronously after `createComponent`; keep host
   transforms at identity scale. → [layout](layout.md), [lifecycle](lifecycle.md)

## Verify (a compile-clean lens can still be broken)

Look at a captured frame for: a dithered **checkerboard** (z-fight), collapsed/empty
content (`worldScale 0`), microscopic or one-glyph text, buttons that render but do
nothing. Depth separation and legible text must hold **whether or not** you can
preview — they are invisible to the type-check and render gates. → [troubleshooting](troubleshooting.md)
