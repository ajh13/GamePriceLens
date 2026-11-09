import {BodyPose} from "Leaf.lspkg/IKSolver/BodyController"
import {JointPose} from "Leaf.lspkg/IKSolver/Pose"
import {IKHandInteractor} from "../IKHandInteractor"

/**
 * Configs supplied by {@link IKBodyInteractor} when it finishes wiring
 * itself up. Everything that depends on the body interactor's own
 * setup (currently just the owning hands) flows through here.
 */
export type AvatarCreateConfig = {
  /**
   * The owning hand interactors. The visualizer may share its skin
   * material with their visuals, layer them onto a debug overlay,
   * or otherwise customize them.
   */
  hands?: {left: IKHandInteractor; right: IKHandInteractor}
}

/**
 * Per-frame avatar driver. Plugs into {@link IKBodyInteractor} so the
 * interactor itself stays generic — it doesn't know whether the avatar
 * is a Bitmoji rig, a custom mesh, or anything else.
 *
 * Lifecycle:
 * - Construct via a rig-specific factory (e.g. `createBitmojiAvatar`).
 *   Rig-specific config (debug overlay layer, skin material policy,
 *   etc.) goes to the factory, not through this interface.
 * - Pass to `IKBodyInteractor`'s `avatarVisualizer` option.
 * - The interactor calls {@link create} once with the owning hands,
 *   then {@link apply} every LateUpdate with the latest IK `BodyPose`,
 *   reads {@link idleWristPoses} per frame to park the IK hands, and
 *   calls {@link destroy} during teardown.
 */
export interface AvatarVisualizer {
  /**
   * Finish initialization with body-interactor-derived configs and
   * resolve when the rig is fully ready (loaded, configs applied).
   *
   * @param config - Owning hands forwarded from the body interactor;
   *   used by the visualizer to layer / theme the IK hand meshes.
   * @returns Promise that resolves when the avatar is loaded and its
   *   joints are addressable.
   */
  create(config: AvatarCreateConfig): Promise<void>

  /**
   * Apply a body pose to the avatar's bones. Called once per frame from
   * `IKBodyInteractor`'s LateUpdate handler, after the engine's animation
   * pass has run so writes here override any base idle animation on the
   * IK-driven joints.
   *
   * @param pose - Latest IK-driven body pose.
   */
  apply(pose: BodyPose): void

  /**
   * The avatar's current wrist poses, used by {@link IKBodyInteractor}
   * to park IK hands on the avatar's idle animation when IK isn't
   * actively driving them. Called every frame.
   *
   * @returns Both wrists in world space. Per-side `undefined` while the
   *   rig isn't ready or for sides this rig doesn't drive.
   */
  idleWristPoses(): {left?: JointPose; right?: JointPose}

  /** Release all listeners and resources. Idempotent. */
  destroy(): void
}
