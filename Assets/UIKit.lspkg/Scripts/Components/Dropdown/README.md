# Dropdown

A scrollable, animated selector component for AR experiences.

---

## Overview

The Dropdown attaches a scrollable drawer to a trigger button. It supports two operational modes:

- **Unpool mode** — You create UI components (Button, Switch, Checkbox, or any VisualElement) wrapped in `DropdownItem` markers. Best for small, fixed lists (< ~20 items). Each item can be styled independently.
- **Pool mode** — You provide data (`DropdownOption[]`), and the Dropdown manages Button items internally via virtual scrolling. Efficient for large or dynamic lists where all items share the same style. **Pool mode only supports Buttons** — use unpool mode for mixed component types (Switch, Checkbox, etc.).

Both modes share the same expand/collapse animation, selection behavior, scroll fade, and event system.

Dropdown extends `FlexContainer`, an abstract base class shared with `ElementGroup` that pairs a `FlexLayout` with a pool of `RoundedRectangle` background segments.

---

## Setup

### In the Lens Studio Inspector

1. Create a SceneObject in your scene.
2. Add the `Dropdown` component to it.
3. Configure the trigger button, selection mode, and drawer layout in the inspector.
4. (Unpool mode) Add child SceneObjects with a UIKit component (`Button`, `Switch`, `Checkbox`, etc.) + `DropdownItem` marker component.
5. (Pool mode) Call `setData()` from a script to populate the list.

### From Code

```typescript
import {Dropdown, DropdownOption} from "./Dropdown"

const dropdownObject = global.scene.createSceneObject("MyDropdown")
const dropdown = dropdownObject.createComponent(Dropdown.getTypeName()) as Dropdown
```

---

## Scene Hierarchy

When the Dropdown initializes, it generates the following scene structure:

```
\__> Dropdown (your SceneObject with Dropdown component)
   |    + Canvas (World / Hierarchy sorting — added automatically, see Draw Order)
   \__> DropdownTriggerButton (auto-generated, or your custom trigger)
   \__> DropdownTriggerBackground (rounded rect behind trigger, optional)
   \__> DropdownBackground (rounded rect behind the drawer)
   \__> DropdownScrollWrapper
      \__> DropdownScroll (ScrollWindow)
         \__> DropdownScrollContent (scroll-managed root)
            \__> FlexContainerContent (FlexLayout container)
               \__> Item buttons...
```

