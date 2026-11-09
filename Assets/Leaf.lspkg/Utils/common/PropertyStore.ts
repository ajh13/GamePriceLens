import {Logger} from "./Logger"

const LOG = new Logger("PropertyManager")

/**
 * PropertyStore is a utility class used to save and restore property descriptors
 * Saves all property descriptors (including non-enumerable, accessors, and prototype chain)
 */
export class PropertyStore<T> {
  private savedDescriptors: Record<string | symbol, PropertyDescriptor> = {}

  constructor(private obj: T) {
    if (!obj || typeof obj !== "object") {
      throw new Error("PropertyManager requires an object to manage properties")
    }
    this.saveProperties()
  }

  private saveProperties() {
    let current = this.obj
    const seen = new Set<string | symbol>()
    while (current && current !== Object.prototype) {
      for (const key of [
        ...Object.getOwnPropertyNames(current),
        ...Object.getOwnPropertySymbols(current),
        ...Object.keys(current),
      ]) {
        if (!seen.has(key)) {
          seen.add(key)
          const desc = Object.getOwnPropertyDescriptor(current, key)
          if (desc) {
            this.savedDescriptors[key] = desc
          }
        }
      }
      // Also save the prototype properties
      current = Object.getPrototypeOf(current)
    }
  }

  /**
   * Restores all saved property descriptors (including accessors and methods)
   */
  resetProperties() {
    LOG.debug(
      `Restoring properties ${Object.keys(this.savedDescriptors)}`,
      false,
    )
    for (const [key, desc] of Object.entries(this.savedDescriptors)) {
      try {
        Object.defineProperty(this.obj, key, desc)
      } catch (e) {
        LOG.warn(`Failed to restore property: ${key} - ${e}`, false)
      }
    }
  }
}
