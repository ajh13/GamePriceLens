# UIKit

UIKit is a package of components, utilities, and assets for building
interactive spatial interfaces in Lens Studio. It depends on
InteractionKit (IK) for targeting and interaction.

## Documentation and API reference

- [Get Started Guide](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-ui-kit/get-started)
- [Release Notes](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-ui-kit/release-notes)

## Usage

This section ships with the package and describes the exact installed revision.
Read it, then follow the links into `Docs/` for the topic you need. It is
written for both people and coding agents; generic Lens scripting, scene
construction, and spatial design live in the CLAD skills, not here.

### Package identity

- Package descriptor: `UIKit/package.native`
- Consumer import prefix: `UIKit.lspkg/Scripts/` — unlike IK, UIKit
  modules live under `Scripts/`, so `UIKit.lspkg/<module>` without it
  does not resolve. See [components](Docs/components.md) for the exact paths.
- Required companion packages: `InteractionKit`, `Icons`, and
  `Motion`

### Version and API status

This README and `Docs/` ship in the package archive and describe that exact
installed revision. Read [API status](Docs/api-status.md) before using an
older example. It identifies Current, Deprecated, Experimental, Removed, and
Internal surfaces. Human release history is in the
[Release Notes](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-ui-kit/release-notes).

### Applicability

Use UIKit for visual controls, panels, text entry, layout, scrolling,
dialogs, and themed spatial UI. Use IK directly for interaction infrastructure,
interactors, manipulation, and non-visual interaction behavior.

### Package Docs (ship in `Docs/`)

The documents below ship inside the package. Lens Studio installs packages
**packed**, but on import it auto-extracts the package files into the project's
install Cache, so an agent can read these `Docs/` there without a manual unpack
(or read them from the package source). This README is additionally readable
before import via `ListInstalledPackagesTool`, which is why it serves as the
index. Treat only documented public members as supported API: never guess an
import path or reach into a private/protected field. Application architecture and
full screen composition come from the calling CLAD workflow, not these docs.

- [cheat sheet](Docs/cheat-sheet.md) - load-bearing invariants; read first, re-read before building
- [components](Docs/components.md) - public modules, import paths, and events
- [lifecycle](Docs/lifecycle.md) - create / configure / initialize contracts
- [layout](Docs/layout.md) - Flex/Grid, Frame, ScrollWindow, VirtualizedLayout
- [content and theme](Docs/content-theme.md) - ElementContent, theme, typography, icons, colors
- [API status](Docs/api-status.md) - Current / Deprecated / Experimental / Removed / Internal; check before reusing an older example
- [minimal examples](Docs/examples.md) - package lifecycle and imports only
- [troubleshooting](Docs/troubleshooting.md) - package-specific symptoms and fixes; read before adding a workaround

### Verification

1. Compile the Lens and resolve every TypeScript error without `as any` or
   private-field access.
2. Run Preview with the IK prerequisite from its installed README.
3. Exercise every UIKit event and state transition used by the screen.
4. Confirm generated content and layout after initialization; compile success
   alone is insufficient.
