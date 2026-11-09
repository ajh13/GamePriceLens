import type {ContentMeasurement} from "./ItemHandlerRegistry"

/** A local presentation prepared by a component, validated again after any queue wait. */
export interface PresentationRequest {
  isCurrent(): boolean
  /** Supplies prospective measurements before the owner tree is preflighted. */
  prepare?(preparation: LayoutPreparation): void
  commit(): void
  /** Runs once after the entire owner chain has settled, including queued commits. */
  complete?(): void
}

const MAX_OWNER_DEPTH = 8
const MAX_QUEUED_COMMITS = 8

/** Measurement-only scope. Geometry, callbacks, and layout retry state remain untouched. */
export class LayoutPreparation {
  public static current: LayoutPreparation | null = null
  public readonly measurements = new Map<object, ContentMeasurement>()
  public readonly owners = new Set<LayoutPresentation>()
  public pending = false
  private readonly active = new Set<object>()

  public visit<T>(owner: object, measure: () => T, fallback: T): T {
    if (this.active.has(owner) || this.active.size >= MAX_OWNER_DEPTH) {
      this.pending = true
      return fallback
    }
    this.active.add(owner)
    try {
      return measure()
    } finally {
      this.active.delete(owner)
    }
  }
}

/**
 * Locks an owner chain, preflights proposed geometry, then commits and settles
 * from the outermost owner inward. Pending probes leave the presentation intact.
 */
export class LayoutPresentation {
  private static readonly pending = new Set<LayoutPresentation>()
  private static draining = false
  private readonly queue: {origin: LayoutPresentation; request: PresentationRequest}[] = []
  private presenting = false
  private destroyed = false

  public constructor(
    private readonly parent: () => LayoutPresentation | null,
    private readonly layoutBusy: () => boolean,
    private readonly settle: () => void,
    private readonly schedule: () => void,
    private readonly prepare: () => void = () => {}
  ) {}

  public present(request: PresentationRequest): "completed" | "queued" {
    if (this.destroyed) return "completed"
    const chain: LayoutPresentation[] = [this]
    const visited = new Set<LayoutPresentation>(chain)
    let owner = this.parent()
    while (owner) {
      // An invalid/over-deep chain must never expose a partially settled label.
      // The component retains its staged request and bounded retry lifecycle.
      if (visited.has(owner) || chain.length === MAX_OWNER_DEPTH || owner.destroyed) return "queued"
      visited.add(owner)
      chain.push(owner)
      owner = owner.parent()
    }
    const busy = chain.find((entry) => entry.presenting || entry.layoutBusy())
    if (busy) {
      busy.queue.push({origin: this, request})
      LayoutPresentation.pending.add(busy)
      return "queued"
    }
    for (const entry of chain) entry.presenting = true
    try {
      if (!request.isCurrent() || chain.some((entry) => entry.destroyed)) return "completed"
      const settling = [...chain].reverse()
      if (request.prepare) {
        const preparation = new LayoutPreparation()
        const previous = LayoutPreparation.current
        LayoutPreparation.current = preparation
        try {
          request.prepare(preparation)
          chain[chain.length - 1].prepare()
        } finally {
          LayoutPreparation.current = previous
        }
        if (preparation.pending) return "queued"
        for (const entry of preparation.owners) {
          if (entry.destroyed) return "completed"
          if (!chain.includes(entry) && (entry.presenting || entry.layoutBusy())) return "queued"
        }
        for (const entry of preparation.owners) {
          if (!chain.includes(entry)) {
            chain.push(entry)
            entry.presenting = true
          }
          if (!settling.includes(entry)) settling.push(entry)
        }
        if (!request.isCurrent() || chain.some((entry) => entry.destroyed)) return "completed"
      }
      request.commit()
      for (const entry of settling) {
        if (chain.some((owner) => owner.destroyed)) return "completed"
        entry.settle()
      }
      if (!chain.some((entry) => entry.destroyed)) request.complete?.()
    } finally {
      for (const entry of chain) entry.presenting = false
      this.drain()
    }
    return "completed"
  }

  /** One shared drain budget: callbacks cannot restart it by entering another owner. */
  public drain(): void {
    if (LayoutPresentation.draining || LayoutPresentation.pending.size === 0) return
    LayoutPresentation.draining = true
    try {
      for (let count = 0; count < MAX_QUEUED_COMMITS; count++) {
        const next = Array.from(LayoutPresentation.pending).find((entry) => !entry.presenting && !entry.layoutBusy())
        if (!next) break
        const queued = next.queue.shift()!
        if (next.queue.length === 0) LayoutPresentation.pending.delete(next)
        queued.origin.present(queued.request)
      }
    } finally {
      LayoutPresentation.draining = false
      for (const entry of LayoutPresentation.pending) {
        if (!entry.presenting && !entry.layoutBusy()) entry.schedule()
      }
    }
  }

  public dispose(): void {
    this.destroyed = true
    this.queue.length = 0
    LayoutPresentation.pending.delete(this)
    // Requests can be waiting on an ancestor rather than on their origin.
    for (const entry of LayoutPresentation.pending) {
      for (let i = entry.queue.length - 1; i >= 0; i--) {
        if (entry.queue[i].origin === this) entry.queue.splice(i, 1)
      }
      if (entry.queue.length === 0) LayoutPresentation.pending.delete(entry)
    }
  }
}
