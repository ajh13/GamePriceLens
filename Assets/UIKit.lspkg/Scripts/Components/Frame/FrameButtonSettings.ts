// Shared per-appearance sizing for frame buttons. ButtonHandler (close,
// classic follow) and RightDrawer (System3 follow + custom items) both
// reference these so a designer can tune button + icon sizing in one place
// and the two paths can't drift.
import {FrameAppearance} from "./Frame"

export type FrameButtonSettings = {
  buttonSize: number
  iconSize: number
  /** Inset value passed to FrameVisual.getButtonAnchor (only used by classic RR visual). */
  offset: number
}

export const FRAME_BUTTON_SETTINGS_BY_APPEARANCE: Record<FrameAppearance, FrameButtonSettings> = {
  Large: {
    buttonSize: 3.75,
    iconSize: 2,
    offset: 0.75
  },
  Small: {
    buttonSize: 2.25,
    iconSize: 1.15,
    offset: 0.375
  }
}
