import {HandMeshType} from "InteractionKit.lspkg/Components/Interaction/HandVisual/HandVisual"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {HandVisuals} from "InteractionKit.lspkg/Providers/HandInputData/HandVisuals"
import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import {IK} from "InteractionKit.lspkg/IK"
import {DEG_TO_RAD} from "Leaf.lspkg/Utils/common/Constants"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {nextFrame} from "Leaf.lspkg/Utils/common/Utils"

const LOG = new Logger("HandRig")

const HAND_TYPES: readonly HandType[] = ["left", "right"]

/** Budget for IK's asynchronous hand-rig load, observed to land in ~1.5s. */
const RIG_LOAD_TIMEOUT_MS = 2000

/** A loaded IK hand rig: the visuals component plus its rig root. */
export type HandRig = {
  visuals: HandVisuals
  root: SceneObject
}

/* SIK 3's rig prefab root is rotated -90° about X from the SIK 2 hand model. */
const RIG_ROOT_OFFSET = quat.fromEulerAngles(-90 * DEG_TO_RAD, 0, 0)

/**
 * The rig-root world rotation that orients the hand as `rotation` did on the
 * SIK 2 hand model, which LEAF's hand rotations are authored against.
 */
export function rigRootRotation(rotation: quat): quat {
  return rotation.multiply(RIG_ROOT_OFFSET)
}

/** Mesh types that {@link requestHandRig} replaced, for {@link restoreHandRigs}. */
const overriddenMeshTypes = new Map<HandVisuals, HandMeshType>()

/* IK 3 loads the rig and the Full mesh in separate asynchronous stages. */
function isRigLoaded(visuals: HandVisuals | undefined): boolean {
  return !isNull(visuals?.root) && !isNull(visuals?.handMeshFull)
}

/**
 * Starts IK's hand-rig load, returning the visuals, or `undefined` when the
 * lens has no HandVisual for the hand.
 *
 * Idempotent. A lazily-exposed rig populates `root` and the joint accessors
 * only once something asks for the Full mesh. An eager one keeps the lens's
 * own mesh choice.
 */
export function requestHandRig(
  trackedHand: TrackedHand,
): HandVisuals | undefined {
  const visuals = trackedHand.getHandVisuals()
  if (visuals === null || isNull(visuals)) {
    return undefined
  }
  if (!isRigLoaded(visuals) && visuals.meshType !== HandMeshType.Full) {
    if (!overriddenMeshTypes.has(visuals)) {
      overriddenMeshTypes.set(visuals, visuals.meshType)
    }
    visuals.meshType = HandMeshType.Full
  }
  return visuals
}

/** Starts the rig load for both hands without waiting on it. */
export function warmHandRigs(): void {
  for (const handType of HAND_TYPES) {
    requestHandRig(IK.HandInputData.getHand(handType))
  }
}

/**
 * Reverts the mesh types {@link requestHandRig} switched to Full, which in IK 3
 * unloads the rig again. Call once hand interactors have been cleaned up.
 */
export function restoreHandRigs(): void {
  for (const [visuals, meshType] of overriddenMeshTypes) {
    if (!isNull(visuals) && visuals.meshType === HandMeshType.Full) {
      visuals.meshType = meshType
    }
  }
  overriddenMeshTypes.clear()
}

/**
 * The loaded rig for a hand, for callers that cannot await the load.
 *
 * @throws when the lens has no HandVisual for the hand, or the rig is still loading.
 */
export function requireHandRig(
  trackedHand: TrackedHand,
  handType: HandType,
): HandRig {
  const visuals = requestHandRig(trackedHand)
  if (visuals === undefined) {
    throw new Error(
      `IK "${handType}" hand has no HandVisuals. Add IK's hand prefab (or a HandVisual component for this hand) to the scene.`,
    )
  }
  const root = visuals.root
  if (root === undefined || !isRigLoaded(visuals)) {
    const missing = isNull(root) ? "root" : "handMeshFull"
    throw new Error(
      `IK "${handType}" hand rig has not loaded (HandVisuals.${missing} is undefined). LEAF has requested it. Build the interactor from the scenario's run() so LEAF can await the load, or re-run the scenario.`,
    )
  }
  return {visuals, root}
}

/**
 * Requests both hand rigs and resolves once they have loaded, without waiting
 * when they already are. Hands with no HandVisual are skipped.
 *
 * Missing {@link RIG_LOAD_TIMEOUT_MS} only warns, so a scenario that never
 * touches hands cannot fail over it. {@link requireHandRig} reports it instead.
 */
export async function settleHandRigs(
  timeoutMs: number = RIG_LOAD_TIMEOUT_MS,
): Promise<void> {
  const pending = HAND_TYPES.map((handType) => ({
    handType,
    visuals: requestHandRig(IK.HandInputData.getHand(handType)),
  })).filter((hand) => hand.visuals !== undefined && !isRigLoaded(hand.visuals))

  if (pending.length === 0) {
    return
  }

  const deadline = getTime() + timeoutMs / 1000
  while (getTime() < deadline) {
    await nextFrame()
    if (pending.every((hand) => isRigLoaded(hand.visuals))) {
      return
    }
  }

  const stalled = pending
    .filter((hand) => !isRigLoaded(hand.visuals))
    .map((hand) => `"${hand.handType}"`)
  LOG.warn(
    `IK hand rig did not load within ${timeoutMs}ms for ${stalled.join(", ")}. Hand interactors for these hands will fail to build.`,
    false,
  )
}
