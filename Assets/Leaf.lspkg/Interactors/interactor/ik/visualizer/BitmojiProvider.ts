import {
  capitalize,
  findSceneObjectByName,
  forEachComponentInSubtree,
  forEachSceneObjectInSubtree,
  forEachTopmostSceneObject,
} from "Leaf.lspkg/Utils/common/Utils"
import {safeNormalize} from "Leaf.lspkg/IKSolver/MathUtils"
import {
  FINGER_JOINTS,
  FINGER_NAMES,
  FINGER_SEGMENTS,
  FingerJoint,
  FingerName,
  FingerSegment,
  Side,
  SIDES,
} from "Leaf.lspkg/IKSolver/Pose"

/** Next segment further out along the finger; `tip` has no successor. */
const NEXT_FINGER_SEGMENT: Partial<Record<FingerSegment, FingerSegment>> = {
  knuckle: "midJoint",
  midJoint: "upperJoint",
  upperJoint: "tip",
}

/** Joints driven from {@link BodyPose}. Used as a Record key for rest-pose maps. */
export type BitmojiJoint =
  | "head"
  | `${Side}${"Wrist" | "UpperArm" | "ForeArm" | "Foot" | "Clavicle"}`
  | `${Side}${Capitalize<FingerName>}${Capitalize<FingerSegment>}`

/** Compose a {@link BitmojiJoint} key from a side and a finger joint. */
export function bitmojiJointKey(side: Side, joint: FingerJoint): BitmojiJoint {
  return `${side}${capitalize(joint.name)}${capitalize(joint.segment)}`
}

/**
 * Rest-pose data captured at the bind pose. Per-joint values are
 * `undefined` when the joint isn't present on this rig variant or
 * (for `boneDirection`/`boneLength`) when the child joint is missing.
 * Consumers skip undefined joints rather than crashing.
 */
export type RestPose = {
  worldRotations: Record<BitmojiJoint, quat | undefined>
  localRotations: Record<BitmojiJoint, quat | undefined>
  boneDirections: Record<BitmojiJoint, vec3 | undefined>
  boneLengths: Record<BitmojiJoint, number | undefined>
}

/** Bitmoji's GLTF stems per finger — index finger is "Pointer". */
const FINGER_GLTF_STEM: Record<FingerName, string> = {
  thumb: "Thumb",
  index: "Pointer",
  middle: "Middle",
  ring: "Ring",
  pinky: "Pinky",
}

/** Segment → numeric suffix used in the Bitmoji GLTF joint names. */
const SEGMENT_GLTF_INDEX: Record<FingerSegment, string> = {
  knuckle: "0001",
  midJoint: "0002",
  upperJoint: "0003",
  tip: "0004",
}

/** Non-finger joint names; finger joints are generated below from a naming scheme. */
const FIXED_JOINT_NAMES: Record<
  Exclude<
    BitmojiJoint,
    `${Side}${Capitalize<FingerName>}${Capitalize<FingerSegment>}`
  >,
  string
> = {
  head: "C_head_bind_JNT",
  leftClavicle: "L_clavicle_bind_JNT",
  rightClavicle: "R_clavicle_bind_JNT",
  leftWrist: "L_hand0001_bind_JNT",
  rightWrist: "R_hand0001_bind_JNT",
  leftUpperArm: "L_armUpper0001_bind_JNT",
  leftForeArm: "L_armLower0001_bind_JNT",
  rightUpperArm: "R_armUpper0001_bind_JNT",
  rightForeArm: "R_armLower0001_bind_JNT",
  leftFoot: "L_foot0001_bind_JNT",
  rightFoot: "R_foot0001_bind_JNT",
}

/** Maps each logical {@link BitmojiJoint} to the underlying Bitmoji GLTF joint name. */
const BITMOJI_JOINT_NAMES: Record<BitmojiJoint, string> = (() => {
  const fingerEntries: Partial<Record<BitmojiJoint, string>> = {}
  for (const side of SIDES) {
    const sideLetter = side === "left" ? "L" : "R"
    for (const joint of FINGER_JOINTS) {
      const stem = FINGER_GLTF_STEM[joint.name]
      const index = SEGMENT_GLTF_INDEX[joint.segment]
      fingerEntries[bitmojiJointKey(side, joint)] =
        `${sideLetter}_hand${stem}${index}_bind_JNT`
    }
  }
  return {...FIXED_JOINT_NAMES, ...fingerEntries} as Record<BitmojiJoint, string>
})()

