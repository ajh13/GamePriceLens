# ElementGroup

Arranges UI components (Button, Dropdown, Checkbox, Switch, or any handler-recognized content) in a horizontal or vertical group with a shared background.

---

## Overview

ElementGroup lays out a mix of UI components along a single axis. Each item is a `FlexItem` on a child SceneObject — the group sizes each cell via the item's registered `ItemHandler`. In **vertical mode**, when a Dropdown expands its drawer, items shift to make room and the group background splits into one rounded segment per contiguous run of triggers; the drawer area is filled by the dropdown's own native drawer background, extended slightly to bridge into the adjacent trigger row.

Both ElementGroup and Dropdown extend `FlexContainer`, an abstract base class that pairs a `FlexLayout` with a pool of `RoundedRectangle` background segments. Each subclass overrides `onFlexLayoutComplete()` to implement its specific background rendering logic.

Items can be added in the inspector (scene-based discovery) or from code.

### Horizontal vs Vertical mode

- **Vertical:** when a child Dropdown expands, sibling items shift and the group background splits into trigger-row segments. The drawer area is filled by the dropdown's own native drawer background.
- **Horizontal:** child Dropdowns expand independently below their trigger with their own drawer background. The group background remains a single rectangle and does not segment.

---

## Setup

### In the Lens Studio Inspector

1. Create a SceneObject in your scene.
2. Add the `ElementGroup` component to it.
3. Configure direction, sizing, and spacing in the inspector.
4. Add child SceneObjects with any UIKit component (`Button`, `Dropdown`, `Checkbox`, `Switch`, etc.).
5. Add a `FlexItem` component to each child and set its `Order` to control display sequence.

### From Code

```typescript
import {ElementGroup} from "./ElementGroup"
import {Button} from "../Button/Button"
import {Dropdown} from "../Dropdown/Dropdown"

const groupObject = global.scene.createSceneObject("MyGroup")
const group = groupObject.createComponent(ElementGroup.getTypeName()) as ElementGroup
```

---

## Scene Hierarchy

When the ElementGroup initializes, it generates the following scene structure:

```
\__> ElementGroup (your SceneObject with ElementGroup component)
   \__> FlexContainerContent (FlexLayout container)
   |  \__> Button items...
   |  \__> Dropdown items...
   \__> FlexContainerBg0 (RoundedRectangle background segment)
   \__> FlexContainerBg1 (additional segments when vertical dropdowns expand)
```

---

## Scene-Based Item Discovery

You can set up items entirely in the inspector without writing code.

1. Add child SceneObjects under the ElementGroup SceneObject.
2. Each child needs a UIKit component (`Button`, `Dropdown`, `Checkbox`, `Switch`, etc.) and a `FlexItem` component.
3. Set the `Order` property on each `FlexItem` to control display sequence.

```
\__> ElementGroup
   \__> ActionButton (Button + FlexItem, order=0)
   \__> OptionsDropdown (Dropdown + FlexItem, order=1)
   \__> ToggleSwitch (Switch + FlexItem, order=2)
```

On start, the ElementGroup auto-discovers these children, sorts by `FlexItem.order`, and adds them with `stretchToFill: true` (the classic look — items fill the cell width in vertical mode / height in horizontal mode). Use the programmatic API for other defaults.

---

## Quick Start

### Adding Items Programmatically

`addItem` accepts a `FlexItem` *or* a bare `SceneObject` — the group handles the rest. With no `opts`, the item's registered handler (Element, Shape, Text, Image, mesh, …) resolves the natural cell size.

```typescript
import {ElementGroup} from "./ElementGroup"
import {Button} from "../Button/Button"
import {Checkbox} from "../Button/Checkbox"

const group = groupObject.getComponent(ElementGroup.getTypeName()) as ElementGroup

// Stretched cell (button fills the cell width in vertical mode)
const btnObj = global.scene.createSceneObject("Action")
const btn = btnObj.createComponent(Button.getTypeName()) as Button
btn.initialize()
group.addItem(btnObj, {stretchToFill: true})

// Natural-size cell — left-aligned by default
const checkObj = global.scene.createSceneObject("Check")
const checkbox = checkObj.createComponent(Checkbox.getTypeName()) as Checkbox
checkbox.initialize()
group.addItem(checkObj)
// Or, for explicit alignment:
//   group.addItem(checkObj, {stretchToFill: false, alignment: "Right"})
```

### With Dropdowns

```typescript
const ddObj = global.scene.createSceneObject("Options")
const dropdown = ddObj.createComponent(Dropdown.getTypeName()) as Dropdown
group.addItem(ddObj, {stretchToFill: true})

// Populate the dropdown after adding to the group
dropdown.setData([
  new DropdownOption("Option A"),
  new DropdownOption("Option B"),
  new DropdownOption("Option C"),
])
```

