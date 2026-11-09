import {Singleton} from "InteractionKit.lspkg/Decorators/Singleton"
import {System2} from "./System-2.0/System2"
import {System3} from "./System-3.0/System3"
import {normalizeThemeName, Theme} from "./Theme"

/**
 * Global registry and source of truth for active UI theme resolution.
 * ThemeManager can set the startup value, but all consumers read from here.
 */
@Singleton
export class ThemeService {
  public static getInstance: () => ThemeService

  private _currentTheme: Theme = System3
  private _themes: Map<string, Theme> = new Map()

  public constructor() {
    this.registerTheme(System2)
    this.registerTheme(System3)
  }

  public get currentTheme(): Theme {
    return this._currentTheme
  }

  /**
   * Sets the active theme used by runtime style lookups.
   * Note: This only affects visuals created after the theme is set.
   * Existing visuals are not dynamically updated. It is recommended
   * to only set the theme at startup.
   */
  public setTheme(theme: Theme): void {
    this._currentTheme = theme
  }

  public registerTheme(theme: Theme): void {
    this._themes.set(theme.name, theme)
  }

  /**
   * Looks up a registered theme by name. Pre-rename names ("SnapOS2"/"SnapOS3")
   * are normalized first, so scenes and call sites written before the
   * System 2.0/3.0 rename keep resolving.
   */
  public getTheme(name: string): Theme | undefined {
    return this._themes.get(normalizeThemeName(name))
  }
}