/** Head meshes hang off these groups, not the head joint — re-layer the subtree to hide them. */
const HEAD_GROUP_PREFIX = "universal_head_"

/** Above IK UI render orders so the avatar always wins depth ties. */
const BITMOJI_RENDER_ORDER = 9999

/** Body / head mesh names probed (in order) for the skin material; avatar variants differ. */
const SKIN_MATERIAL_CANDIDATES = [
  "C_head_GEO",
  "female_C_head_GEO",
  "female_body_GEO",
  "C_body_GEO",
] as const

type AvatarData = {
  avatar: SceneObject
  joints: Record<BitmojiJoint, SceneObject | undefined>
  restPose: RestPose
  rootToHeadOffset: vec3
  skinMaterial: Material | undefined
}

/**
 * Exposes joint + rest-pose accessors over a Bitmoji rig already in
 * the scene. Geometry is captured inside {@link load} (RAII-style).
 */
export class BitmojiProvider {
  private readonly _data: AvatarData
  private _renderLayer?: LayerSet
  private _headLayer?: LayerSet

  /** @throws If the rig is missing `C_head_bind_JNT`. */
  static load(rootSceneObject: SceneObject): BitmojiProvider {
    const data = captureAvatarData(rootSceneObject)
    if (data === undefined) {
      throw new Error(
        "BitmojiProvider.load: rig is missing the 'C_head_bind_JNT' joint",
      )
    }
    return new BitmojiProvider(rootSceneObject, data)
  }

  private constructor(
    private readonly _rootSceneObject: SceneObject,
    data: AvatarData,
  ) {
    this._data = data
    this._applyVisualOverrides()
  }

  /** Detach the provider. Idempotent. */
  dispose(): void {}

  private _applyVisualOverrides(): void {
    /** Collapse the wrist — the IK hand mesh stands in for the avatar's hand. */
    for (const wristJoint of ["leftWrist", "rightWrist"] as const) {
      this._data.joints[wristJoint]?.getTransform().setLocalScale(vec3.zero())
    }

    forEachComponentInSubtree<{setRenderOrder(order: number): void}>(
      this._data.avatar,
      ["Component.RenderMeshVisual", "Component.MaterialMeshVisual"],
      (visual) => visual.setRenderOrder(BITMOJI_RENDER_ORDER),
    )
    this.applyLayers(this._data.avatar)
  }

  /**
   * Look up the SceneObject backing a logical joint.
   *
   * @param name - Logical joint name (rig-agnostic).
   * @returns SceneObject for the joint, or `undefined` if the rig variant
   *   lacks it.
   */
  getJoint(name: BitmojiJoint): SceneObject | undefined {
    return this._data.joints[name]
  }

  get restPose(): RestPose {
    return this._data.restPose
  }

  /**
   * @returns `{root, headOffset}` where `root` is the avatar root
   *   SceneObject and `headOffset` is the world-space vector from `root`
   *   to the head bone at rest. Used by callers to anchor the rig's head
   *   onto the user's tracked head position.
   */
  get rootAnchor(): {root: SceneObject; headOffset: vec3} {
    return {
      root: this._rootSceneObject,
      headOffset: this._data.rootToHeadOffset,
    }
  }

  /**
   * @returns The Bitmoji skin material extracted from the avatar's body
   *   mesh, or `undefined` if no known body-mesh variant matched.
   */
  get skinMaterial(): Material | undefined {
    return this._data.skinMaterial
  }

  /**
   * Override the render layers applied to the rig.
   *
   * @param rig - Full layer set for the avatar body.
   * @param headOnly - Optional subset applied only to head meshes — lets a
   *   debug overlay see the head while the main camera hides it.
   */
  setLayers(rig?: LayerSet, headOnly?: LayerSet): void {
    this._renderLayer = rig
    this._headLayer = headOnly
    this.applyLayers(this._data.avatar)
  }

  private applyLayers(avatar: SceneObject): void {
    if (this._renderLayer) {
      const rigLayer = this._renderLayer
      forEachSceneObjectInSubtree(avatar, (n) => (n.layer = rigLayer))
    }
    if (this._headLayer) {
      const headLayer = this._headLayer
      forEachTopmostSceneObject(
        (object) =>
          object.name.startsWith(HEAD_GROUP_PREFIX) ? object : undefined,
        (object) =>
          forEachSceneObjectInSubtree(object, (n) => (n.layer = headLayer)),
        avatar,
      )
    }
  }
}