### Batch Add

```typescript
group.addItems([
  btnObj,
  [checkObj, {stretchToFill: false, alignment: "Center"}],
  ddObj
])
```

---

## Inspector Properties

### ElementGroup

| Property | Type | Default | Init-only | Description |
|----------|------|---------|-----------|-------------|
| Direction | string | "Horizontal" | Yes | Layout axis: "Horizontal" or "Vertical". |
| Width | number | 9.5 | Yes | Width applied to all items in vertical mode (cm). |
| Height | number | 3 | Yes | Height applied to all items in horizontal mode (cm). |
| Spacing | number | 0.5 | Yes | Gap between items (cm). |
| Padding | vec2 | (0.5, 0.5) | No | Per-side padding around the group (horizontal, vertical) in cm. |
| Background Enabled | boolean | true | No | Enable/disable background rendering. |
| Scroll Window | ScrollWindow | (none) | Yes | Optional. When set, the group becomes the window's scrolling content and owns its SceneObject's local position. |

> **Init-only** properties must be set before `OnStartEvent` fires (i.e. in the inspector or before the component starts). Changing them at runtime has no effect.

`cornerRadius` is **read-only and derived** — there is no inspector input for it. It is the
button corner radius extended by the smaller padding axis, so the background stays concentric
with the inner buttons; change `Padding` to affect it.

### Per-Item (FlexItem)

Standard `FlexItem` inspector inputs control per-cell behavior:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| Order | number | 0 | Display order for scene-based discovery (lower values appear first). |
| Override Width | number | 0 | Explicit cell width in cm. `0` = handler-driven. |
| Override Height | number | 0 | Explicit cell height in cm. `0` = handler-driven. |

Stretch / alignment behavior is **per-call** rather than a FlexItem input — pass `stretchToFill` / `alignment` via `CellOptions` to `addItem` for the programmatic path. Scene-discovered items default to `stretchToFill: true` and left alignment.

---

## API Reference

### Item Management

```typescript
group.addItem(input: FlexItem | SceneObject, opts?: CellOptions): FlexItem
// Add an item to the group. Accepts a FlexItem or any SceneObject — if no
// FlexItem exists on the SceneObject, one is created. If the SceneObject
// (or any descendant) hosts a Dropdown, the group automatically configures
// trigger sizing and wires up expansion behavior.

group.addItems(
  inputs: ReadonlyArray<FlexItem | SceneObject | [FlexItem | SceneObject, CellOptions]>
): FlexItem[]
// Batch form. Each entry can be a bare input (inherits defaults) or a
// [input, opts] tuple for per-item options.

group.removeItemAt(index: number): void
// Detach from the layout, cancel dropdown subscriptions, and reparent the
// item's SceneObject back under the group SceneObject. The caller owns
// visibility and lifecycle — destroy, hide, or reparent as needed.

group.getItems(): ReadonlyArray<FlexItem>
// Get all current FlexItems.

group.getItemCount(): number
// Get the number of items.
```

### CellOptions

```typescript
interface CellOptions {
  order?: number          // Sort key (lower = earlier)
  width?: number          // Free-axis size (cm). Omit / 0 = handler-driven.
  height?: number         // Symmetric to width.
  stretchToFill?: boolean // true = fill cell, false = natural size + alignment
  alignment?: string      // "Left" | "Center" | "Right" — used when !stretchToFill
}
```

---

### Events

```typescript
group.onItemAdded: PublicApi<FlexItem>
// Fires when an item is added to the group.

group.onItemRemoved: PublicApi<FlexItem>
// Fires when an item is removed from the group.

group.onSizeChanged: PublicApi<vec2>
// Fires when the group's overall size changes (including during dropdown expansion).
```

---

### Read-Only Properties

```typescript
group.direction    // "Horizontal" or "Vertical"
group.width        // Item width (vertical mode)
group.height       // Item height (horizontal mode)
group.spacing      // Gap between items
group.padding      // Per-side padding
group.cornerRadius // Background corner radius
group.backgroundEnabled // Whether background is rendered
```

---

## Vertical Mode — Dropdown Expansion

When a Dropdown inside a vertical ElementGroup expands:

1. Items below (or above, when `expandUp`) the dropdown shift to make room for the drawer.
2. The group renders one rounded background segment per contiguous run of triggers — drawer areas are *not* covered by group segments. Instead, the dropdown's own native drawer background paints the drawer area and is extended 0.5 cm into the adjacent trigger row to bridge the visual seam (via `dropdown.drawerBackgroundExtension`, which the group sets automatically). The bridge is suppressed at the column edges where there is no neighbour to bridge into.
3. The group automatically handles anchor offset so the group stays visually fixed.

