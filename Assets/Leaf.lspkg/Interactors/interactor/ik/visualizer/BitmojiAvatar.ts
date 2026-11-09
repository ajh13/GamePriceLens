import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {BodyPose} from "Leaf.lspkg/IKSolver/BodyController"
import {safeNormalize} from "Leaf.lspkg/IKSolver/MathUtils"
import {JointPose, Side} from "Leaf.lspkg/IKSolver/Pose"
import {DefaultLeafInteractor} from "../../DefaultLeafInteractor"
import {AvatarCreateConfig, AvatarVisualizer} from "./AvatarVisualizer"
import {BitmojiBodyVisualizer} from "./BitmojiBodyVisualizer"
import {BitmojiJoint, BitmojiProvider} from "./BitmojiProvider"
import {ThirdPersonCamera} from "./ThirdPersonCamera"
import {IKBodyInteractor, IKBodyInteractorConfig} from "../IKBodyInteractor"

/** Minimal API surface for the BitmojiCharacter custom component loaded from `BitmojiCharacter.lsc`. */
interface BitmojiCharacter extends BaseScriptComponent {
  download(): Promise<SceneObject>
}

/** Default render layer the debug overlay camera filters on. */
export const DEFAULT_BITMOJI_DEBUG_OVERLAY_LAYER = LayerSet.makeUnique()

export type CreateBitmojiAvatarConfig = {
  parent?: SceneObject
  scale?: number
  localRotation?: quat
  /** Centimeters the forearm overlaps the IK hand to hide the wrist seam. */
  forearmOverlapCm?: number
  /** Apply the Bitmoji skin material to the IK hand visuals. */
  applySkinToSikHands?: boolean
  /** Centimeters to push the avatar root behind the user's camera. */
  bodyOffsetBehindCm?: number
  /** `false` disables the third-person debug overlay; a `LayerSet` overrides the default layer. */
  debugOverlay?: false | LayerSet
}

export type CreateIKInteractorConfig = {
  avatar?: CreateBitmojiAvatarConfig
  body?: Omit<IKBodyInteractorConfig, "avatarVisualizer">
}

/**
 * Construct an {@link IKBodyInteractor} with a Bitmoji avatar visualizer.
 *
 * @param config - Optional overrides for the avatar and body interactor.
 * @returns The fully wired interactor.
 */
export function createIKInteractor(
  config: CreateIKInteractorConfig = {},
): IKBodyInteractor {
  return new IKBodyInteractor({
    /** Default fallback: route aborted IK interactions through simulated IK input so scenario side effects still fire when an IK check records a diagnostic. */
    fallback: config.body?.fallback ?? new DefaultLeafInteractor(),
    ...config.body,
    avatarVisualizer: BitmojiAvatar.spawn(config.avatar),
  })
}

const WRIST_JOINT_BY_SIDE: Record<Side, BitmojiJoint> = {
  left: "leftWrist",
  right: "rightWrist",
}
const FOREARM_JOINT_BY_SIDE: Record<Side, BitmojiJoint> = {
  left: "leftForeArm",
  right: "rightForeArm",
}

const DEFAULTS = {
  /** ~80% of adult shoulder→wrist reach × 2.37. */
  scale: 2.37,
  /** Mixamo rigs rest facing local +Z; flip 180° around Y to face the user. */
  localRotation: quat.fromEulerAngles(0, Math.PI, 0),
  /** 4 cm overlap hides the forearm/IK-hand wrist seam without burying the IK hand. */
  forearmOverlapCm: 4,
  applySkinToSikHands: true,
  bodyOffsetBehindCm: 0,
  debugOverlay: DEFAULT_BITMOJI_DEBUG_OVERLAY_LAYER as false | LayerSet,
}

type ResolvedAvatarConfig = typeof DEFAULTS & CreateBitmojiAvatarConfig

/** Drives a dynamically-loaded {@link BitmojiCharacter} as an {@link AvatarVisualizer}. */
class BitmojiAvatar implements AvatarVisualizer {
  private _provider?: BitmojiProvider
  private _visualizer?: BitmojiBodyVisualizer
  private _debugCamera?: ThirdPersonCamera

  private constructor(
    private readonly _rootSceneObject: SceneObject,
    private readonly _config: ResolvedAvatarConfig,
    private readonly _rig: BitmojiCharacter,
  ) {}

