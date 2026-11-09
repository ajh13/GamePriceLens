// ═══════════════════════════════════════════════════════════════════════════
// UIKitBootstrap.ts — side-effect imports for UIKit's Layout2D handlers.
//
// Importing this file (for side effects only) registers all UIKit-specific
// Layout2D ItemHandlers onto the shared `ItemHandlerRegistry`. Native
// handlers (Text, Image, BaseMeshVisual, ScreenTransform, BoxCollider, etc.)
// register from `Layout2D/ItemHandlerRegistry.ts` itself. UIKit-side
// handlers (Element, Shape, LayoutContainer, StandaloneContent, and the
// CustomFlexContainer adapter) register here.
//
// Every UIKit-side class that may sit *next to* a `LayoutItem2D` in a scene
// should `import "../UIKitBootstrap"` (path adjusted to file location) so
// the handler set is on the registry before the layout engine first
// resolves an item. Currently wired from:
//   - Components/Element.ts                  (covers Element, VisualElement,
//                                             BaseButton, Slider, TextInput,
//                                             and everything that extends them)
//   - Components/Frame/Frame.ts              (Frame doesn't extend Element)
//   - Components/ScrollWindow/ScrollWindow.ts
//   - Components/ProgressBar/ProgressBar.ts
//   - Components/Loaders/Spinner/Spinner.ts
//   - Components/Content/ElementContent.ts
//   - Visuals/Shape.ts                       (Shape doesn't extend Element)
//
// LayoutItem2D no longer imports UIKitItemHandlers directly — that decouples
// Layout2D from UIKit and lets a future engine-relocated Layout2D ship
// without dragging UIKit code along. Apps using Layout2D outside UIKit
// don't pay for handlers they don't need.
// ═══════════════════════════════════════════════════════════════════════════

import "./Components/Layout2D/UIKitItemHandlers"
