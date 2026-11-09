# UIKit troubleshooting

[← Agent usage index](../README.md)

## Use when

Use this table for package-specific failures. Generic Lens scripting, scene
placement, rendering, and TypeScript issues belong to the relevant CLAD skill.

## Known limitations

| Symptom | Package cause | Package fix |
|---|---|---|
| Import under `UIKit.lspkg/` is unresolved | Invented or obsolete module path — commonly the `Scripts/` root dropped because IK's prefix is rootless while UIKit's is not | Use the `UIKit.lspkg/Scripts/` prefix from [components.md](components.md) and the installed declarations |
| A vertical ScrollBar draws sideways | A bar always draws along its object's X axis; `orientation` only picks the window axis it follows | Rotate the bar's object 90 degrees about Z |
| A ScrollBar shows nothing and never scrolls | It has no window: `scrollWindow` isn't wired and `setScrollWindow` wasn't called, or it was called after the bar built | Call `setScrollWindow` before the bar starts, or wire `scrollWindow` in the Inspector. Don't write the private input from code |
| Dropdown does not open on tap (no log) | The item set is empty — expand no-ops when item count is 0 | Populate `setData` with a non-empty list before wiring `onItemTapped` |
| Another script cannot reach a control's `onTriggerUp` / a controller's handler never fires | UIKit events are not on `host.getComponents(...).api`; and the Interactable registers in its own `onAwake`, which runs after a peer script's `onStart` | Get the live Interactable via IK's `InteractionManager` (look it up by scene object) and read its trigger/hover events; if the lookup returns null, retry from `onUpdate` for 1–2 frames; it matches the exact node, so walk the subtree when the Interactable sits on a child. These are InteractionKit APIs — confirm the exact accessor and event names against IK's own docs |
| Scroll rows show black jagged noise or darkened edges | `ScrollWindow.edgeFade` (default off) paints a fade toward `edgeFadeColor` (defaults to `vec3(32/255, 32/255, 32/255)`, a near-black gray) with a depth-biased mesh band; over light content whose color it does not match, that band reads as darkened/jagged edges | Leave `edgeFade` off for opaque light content, or set `edgeFadeColor` to match your backing panel; stencil clipping to the window still works without it |
| A selected/toggled row renders blank or white | Only `defaultGradient`/`hoveredGradient` were tinted; the toggled states still use the (often translucent) theme gradient | Also set `toggledDefaultGradient`/`toggledHoveredGradient`/`toggledTriggeredGradient`, or freeze the face with `shouldColorChange = false` plus a solid fill |
| Typed text never appears in a TextInputField in Preview | Current Preview simulation may not route TextInputSystem keystrokes to the field | Not a wiring bug — test on device (or a Preview mode that routes keystrokes); confirm against your device and Lens Studio version |
| Button shape/style is ignored | Variant applied after initialization or without a concrete theme | Call `setVariant({theme, shape, style})` before `initialize()` |
| Calling `initialize()` is a private-access error | Component is self-initializing | Configure public properties and use replaying `onInitialized` |
| Widget label is absent | ElementContent is on another SceneObject or duplicated | Add one ElementContent to the widget's SceneObject after initialization |
| Programmatic toggle causes side effects | `isOn` and `toggle` emit value events | Set initial state before handlers or guard synchronization |
| Slider fights a programmatic update while dragging | Application writes during `onKnobMoved` interaction | Pause external writes until committed `onValueChange`; use `resetToValue` for silent sync. Write from `onKnobMoved` only while `isDragging`, and also from `onValueChange`: taps, Switch toggles and release commits arrive there |
| Dropdown starts open | `startExpanded` was left at this revision's default | Set `startExpanded = false` before self-initialization |
| Dropdown selection callback lacks expected state | Pool mode uses item-tap/index APIs | Use `onItemTapped` and `getSelectedIndices()` |
| Dropdown width assignment has no effect | Direct `width` is intentionally not its config path | Set `overrideWidth`, then call `configureWidth` during creation |
| Layout children remain at one point or measure zero | Child lacks matching FlexItem/GridItem | Add the matching item component and explicit spacer constraints |
| Layout change appears one frame late | Layout2D batches updates | Use its completion event or documented refresh/force method |
| Nested grid collapses an `fr` track | Parent measures it on an indefinite axis | Use definite tracks and wrapper-item size constraints |
| First implicit grid row collapses | Default explicit `templateRows` still exists | Clear `templateRows` when `autoRows` owns every row |
| Scroll content is unmasked or stationary | Content was parented directly | Initialize ScrollWindow, then attach only with `addObject` |
| Scroll viewport ignores its Flex/Grid slot | ScrollWindow's generated ScreenTransform competes with layout | Put ScrollWindow on a child of a plain layout-item wrapper |
| New scroll rows cannot be targeted | Managed collider cache was not refreshed | Recompute and assign `scrollDimensions` after content changes |
| Frame distorts code-sized content | `autoScaleContent` scales authored content behavior | Set `autoScaleContent = false` and size from completed layout |
| Frame resize handle changes chrome but not contents | Scaling enabled without reflow | Disable `allowScaling` or implement `onSizeChanged` reflow |
| A control with its collider turned off takes input again | Re-enabling it or an ancestor, Frame, or ScrollWindow turned the collider back on | Set `inputPaused = true` instead; it survives re-enables |
| Switch inside a scroller fires on a scroll gesture | `onFinished` is unsuitable for this composition | Subscribe to `onValueChange` |
| Switch loses initial state | State was assigned before initialization | Assign initial `isOn` after `initialize`, before handlers |
| TextInputArea Return does not submit | Return inserts a newline by design | Provide a separate submit control |
| Text input keyboard does not open | Component initialized while disabled or required IK/input setup is absent | Create it enabled and use `onInitialized`; verify package prerequisites |
| Virtualized row handler fires repeatedly | Handler subscribed during `onBindView` | Subscribe once in `onCreateView` and update holder state during bind |
| Clipping fails with many scroll/dropdown regions | Too many concurrently enabled masks — Lens Studio caps how many render at once (engine limit); each ScrollWindow/Dropdown consumes one | Consolidate or virtualize masked regions |

## Verification

After applying a fix, reproduce it in Preview and confirm both visuals and
interaction. If behavior differs from this installed guide, record the package
version and update the package docs with the API change.