The ElementGroup sets several properties on Dropdowns when they are added:

- `parentHandlesAnchor = true` — the group manages the anchor offset.
- `drawerBackgroundExtension` — set to 0.5 cm on the side facing a neighbouring trigger row (below for `expandUp=false`, above for `expandUp=true`), 0 at the column edge or in horizontal mode. Refreshed on add/remove and on the next expand/collapse event.
- `overrideWidth = true` / `width = groupWidth` *(stretch-to-fill only)* — the drawer matches the group column width, **unless the Dropdown has its own `Override Width` already enabled, in which case that custom width is preserved**. Note: when the drawer width differs from the group column width, the drawer's native background and the group's trigger-row segments won't align horizontally — this is an expected consequence of opting in.
- `hasTriggerBackground = true` / `showTriggerBackground = false` — the group renders the trigger-row background.

### Expand Direction

By default, dropdown drawers expand downward. Set `dropdown.expandUp = true` to expand upward instead. In vertical mode, the expand direction controls which margin (top or bottom) is animated and which side of the drawer the bridge extends into:

- **Expand down** (`expandUp = false`): the bottom margin of the dropdown's FlexItem grows, pushing items below it downward. The drawer's native background extends 0.5 cm downward into the next trigger row.
- **Expand up** (`expandUp = true`): the top margin grows, pushing items above it upward. The drawer's native background extends 0.5 cm upward into the previous trigger row.

### Expand Anchor

Each Dropdown has an `expandAnchor` property (`"Top"`, `"Center"`, or `"Bottom"`) that controls which edge stays fixed during expansion. This property works both standalone and inside an ElementGroup — see the [Dropdown README](../Dropdown/README.md#expand-anchor) for the full reference.

Inside an ElementGroup, the Dropdown delegates anchor handling to the group (`parentHandlesAnchor = true`). The ElementGroup computes a combined Y offset from all expanded dropdowns' anchor settings and applies it to the layout container, keeping the chosen edge of the group pinned in world space:

| Anchor | Behavior |
|--------|----------|
| Top | The top edge of the group stays fixed. The group grows downward. |
| Center | Growth is split equally — the group expands in both directions. |
| Bottom | The bottom edge of the group stays fixed. The group grows upward. |

```typescript
// Example: dropdown expands down, group stays pinned at the top
dropdown.expandUp = false
dropdown.expandAnchor = "Top"

// Example: dropdown expands up, group stays pinned at the bottom
dropdown.expandUp = true
dropdown.expandAnchor = "Bottom"
```

---

## Custom Content

ElementGroup is content-agnostic — drop in any SceneObject and the registered handler does the sizing. For arbitrary content with no recognized handler, attach a `FlexItem` and set `overrideWidth`/`overrideHeight` to declare the cell size explicitly.

```typescript
const cellObj = global.scene.createSceneObject("CustomCell")
const item = cellObj.createComponent(FlexItem.getTypeName()) as FlexItem
item.overrideWidth = 6
item.overrideHeight = 4
group.addItem(item, {stretchToFill: false})

// Attach any custom content as children of cellObj
const myMesh = global.scene.createSceneObject("MyMesh")
myMesh.setParent(cellObj)
```

---

## Cleanup

```typescript
group.destroy()
// Cleans up all subscriptions, cancels animations, and destroys
// the layout container and background segments.
```

---

## Important Notes

1. **Init-only properties** (direction, width, height, spacing) must be set before `OnStartEvent`. Changing them at runtime has no effect.

2. **Horizontal vs vertical:** In horizontal mode, dropdowns expand their drawers above or below the group — no background splitting or item shifting occurs. In vertical mode, the group actively manages drawer expansion with animated margins and splits its background into per-trigger-row segments (the drawer area is painted by the dropdown's own background).

3. **Dropdown trigger sizing:** When `addItem()` is called with `stretchToFill: true`, the group overrides the trigger button size to match the cell — in vertical mode the trigger width matches the group width; in horizontal mode the trigger height matches the group height. With `stretchToFill: false`, the trigger keeps its own size and is positioned within the cell using `alignment` and FlexItem margins; the dropdown's `triggerButtonSize`, `overrideWidth`, and `width` are left untouched.

4. **Item ordering:** Items appear in the order they are added via `addItem()`. For scene-based discovery, items are sorted by the `FlexItem.order` property.

5. **Removing items:** `removeItemAt()` cancels dropdown expansion subscriptions, detaches the item from the FlexLayout, and reparents the item's SceneObject back under the group SceneObject. The caller retains ownership and is responsible for destroying, hiding, or reparenting the item as needed. Call `addItem()` to re-insert into the layout.
