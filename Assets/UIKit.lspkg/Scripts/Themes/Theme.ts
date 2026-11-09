import {Style} from "./Style"

/** Canonical name of the 2.0 design system theme. */
export const SYSTEM_2_NAME = "System 2.0"

/** Canonical name of the 3.0 design system theme. */
export const SYSTEM_3_NAME = "System 3.0"

/** Serialized ComboBox value for the 2.0 theme. See THEME_NAME_ALIASES. */
export const SYSTEM_2_VALUE = "System2"

/** Serialized ComboBox value for the 3.0 theme. See THEME_NAME_ALIASES. */
export const SYSTEM_3_VALUE = "System3"

/**
 * Every spelling of a theme that can reach us from serialized data or a call
 * site, mapped to its canonical name. Two groups:
 *
 * - `System2`/`System3` — the identifier form used as the ComboBox *value* (the
 *   label stays "System 2.0"/"System 3.0"). Lens Studio cannot store a value
 *   containing a space in a `.ts.meta` `DefaultScriptInputs` block: it sanitizes
 *   it to an identifier, which then matches no entry in the option list and the
 *   Inspector renders the dropdown blank. Keeping values identifier-safe avoids
 *   that, and matches the convention used elsewhere in the package
 *   (`ComboBoxItem("Row Reverse", "rowReverse")`).
 * - `SnapOS2`/`SnapOS3` — the names that shipped before this rename, so
 *   pre-rename scenes and `setTheme("SnapOS3")` calls keep resolving.
 */
export const THEME_NAME_ALIASES: Record<string, string> = {
  [SYSTEM_2_VALUE]: SYSTEM_2_NAME,
  [SYSTEM_3_VALUE]: SYSTEM_3_NAME,
  SnapOS2: SYSTEM_2_NAME,
  SnapOS3: SYSTEM_3_NAME
}

/**
 * Resolves any accepted theme spelling to its canonical name. Unknown names
 * pass through untouched so callers can still fail on a genuine typo.
 */
export function normalizeThemeName(name: string): string {
  return THEME_NAME_ALIASES[name] ?? name
}

export type Theme = {
  get styles(): Record<string, Record<string, Style>>
  get name(): string
  get defaultStyleName(): string
  get defaultShapeName(): string
  get componentData(): Record<string, unknown>
}
