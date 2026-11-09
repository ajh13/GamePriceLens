import {OpacityControllable} from "./OpacityControllable"

/**
 * Explicit visibility axes. Visibility is not one boolean: opacity,
 * renderability, and hit-testing are independent axes that only move together
 * when the caller says so. Omitted axes are left untouched.
 *
 * `setVisibility` is a cold-path configuration call; the object payload is
 * acceptable there. Per-frame opacity animation should keep using the scalar
 * `opacity` setter inherited from OpacityControllable.
 */
export type VisibilityState = {
  opacity: number
  renderableEnabled?: boolean
  colliderEnabled?: boolean
  interactableEnabled?: boolean
}

/**
 * Implemented by components that can apply visibility axes beyond opacity.
 * Setting `opacity` to zero never implicitly changes renderable, collider, or
 * interactable state — those change only via an explicit `setVisibility` call.
 */
export interface VisibilityControllable extends OpacityControllable {
  setVisibility(state: VisibilityState): void
}
