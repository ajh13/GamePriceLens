import {easingFunctions} from "InteractionKit.lspkg/Utils/animate"
import {RadToDeg} from "InteractionKit.lspkg/Utils/mathUtils"

const LOOK_UP_ANGLE_BLEND_START: number = 50
const LOOK_UP_ANGLE_BLEND_END: number = 30
const LOOK_DOWN_ANGLE_BLEND_START: number = 130
const LOOK_DOWN_ANGLE_BLEND_END: number = 150

/**
 * Billboard rotation toward the camera with singularity avoidance near vertical
 * look directions: blends world-up toward camera-up so `quat.lookAt` stays stable.
 */
export function computeBillboardRotation(lookDir: vec3, cameraUp: vec3, initialRot?: quat): quat {
  const lookUpAngle = lookDir.angleTo(vec3.up()) * RadToDeg
  const upBlendFactor = easingFunctions["ease-in-out-sine"](
    clampedRemap(lookUpAngle, LOOK_UP_ANGLE_BLEND_START, LOOK_UP_ANGLE_BLEND_END, 0, 1) +
      clampedRemap(lookUpAngle, LOOK_DOWN_ANGLE_BLEND_START, LOOK_DOWN_ANGLE_BLEND_END, 0, 1)
  )
  const upVector = safeVec3Slerp(vec3.up(), cameraUp, upBlendFactor)
  const rotation = quat.lookAt(lookDir, upVector)
  return initialRot ? rotation.multiply(initialRot) : rotation
}

function clampedRemap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return Math.max(outMin, Math.min(outMax, ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin))
}

function safeVec3Slerp(a: vec3, b: vec3, t: number): vec3 {
  const result = vec3.slerp(a, b, t)
  if (isNaN(result.x)) {
    return t < 0.5 ? a : b
  }
  return result
}