  /**
   * Spawn an avatar root SceneObject, attach the `BitmojiCharacter`
   * component loaded from `BitmojiCharacter.lsc`, and apply the resolved
   * scale/rotation.
   *
   * @param config - Optional overrides; every field has a sensible default.
   * @returns The avatar instance. The download itself runs asynchronously
   *   when {@link create} awaits `rig.download()`.
   */
  static spawn(config: CreateBitmojiAvatarConfig = {}): BitmojiAvatar {
    const resolvedConfig = {...DEFAULTS, ...config}

    const rootSceneObject = global.scene.createSceneObject("BitmojiAvatar")
    if (resolvedConfig.parent !== undefined) {
      rootSceneObject.setParent(resolvedConfig.parent)
    }
    const transform = rootSceneObject.getTransform()
    transform.setLocalScale(vec3.one().uniformScale(resolvedConfig.scale))
    transform.setLocalRotation(resolvedConfig.localRotation)

    /**
     * Resolve the BitmojiCharacter class through the .lsc without an
     * import (which would need a .d.ts the .lsc doesn't ship). The
     * string form of `require` resolves into the .lsc's compiled module.
     */
    requireAsset("./bitmoji/BitmojiCharacter.lsc")
    const characterModule = require(
      "./bitmoji/BitmojiCharacter.lsc/BitmojiCharacter",
    ) as {BitmojiCharacter: {getTypeName(): TypeName<BitmojiCharacter>}}
    const rig = rootSceneObject.createComponent(
      characterModule.BitmojiCharacter.getTypeName(),
    ) as BitmojiCharacter

    return new BitmojiAvatar(rootSceneObject, resolvedConfig, rig)
  }

  async create(config: AvatarCreateConfig): Promise<void> {
    await this._rig.download()

    this._provider = BitmojiProvider.load(this._rootSceneObject)
    this._visualizer = new BitmojiBodyVisualizer(
      this._provider,
      this._config.forearmOverlapCm,
    )

    /** Union with main camera layer so both renderers see the rig + IK hands. */
    const overlay =
      this._config.debugOverlay === false
        ? undefined
        : this._config.debugOverlay
    if (overlay !== undefined) {
      const mainCameraLayer =
        WorldCameraFinderProvider.getInstance().renderLayer()
      const rigLayers = mainCameraLayer.union(overlay)
      this._provider.setLayers(rigLayers, overlay)
      if (config.hands !== undefined) {
        config.hands.left.setHandVisualsLayer(rigLayers)
        config.hands.right.setHandVisualsLayer(rigLayers)
      }
      this._debugCamera = new ThirdPersonCamera({visibleLayer: overlay})
    }

    if (config.hands !== undefined && this._config.applySkinToSikHands) {
      const material = this._provider.skinMaterial
      if (material !== undefined) {
        config.hands.left.setHandVisualsMaterial(material)
        config.hands.right.setHandVisualsMaterial(material)
      }
    }
  }

  apply(pose: BodyPose): void {
    if (this._visualizer === undefined || this._provider === undefined) return
    this._visualizer.apply(pose)
    this.anchorAvatarRoot()
  }

  idleWristPoses(): {left?: JointPose; right?: JointPose} {
    if (this._provider === undefined) return {}
    return {
      left: this.getWristIdlePose("left"),
      right: this.getWristIdlePose("right"),
    }
  }

  destroy(): void {
    this._debugCamera?.destroy()
    this._debugCamera = undefined
    this._provider?.dispose()
  }

  /** Pin the head bone at the user's eye position every frame. */
  private anchorAvatarRoot(): void {
    const rootAnchor = this._provider?.rootAnchor
    if (rootAnchor === undefined) return
    const {root, headOffset} = rootAnchor

    const cameraProvider = WorldCameraFinderProvider.getInstance()
    const cameraWorld = cameraProvider.getWorldPosition()
    const offset = this._config.bodyOffsetBehindCm

    if (offset === 0) {
      root.getTransform().setWorldPosition(cameraWorld.sub(headOffset))
      return
    }

    const back = cameraProvider.back()
    const horizontalBack = safeNormalize(new vec3(back.x, 0, back.z))
    const offsetAnchor =
      horizontalBack !== undefined
        ? cameraWorld.add(horizontalBack.uniformScale(offset))
        : cameraWorld
    root.getTransform().setWorldPosition(offsetAnchor.sub(headOffset))
  }

  /** Back out the forearm overlap so the IK hand lands on the wrist, not inside the sleeve. */
  private getWristIdlePose(side: Side): JointPose | undefined {
    if (this._provider === undefined) return undefined
    const wristNode = this._provider.getJoint(WRIST_JOINT_BY_SIDE[side])
    const foreArmNode = this._provider.getJoint(FOREARM_JOINT_BY_SIDE[side])
    if (isNull(wristNode) || isNull(foreArmNode)) return undefined

    const wristTransform = wristNode.getTransform()
    const wristWorld = wristTransform.getWorldPosition()
    const rotation = wristTransform.getWorldRotation()
    const overlapCm = this._config.forearmOverlapCm
    if (overlapCm <= 0) return {position: wristWorld, rotation}

    const forearmDirection = safeNormalize(
      wristWorld.sub(foreArmNode.getTransform().getWorldPosition()),
    )
    if (forearmDirection === undefined) return {position: wristWorld, rotation}

    const position = wristWorld.sub(forearmDirection.uniformScale(overlapCm))
    return {position, rotation}
  }
}

