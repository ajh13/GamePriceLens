import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {LeafSingleHandInteractor} from "./handInput/LeafHandInteractor"
import {
  createTwoHandPinchBarrier,
  TwoHandPinchBarrier,
} from "Leaf.lspkg/Utils/common/TwoHandPinchBarrier"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"

/**
 * Detects when both hands drag the same interactable concurrently and
 * synchronizes their TriggerStart so IK reads a two-hand scale. Hands report in
 * before their first await, so a partner started in the same `Promise.all` is
 * visible by the time either reaches the pre-trigger point; a lone hand drags
 * normally.
 */
class TwoHandDragCoordinator {
  private readonly targets = new Map<HandType, Interactable>()
  private readonly triggered = new Set<HandType>()
  private barrier?: TwoHandPinchBarrier

  /** Called synchronously at drag start. */
  begin(hand: HandType, target: Interactable): void {
    this.targets.set(hand, target)
  }

  /**
   * Called right before TriggerStart. Returns immediately (solo) when the partner
   * isn't on the same target, or has already passed this point and won't meet us
   * at the barrier — e.g. it started its own drag earlier. Otherwise both hands
   * rendezvous at the shared {@link TwoHandPinchBarrier}, which also bakes in
   * the one-frame left-hand stagger so IK's per-frame triggering-interactor
   * cache sees both hands and `canScale()` passes.
   */
  async sync(hand: HandType, target: Interactable): Promise<void> {
    const other = hand === "right" ? "left" : "right"
    if (this.targets.get(other) !== target || this.triggered.has(other)) {
      this.triggered.add(hand)
      return
    }
    if (this.barrier === undefined) this.barrier = createTwoHandPinchBarrier()
    await this.barrier.wait(hand)
    this.triggered.add(hand)
  }

  /** Called when a drag ends; on error the barrier is released so a waiting partner doesn't hang. */
  end(hand: HandType, error?: unknown): void {
    if (error !== undefined) this.barrier?.abort(error)
    this.targets.delete(hand)
    this.triggered.delete(hand)
    if (this.targets.size === 0) this.barrier = undefined
  }
}

/**
 * A {@link LeafSingleHandInteractor} whose `drag` joins two-hand coordination
 * through a shared {@link TwoHandDragCoordinator}, then behaves like a normal
 * single-hand drag when no other hand is on the same target.
 */
class CoordinatedHand extends LeafSingleHandInteractor {
  constructor(
    handType: HandType,
    private readonly coordinator: TwoHandDragCoordinator,
  ) {
    super(handType)
  }

  // @override
  async drag(
    target: Interactable,
    dragVector: vec3,
    dragDurationMs: number,
    beforeTrigger?: () => Promise<void>,
    resetOnComplete: boolean = false,
  ): Promise<void> {
    // Register before the first await so a concurrently-started partner is seen.
    this.coordinator.begin(this.handType, target)
    const sync = async () => {
      await this.coordinator.sync(this.handType, target)
      if (beforeTrigger !== undefined) await beforeTrigger()
    }
    try {
      await super.drag(
        target,
        dragVector,
        dragDurationMs,
        sync,
        resetOnComplete,
      )
      this.coordinator.end(this.handType)
    } catch (error) {
      this.coordinator.end(this.handType, error)
      throw error
    }
  }
}

/**
 * The shared pair of hands, created once per scenario. Access it via {@link get}.
 *
 * Use `.left` / `.right` for single-hand drags. When both hands drag the same
 * interactable concurrently — via `Promise.all`, or the {@link drag} convenience
 * below — they are automatically synchronized into a two-hand scale; no special
 * call is required.
 *
 * @example
 * const hands = LeafTwoHandInteractor.get()
 * await hands.right.drag(planet, new vec3(-5, 5, 0), 2000) // single hand
 * await hands.drag(satellite, vec3.right(), vec3.left(), 1000) // two-hand scale
 */
export class LeafTwoHandInteractor {
  private static instance?: LeafTwoHandInteractor

  readonly left: LeafSingleHandInteractor
  readonly right: LeafSingleHandInteractor

  private constructor() {
    const coordinator = new TwoHandDragCoordinator()
    this.right = new CoordinatedHand("right", coordinator)
    this.left = new CoordinatedHand("left", coordinator)

    /* Scenario cleanup destroys both hands, which reverts their IK overrides.
     * Drop the cached instance so the next scenario builds working hands. */
    const clearCachedInstance = () => {
      LeafLifecycle.getInstance().onCleanup.remove(clearCachedInstance)
      LeafTwoHandInteractor.instance = undefined
    }
    LeafLifecycle.getInstance().onCleanup.add(clearCachedInstance)
  }

  /**
   * The shared two-hand interactor; created on first access and dropped at
   * scenario cleanup, which destroys the hands (IK properties restored, input
   * suppressor allow list cleared). Keeping the instance past that point would
   * hand the next scenario hands that no longer drive IK.
   */
  static get(): LeafTwoHandInteractor {
    if (LeafTwoHandInteractor.instance === undefined) {
      LeafTwoHandInteractor.instance = new LeafTwoHandInteractor()
      const unsubscribe = LeafLifecycle.getInstance().onCleanup.add(() => {
        unsubscribe()
        LeafTwoHandInteractor.instance = undefined
      })
    }
    return LeafTwoHandInteractor.instance
  }

  /**
   * Drags `target` with both hands at once — equivalent to starting `right.drag`
   * and `left.drag` concurrently.
   */
  async drag(
    target: Interactable,
    rightVector: vec3,
    leftVector: vec3,
    durationMs: number,
  ): Promise<void> {
    await Promise.all([
      this.right.drag(target, rightVector, durationMs),
      this.left.drag(target, leftVector, durationMs),
    ])
  }
}

/**
 * Convenience accessor for a single shared hand, backed by one shared
 * {@link LeafTwoHandInteractor}. The hand returned here is the same instance as
 * the corresponding `.left` / `.right` hand — within a scenario there is only ever
 * one left and one right hand, reachable either way.
 *
 * @example
 * await LeafHandInteractor.get("left").drag(planet, new vec3(-5, 5, 0), 2000)
 */
export class LeafHandInteractor {
  private constructor() {}

  static get(handType: HandType): LeafSingleHandInteractor {
    const hands = LeafTwoHandInteractor.get()
    return handType === "right" ? hands.right : hands.left
  }
}