/** `undefined` when the rig is missing `C_head_bind_JNT` — caller decides whether to throw or skip. */
function captureAvatarData(
  rootSceneObject: SceneObject,
): AvatarData | undefined {
  const joints = cacheJoints(rootSceneObject)
  const headNode = joints.head
  if (isNull(headNode)) return undefined

  const restPose = captureRestPose(joints)
  const rootWorld = rootSceneObject.getTransform().getWorldPosition()
  const headWorld = headNode.getTransform().getWorldPosition()
  const rootToHeadOffset = headWorld.sub(rootWorld)

  return {
    avatar: rootSceneObject,
    joints,
    restPose,
    rootToHeadOffset,
    skinMaterial: findSkinMaterial(rootSceneObject),
  }
}

function cacheJoints(
  avatar: SceneObject,
): Record<BitmojiJoint, SceneObject | undefined> {
  const cache: Partial<Record<BitmojiJoint, SceneObject | undefined>> = {}
  for (const logical of Object.keys(BITMOJI_JOINT_NAMES) as BitmojiJoint[]) {
    cache[logical] = findSceneObjectByName(
      BITMOJI_JOINT_NAMES[logical],
      avatar,
    )
  }
  return cache as Record<BitmojiJoint, SceneObject | undefined>
}

function captureRestPose(
  joints: Record<BitmojiJoint, SceneObject | undefined>,
): RestPose {
  const worldRotations: Partial<Record<BitmojiJoint, quat>> = {}
  const localRotations: Partial<Record<BitmojiJoint, quat>> = {}
  const boneDirections: Partial<Record<BitmojiJoint, vec3>> = {}
  const boneLengths: Partial<Record<BitmojiJoint, number>> = {}

  for (const logical of Object.keys(joints) as BitmojiJoint[]) {
    const node = joints[logical]
    if (isNull(node)) continue
    const transform = node.getTransform()
    worldRotations[logical] = transform.getWorldRotation()
    localRotations[logical] = transform.getLocalRotation()

    const child = CHILD_JOINT[logical]
    const childNode = child !== undefined ? joints[child] : undefined
    if (isNull(childNode)) continue
    const delta = childNode
      .getTransform()
      .getWorldPosition()
      .sub(transform.getWorldPosition())
    boneLengths[logical] = delta.length
    const direction = safeNormalize(delta)
    if (direction !== undefined) boneDirections[logical] = direction
  }

  return {
    worldRotations: worldRotations as Record<BitmojiJoint, quat | undefined>,
    localRotations: localRotations as Record<BitmojiJoint, quat | undefined>,
    boneDirections: boneDirections as Record<BitmojiJoint, vec3 | undefined>,
    boneLengths: boneLengths as Record<BitmojiJoint, number | undefined>,
  }
}

/**
 * Map from a joint to the joint that lies one bone segment further out along
 * the chain — used to derive the rest bone direction (child world position
 * minus this joint's world position).
 */
const CHILD_JOINT: Partial<Record<BitmojiJoint, BitmojiJoint>> = (() => {
  const result: Partial<Record<BitmojiJoint, BitmojiJoint>> = {
    leftClavicle: "leftUpperArm",
    rightClavicle: "rightUpperArm",
    leftUpperArm: "leftForeArm",
    leftForeArm: "leftWrist",
    rightUpperArm: "rightForeArm",
    rightForeArm: "rightWrist",
  }
  for (const side of SIDES) {
    for (const name of FINGER_NAMES) {
      for (const segment of FINGER_SEGMENTS) {
        const next = NEXT_FINGER_SEGMENT[segment]
        if (next === undefined) continue
        result[bitmojiJointKey(side, {name, segment})] = bitmojiJointKey(
          side,
          {name, segment: next},
        )
      }
    }
  }
  return result
})()

/** First material found on any known Bitmoji face / body mesh. */
function findSkinMaterial(avatar: SceneObject): Material | undefined {
  for (const name of SKIN_MATERIAL_CANDIDATES) {
    const node = findSceneObjectByName(name, avatar)
    if (isNull(node)) continue
    const visual = node.getComponent(
      "Component.RenderMeshVisual",
    ) as RenderMeshVisual | null
    if (isNull(visual)) continue
    if (visual.getMaterialsCount() > 0) return visual.getMaterial(0)
  }
  return undefined
}

