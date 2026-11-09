import {System2} from "./System-2.0/System2"
import {System3} from "./System-3.0/System3"
import {normalizeThemeName, SYSTEM_2_NAME} from "./Theme"
import {ThemeService} from "./ThemeService"

/**
 * Scene-level bootstrap component for selecting the initial global UI theme.
 * If this component is absent, ThemeService falls back to System3.
 */
@component
export class ThemeManager extends BaseScriptComponent {
  @input
  @widget(new ComboBoxWidget([new ComboBoxItem("System 2.0", "System2"), new ComboBoxItem("System 3.0", "System3")]))
  private _theme: string = "System3"

  public onAwake() {
    // ThemeService remains the runtime source of truth after this initial set.
    const mgr = ThemeService.getInstance()
    // Normalized so a scene serialized before the rename ("SnapOS2") still
    // selects the right theme instead of silently falling through to 3.0.
    switch (normalizeThemeName(this._theme)) {
      case SYSTEM_2_NAME:
        mgr.setTheme(System2)
        break
      default:
        mgr.setTheme(System3)
        break
    }
  }
}