Child order is draw order (see [Draw Order](#draw-order)), so the list above is also
back-to-front: the trigger draws first, the drawer background over it, the items last.
The trigger background is the one exception — it is created after the trigger button but
sits 0.15 behind it, so the depth test keeps it behind and only its padding ring shows.

---

## Quick Start: Unpool Mode

Create UI components yourself, wrap each in a `DropdownItem`, and hand them to the Dropdown.

```typescript
import {Dropdown} from "./Dropdown"
import {DropdownItem} from "./DropdownItem"
import {Button} from "../Button/Button"

const dropdown = myObject.getComponent(Dropdown.getTypeName()) as Dropdown

// Create items
const labels = ["Apple", "Banana", "Cherry"]
const items: DropdownItem[] = []

for (const label of labels) {
  const obj = global.scene.createSceneObject(label)
  const btn = obj.createComponent(Button.getTypeName()) as Button
  btn.size = new vec3(8, 2.5, 1)
  btn.initialize()
  const item = obj.createComponent(DropdownItem.getTypeName()) as DropdownItem
  // stretchToFill defaults to true — button fills the cell
  items.push(item)
}

dropdown.setItems(items)

// React to selection
dropdown.onItemTapped.add((event) => {
  print(`Tapped: ${labels[event.index]}`)
})
```

---

## Quick Start: Pool Mode

Provide data and let the Dropdown manage buttons via virtual scrolling.

```typescript
import {Dropdown, DropdownOption} from "./Dropdown"

const dropdown = myObject.getComponent(Dropdown.getTypeName()) as Dropdown

// Build data
const options: DropdownOption[] = []
for (let i = 0; i < 100; i++) {
  options.push(new DropdownOption(`Option ${i}`))
}

dropdown.setData(options)

// React to taps (index refers to the data array)
dropdown.onItemTapped.add((event) => {
  print(`Tapped data index: ${event.index}`)
})
```

---

## Inspector Properties

### Trigger Button

| Property | Type | Default | Init-only | Description |
|----------|------|---------|-----------|-------------|
| Custom Trigger | boolean | false | Yes | When true, supply your own Button via Custom Button. |
| Custom Button | Button | — | Yes | Reference to a custom trigger Button. |
| Button Size | vec2 | (9.5, 3) | Yes | Width and height of the auto-generated trigger. |
| Style | string | "Primary" | Yes | Visual style: Prism, Primary, Secondary, Ghost. |
| Label | string | "Select" | No | Text displayed on the trigger button. |
| Text Size | number | 60 | Yes | Text size for the trigger label. |
| Content Padding | vec2 | (0.8, 0.5) | Yes | Inner padding of trigger content (x=horizontal, y=vertical). |
| Hide Trigger | boolean | false | Yes | Hides the trigger; control the drawer via `expand()`/`collapse()`. |
| Has Background | boolean | true | No | Reserve space for a rounded background behind the trigger. Toggling at runtime creates/destroys the background SceneObject. |
| Show Background | boolean | true | Yes | Render the trigger background. |
| Trigger Padding | vec2 | (0.5, 0.5) | No | Padding around the trigger background in cm. |

### Selection

| Property | Type | Default | Init-only | Description |
|----------|------|---------|-----------|-------------|
| Mode | string | "single" | Yes | `none`: no toggle. `single`: one at a time. `multi`: multiple. |
| Allow Empty | boolean | true | No | When false, at least one item must stay selected. |
| Collapse On Select | boolean | false | No | Auto-collapse after an item is selected. |

### Drawer Layout

| Property | Type | Default | Init-only | Description |
|----------|------|---------|-----------|-------------|
| Max Visible Items | number | 5 | No | Items visible before the drawer scrolls. |
| Override Width | boolean | false | No | Use a fixed width instead of matching the trigger. |
| Width | number | 9.5 | No | Fixed drawer width (when Override Width is true). |
| Expand Up | boolean | false | No | Expand the drawer upward instead of downward. |
| Expand Anchor | string | "Top" | No | Anchor edge that stays fixed during expansion: "Top", "Center", or "Bottom". See [Expand Anchor](#expand-anchor). |
| Start Expanded | boolean | true | Yes | Initial expanded state. Use `expand()`/`collapse()` at runtime. |
| Item Spacing | number | 0.5 | No | Vertical gap between items in cm. |
| Dropdown Padding | vec2 | (0.5, 0.6) | No | Padding around items in cm (x=horizontal, y=vertical). |

### Pool Mode

| Property | Type | Default | Init-only | Description |
|----------|------|---------|-----------|-------------|
| Option Height | number | 2.6 | Yes | Height of each pool item in cm. |
| Option Style | string | "Ghost" | Yes | Style for pool buttons: Prism, Primary, Secondary, Ghost. |
| Option Text Size | number | 0 | Yes | Text size for pool items. 0 = use trigger text size. |

> **Init-only** properties must be set before `OnStartEvent` fires (i.e. in the inspector or before the component starts). Changing them at runtime logs a warning and has no effect.

### DropdownItem (Unpool Mode)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| Order | number | 0 | Display order for scene-based discovery (lower values appear first). |
| Width | number | 9 | Cell width in cm. 0 = use child element's width. |
| Height | number | 3 | Cell height in cm. 0 = use child element's height. |
| Stretch To Fill | boolean | true | When true, stretches the element to fill the cell defined by width/height. When false, the element keeps its own size within the cell. |
| Alignment | string | "Left" | Alignment of the element within the cell when stretchToFill is off. Options: "Left", "Center", "Right". |

### Code-Only Properties

These properties are not exposed in the inspector. Set them from code.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| renderOrder | number | 0 | Base render order for everything the Dropdown owns, applied flat — the same property every other kit component has. The Dropdown mints one Hierarchy Canvas on its object (or inherits an authored ancestor's), so trigger, drawer and items sort by hierarchy at this order. |
| drawerRenderOrder | number | 0 | Override for the drawer half: background, item buttons and their content, and the scroll edge fade. Zero follows `renderOrder`. Non-zero is the popup escape hatch — it lifts the open drawer over the Dropdown's later siblings, but also over any ancestor Frame chrome and edge fades, because `renderOrder` outranks every Canvas. |
| triggerRenderOrder | number | 0 | **Deprecated** — use `renderOrder`. Override for the trigger half only (button, content, trigger background). Zero follows `renderOrder`. |

---

## API Reference

### Expand / Collapse

```typescript
dropdown.expand()    // Show the drawer with animation
dropdown.collapse()  // Hide the drawer with animation
dropdown.toggle()    // Toggle between expanded and collapsed
```

`dropdown.isExpanded` — read-only boolean for the current state.

`dropdown.contentOffset` — Y offset a parent layout should apply when expanded.

---

### Item Management (Unpool Mode)

```typescript
dropdown.setItems(items: DropdownItem[]): void
// Replace all items. Switches from pool mode if needed.

dropdown.appendItem(item: DropdownItem): void
// Add an item to the end.

dropdown.insertItem(item: DropdownItem, index: number): void
// Insert an item at the given index.

dropdown.removeItemAt(index: number): void
// Remove and destroy the item at the given index.

dropdown.getItemCount(): number
// Number of items (works in both modes).
```

---

### Data Management (Pool Mode)

```typescript
dropdown.setData(items: DropdownOption[]): void
// Replace all data. Switches to pool mode. Dropdown manages buttons internally.

dropdown.appendData(item: DropdownOption): void
// Append a single data item. Preserves scroll position.

dropdown.insertData(item: DropdownOption, index: number): void
// Insert at the given index. Auto-shifts selected indices.

dropdown.removeDataAt(index: number): void
// Remove at the given index. Auto-shifts selected indices.
```

**DropdownOption:**

```typescript
class DropdownOption {
  text: string                     // Display text
  data?: Record<string, any>       // Optional user metadata
  constructor(text: string, data?: Record<string, any>)
}
```

---

### Selection

**Unpool mode:**

```typescript
dropdown.selectItem(item: DropdownItem): void
dropdown.deselectItem(item: DropdownItem): void
dropdown.clearSelection(): void
dropdown.getSelectedItems(): DropdownItem[]
```

**Pool mode:**

```typescript
dropdown.selectDataAt(index: number): void
dropdown.deselectDataAt(index: number): void
dropdown.clearSelection(): void
dropdown.getSelectedIndices(): number[]
dropdown.getSelectedItems(): DropdownItem[]   // Unpool mode only; [] in pool mode
```

**External ToggleGroup (unpool mode only):**

```typescript
dropdown.toggleGroup = myToggleGroup  // Delegate selection to a ToggleGroup
```

---

### Draw Order

The Dropdown adds a `Canvas` (World units, Hierarchy sorting) to its own SceneObject
when it initializes, or inherits one from an ancestor if a compatible `Canvas` is
already above it. Everything the Dropdown owns then sits at one flat render order and
**child order decides what draws on top**, which is what lets a Dropdown composite
correctly inside a `Frame`, a `ScrollWindow`, or behind an edge fade. Buttons nested
under the Dropdown (the trigger and every pool item) inherit that Canvas and no longer
add one of their own.

```typescript
dropdown.renderOrder = 10
// Base order for the whole widget. Everything the Dropdown owns sits flat at 10
// and its Canvas orders trigger, drawer and items by hierarchy.

dropdown.drawerRenderOrder = 12
// Escape hatch: lifts the drawer (background, items, pool buttons, edge fade)
// above the Dropdown's later siblings, which hierarchy sorting alone cannot do.
// It leaves the governing Canvas bucket, so it also draws over lower-ordered
// ancestor chrome. Zero = follow renderOrder. Applies to both unpool and pool
// modes; newly added items inherit it.

dropdown.triggerRenderOrder = 10
// Deprecated: trigger-half override kept for compatibility. Prefer renderOrder.
```

**When you need `drawerRenderOrder`.** Hierarchy sorting places the Dropdown's whole
subtree at the Dropdown's own position among its siblings, so a sibling that comes
*after* the Dropdown draws over the open drawer. Under a Flex or Grid parent you cannot
fix that by reordering, because child order is also layout order. Set
`drawerRenderOrder` above the orders of the siblings the drawer must cover. Be aware it
outranks every `Canvas`, so too large a value will also cover surrounding chrome.

**If you reparent the Dropdown at runtime**, call `dropdown.invalidateCanvasBinding()`
afterwards so it re-resolves which `Canvas` governs it. Adding it to a `ScrollWindow`
through `addObject()` does this for you. Items you hand to `appendItem()` / `insertItem()`
are re-bound for you as well, even if you built them somewhere with no `Canvas` above them.

**Limit.** A `ScrollWindow` masks its subtree, so a Dropdown placed inside a scrolling
list cannot have its drawer escape that viewport. No render-order or Canvas setting
changes that. Place such a Dropdown outside the masked area.

---

### Scrolling

```typescript
dropdown.scrollToItem(index: number, durationMs?: number): void
// Smooth-scroll to the item at the given index.
// durationMs defaults to 300. No-op when collapsed.
// Works in both unpool and pool modes.
```

---

### Events

```typescript
dropdown.onExpandedChanged: PublicApi<boolean>
// Fires when expand/collapse state changes.

dropdown.onItemTapped: PublicApi<DropdownItemEvent>
// Fires when any item is tapped. Payload: { index: number, item: DropdownItem | null }

dropdown.onSelectionChanged: PublicApi<DropdownItem[]>
// Fires when selection changes. Payload: array of selected DropdownItems.
// In pool mode, always emits an empty array — use getSelectedIndices().
```

---

### Callbacks (Pool Mode)

Optional function properties for customizing pool behavior:

```typescript
dropdown.onBindItem = (button: Button, item: DropdownOption, index: number) => {
  // Called when a pool button is rebound to new data during scroll.
  // Use to update custom visuals or metadata.
}

dropdown.onUnbindItem = (button: Button, item: DropdownOption, index: number) => {
  // Called when a pool button is about to be rebound away from its current data.
  // Use to clean up temporary state.
}

dropdown.onFadeItem = (button: Button, alpha: number) => {
  // Called when an item's fade alpha changes during scroll.
  // Use to fade custom visuals not handled by button.opacity.
}
```

---

## Scene-Based Item Discovery

In unpool mode, you can set up items entirely in the inspector without writing code.

1. Add child SceneObjects under the Dropdown SceneObject.
2. Each child needs a UIKit component (`Button`, `Switch`, `Checkbox`, etc.) and a `DropdownItem` marker component.
3. Set the `order` property on each `DropdownItem` to control display sequence.

```
\__> Dropdown
   \__> FirstItem (Button + DropdownItem, order=0)
   \__> SecondItem (Switch + DropdownItem, order=1)
   \__> ThirdItem (Button + DropdownItem, order=2)
```

On start, the Dropdown auto-discovers these children, sorts by `order`, and adds them to the drawer.

---

## Expand Anchor

The `expandAnchor` property controls which edge of the Dropdown stays fixed in world space as the drawer opens. This works both standalone and inside an ElementGroup.

| Anchor | Behavior |
|--------|----------|
| Top | The top edge stays fixed. The drawer grows downward (or the component shifts up when expanding up). |
| Center | Growth is split equally — the component expands in both directions. |
| Bottom | The bottom edge stays fixed. The drawer grows upward (or the component shifts down when expanding down). |

**Standalone:** The Dropdown shifts its own SceneObject position during the expand/collapse animation to keep the anchor edge pinned.

**Inside an ElementGroup:** The Dropdown skips the self-anchor offset (`parentHandlesAnchor = true`). Instead, the ElementGroup computes a combined Y offset from all expanded dropdowns' anchor settings and applies it to the layout container.

```typescript
// Expand down, keep top edge fixed (default)
dropdown.expandUp = false
dropdown.expandAnchor = "Top"

// Expand up, keep bottom edge fixed
dropdown.expandUp = true
dropdown.expandAnchor = "Bottom"

// Expand down, split growth equally
dropdown.expandUp = false
dropdown.expandAnchor = "Center"
```

---

## Custom Content

A `DropdownItem` doesn't require a UIKit component — it can act as a layout cell for any custom content. Set `width` and `height` to reserve space in the layout, then attach arbitrary child SceneObjects (3D meshes, custom scripts, etc.) to the item's SceneObject. The layout engine reserves the cell, and your content lives inside it.

```typescript
const cellObj = global.scene.createSceneObject("CustomCell")
const item = cellObj.createComponent(DropdownItem.getTypeName()) as DropdownItem
item.width = 8
item.height = 3
items.push(item)

// Attach any custom content as children of cellObj
const myContent = global.scene.createSceneObject("MyContent")
myContent.setParent(cellObj)
```

> **Note:** Custom content items won't have interaction events (onTriggerUp) unless you add your own Interactable and collider. Items without a VisualElement child act as non-interactive spacers by default.

---

## Custom Trigger

To use your own button as the trigger instead of the auto-generated one:

```typescript
// Set before the component starts (or in the inspector)
dropdown.customTrigger = true
dropdown.topButton = myCustomButton
```

The Dropdown wires up tap-to-toggle and size tracking automatically. You are responsible for the button's appearance and sizing.

---

## Important Notes

1. **Init-only properties** (trigger configuration, pool item height/style, start expanded) must be set before `OnStartEvent`. Changing them at runtime has no effect.

2. **Pool mode selection caveat:** `onSelectionChanged` and `getSelectedItems()` always emit/return an empty array. Use `getSelectedIndices()` to read selected data indices.

3. **External ToggleGroup** is not supported in pool mode. Use `selectionMode` instead.

4. **Scroll drag deferral:** In pool mode, layout mutations are deferred while the user is actively scrolling to prevent visual jumps. Updates flush ~500ms after the scroll gesture ends.

5. **Mode switching:** Calling `setItems()` with `DropdownItem[]` switches from pool to unpool mode. Calling `setData()` switches from unpool to pool mode. Previous items/data are cleared on switch.

6. **Empty drawer:** When the Dropdown has no items, clicking the trigger button does not open a drawer. The `expand()`/`toggle()` API still updates `isExpanded` state and fires `onExpandedChanged`, but no drawer animation runs. If all items are removed while the drawer is open, it auto-collapses.

7. **Draw order is hierarchy-based.** The Dropdown manages a `Canvas` on its own SceneObject and keeps every renderable it owns at one flat render order. Do not set `renderOrder` on the Dropdown's generated children yourself; use `renderOrder` / `drawerRenderOrder` instead. See [Draw Order](#draw-order) for the drawer-over-siblings case and the masked-scroller limit.

8. **ElementGroup integration:** When a SceneObject hosting a `Dropdown` is added to an `ElementGroup` via `addItem()`, the group automatically configures trigger sizing, background handling, and drawer expansion behavior. In vertical mode the group draws per-trigger-row background segments (the drawer area is painted by the dropdown's own background, extended via `drawerBackgroundExtension`) and shifts sibling items. See the [ElementGroup README](../ElementGroup/README.md) for details.

---

## Migration

- `DropdownItemEvent`: `button: Button` → `item: DropdownItem | null` (null in pool mode — use `event.index` against your data).
- `onSelectionChanged` payload: `Button[]` → `DropdownItem[]`.
- Pool mode: `onSelectionChanged` and `getSelectedItems()` now emit/return `[]`. Use `getSelectedIndices()` instead.

### Canvas + hierarchy draw order

No code changes are required. Existing `triggerRenderOrder` / `drawerRenderOrder` calls keep
their exact behaviour, and the default of `0` now means "sort by hierarchy" rather than "no
render order written", which is what makes a Dropdown composite correctly inside a `Frame` or a
`ScrollWindow`. What changed:

- A `Canvas` component now appears on the Dropdown's SceneObject at runtime (or it inherits a
  compatible ancestor one). Nested Buttons no longer add their own — a default pool Dropdown went
  from 7 Canvas components to 1.
- Prefer the new `renderOrder` for the whole widget. `triggerRenderOrder` is deprecated; it still
  works as a trigger-half override.
- `drawerRenderOrder` now also drives the drawer's scroll edge fade, so the fade stays above the
  items when you band the drawer.
- The trigger background moved from Z `-0.18` to `-0.15`, one `Z_LAYER_STEP` in front of the drawer
  background instead of `0.02`. Two opaque, depth-writing quads that overlap need at least one
  step between them; `0.02` was below the kit's depth-resolution floor.
- **Custom triggers:** `dropdown.renderOrder` and `dropdown.triggerRenderOrder` now write to your
  `topButton`, both before and after start. Your button keeps whatever `Canvas` it resolved when
  *you* initialized it: if you call `initialize()` on it before handing it over, which is the usual
  order, that is a `Canvas` of its own rather than the Dropdown's. Either sorts correctly, but it
  does mean your button is its own sorting scope, so lay its internals out with child order and Z
  offsets rather than render-order bumps.
- **Custom item content:** the same applies to `DropdownItem` content. An `ElementContent` inside
  an item no longer raises itself above its host; it goes flat and relies on child order plus its
  Z offset.
