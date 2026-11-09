# UIKit minimal examples

[← Agent usage index](../README.md)

## Use when

Copy only the smallest example that establishes the package lifecycle. Compose
larger experiences with CLAD's planning, scripting, scene, and spatial-design
skills rather than treating this file as an application template.

## Button

```ts
import {Button} from "UIKit.lspkg/Scripts/Components/Button/Button"
import {addContentToElement} from "UIKit.lspkg/Scripts/Components/Content/ElementContentFactory"
import {createChildSceneObjectWithParentLayer} from "UIKit.lspkg/Scripts/Utility/SceneUtilities"

function createContinueButton(parent: SceneObject, onTrigger: () => void): Button {
  // Inherit the parent's render layer, or a custom UI camera layer can leave
  // the generated control invisible.
  const object = createChildSceneObjectWithParentLayer("ContinueButton", parent)

  const button = object.createComponent(Button.getTypeName()) as Button
  button.setVariant({theme: "System3", shape: "Rectangle", style: "Primary"})
  button.size = new vec3(8, 3, 1)
  button.initialize()
  addContentToElement(object, {text: "Continue"})
  button.onTriggerUp.add(onTrigger)
  return button
}
```

## Switch with initial state

```ts
import {Switch} from "UIKit.lspkg/Scripts/Components/Switch/Switch"

function createSwitch(object: SceneObject, initialValue: boolean, onChange: (value: boolean) => void): Switch {
  const control = object.createComponent(Switch.getTypeName()) as Switch
  control.setThemeOverride("System3")
  control.initialize()
  control.isOn = initialValue
  control.onValueChange.add((value) => onChange(value === 1))
  return control
}
```

Initial state is assigned before the handler because programmatic toggle writes
emit value events.

## ScrollWindow

```ts
import {ScrollWindow} from "UIKit.lspkg/Scripts/Components/ScrollWindow/ScrollWindow"

function createScrollWindow(scrollObject: SceneObject, contentObject: SceneObject, contentHeight: number): ScrollWindow {
  const scroll = scrollObject.createComponent(ScrollWindow.getTypeName()) as ScrollWindow
  // `contentOrigin` is init-only: set it before initialize() (accepts
  // "Center" or "TopLeft"); assigning after init is ignored with a warning.
  scroll.contentOrigin = "TopLeft"
  scroll.windowSize = new vec2(22, 18)
  scroll.initialize()
  scroll.addObject(contentObject)
  scroll.scrollDimensions = new vec2(22, contentHeight)
  return scroll
}
```

Inside Flex/Grid, put `scrollObject` under a plain wrapper that owns the
FlexItem/GridItem.

## Text input

```ts
import {TextInputField} from "UIKit.lspkg/Scripts/Components/TextInputField/TextInputField"

function createNameField(object: SceneObject, onSubmit: (text: string) => void): TextInputField {
  const field = object.createComponent(TextInputField.getTypeName()) as TextInputField
  field.placeholderText = "Name"
  field.actionSlot = "none"
  field.onInitialized.add(() => {
    field.fontSize = 44
    field.onReturnKeyPressed.add(onSubmit)
  })
  return field
}
```

## Panel layout with Flex (the right way to arrange elements)

Arrange a panel's header / body / footer and every row through `FlexLayout` +
`FlexItem` — **never** by hand-setting each child's `localPosition` from
panel half-width/height. Pattern: a vertical column, each section a `FlexItem`;
rows are nested `FlexLayout`s; `justifyContent`/`alignItems` place children;
`alignSelf` handles per-item exceptions (e.g. a chat bubble on the left vs right).

```ts
import {FlexLayout} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import {FlexItem} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import {FlexDirection, FlexJustify, FlexAlign, FlexAlignSelf}
  from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import {createChildSceneObjectWithParentLayer} from "UIKit.lspkg/Scripts/Utility/SceneUtilities"

// `root` is a scene-authored host SceneObject that carries the panel backing.
// Create children with createChildSceneObjectWithParentLayer so they inherit
// root's render layer; raw createSceneObject can render invisible under a
// custom UI camera layer.
function layoutPanel(root: SceneObject, w: number, h: number) {
  const col = root.createComponent(FlexLayout.getTypeName()) as FlexLayout
  col.direction = FlexDirection.Column
  col.width = w; col.height = h
  col.justifyContent = FlexJustify.Start
  col.alignItems = FlexAlign.Stretch      // sections fill the panel width
  col.rowGap = 1

  // Header row: title left, close button right — SpaceBetween, NOT X offsets
  const header = createChildSceneObjectWithParentLayer("Header", root)
  const hItem = header.createComponent(FlexItem.getTypeName()) as FlexItem
  hItem.overrideHeight = 5; hItem.flexShrink = 0
  const hRow = header.createComponent(FlexLayout.getTypeName()) as FlexLayout
  hRow.direction = FlexDirection.Row
  hRow.justifyContent = FlexJustify.SpaceBetween
  hRow.alignItems = FlexAlign.Center
  // …parent a title object and a close-button object under `header`; each gets a FlexItem…

  // Body grows to fill remaining height
  const body = createChildSceneObjectWithParentLayer("Body", root)
  const bItem = body.createComponent(FlexItem.getTypeName()) as FlexItem
  bItem.flexGrow = 1
  // …a ScrollWindow (on a plain wrapper) or a Flex column of rows lives under `body`…

  col.refreshChildren()
}

// Per-item exception: push one item to an edge without absolute positioning.
function alignBubble(bubbleItem: FlexItem, isSent: boolean) {
  bubbleItem.alignSelf = isSent ? FlexAlignSelf.End : FlexAlignSelf.Start
}
```

Give every managed child a `FlexItem`; size sections with `overrideHeight`/
`flexGrow`, not positions. See [layout](layout.md) for cross-axis stretch,
`refreshChildren()` after adding rows, and the single `+Z` depth offset for
stacked coplanar surfaces (set once on the layer root, not staggered per level).

## Verification

Compile each adapted example against the installed package. Then run Preview
with IK scene setup and exercise the interaction. Compilation alone does not
verify generated visuals, layout timing, or events.
