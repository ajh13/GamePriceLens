import {DEG_TO_RAD} from "Leaf.lspkg/Utils/common/Constants"

/**
 * ========== TYPE DEFINITIONS ==========
 */

/**
 * Config for a single finger
 */
export type FingerConfig = {
  knuckleAngle: quat
  midjointAngle: quat
  upperAngle: quat
}

/**
 * Config for a hand, containing the configuration for each finger
 */
export type HandConfig = {
  thumb: FingerConfig
  index: FingerConfig
  middle: FingerConfig
  ring: FingerConfig
  pinky: FingerConfig
  handRotation?: quat // Optional rotation
  /**
   * Optional position for the hand when performing this gesture.
   * If vec3, world position is assumed. If vec2, screen-positions ([0,1]) is assumed.
   */
  handPosition?:
    | {
        coordinates: "world"
        value: vec3
      }
    | {
        coordinates: "screen"
        value: vec2
        depth: number
      }
}

/**
 * Config for a gesture, containing the configuration for both hands
 */
export type GestureConfig = {
  left: HandConfig
  right: HandConfig
}

/**
 * ========== NEUTRAL CONFIG ==========
 * Initial config of the hands, can be used as a base for other gestures.
 */

export const NEUTRAL_CONFIG: GestureConfig = {
  left: {
    thumb: {
      knuckleAngle: quat.fromEulerAngles(0.244953, 6.2784, 0.0190648),
      midjointAngle: quat.fromEulerAngles(6.23756, 6.28302, 6.27961),
      upperAngle: quat.fromEulerAngles(5.23968, 0.101245, 2.8836),
    },
    index: {
      knuckleAngle: quat.fromEulerAngles(0.00103034, 0.346416, 6.00557),
      midjointAngle: quat.fromEulerAngles(6.14208, 6.28138, 6.27047),
      upperAngle: quat.fromEulerAngles(6.27172, 3.36849e-6, 6.28215),
    },
    middle: {
      knuckleAngle: quat.fromEulerAngles(0.0220924, 0.106708, 6.22603),
      midjointAngle: quat.fromEulerAngles(6.20403, 6.28313, 6.28273),
      upperAngle: quat.fromEulerAngles(6.23647, 6.28318, 6.28292),
    },
    ring: {
      knuckleAngle: quat.fromEulerAngles(6.21061, 6.18912, 0.149127),
      midjointAngle: quat.fromEulerAngles(0.0216079, 6.28318, 0.000297753),
      upperAngle: quat.fromEulerAngles(0.00253177, 8.65683e-6, 3.4924e-5),
    },
    pinky: {
      knuckleAngle: quat.fromEulerAngles(6.0948, 6.04085, 0.374017),
      midjointAngle: quat.fromEulerAngles(0.0216115, 6.28318, 0.000177954),
      upperAngle: quat.fromEulerAngles(6.18429, 6.28311, 6.28238),
    },
  },
  right: {
    thumb: {
      knuckleAngle: quat.fromEulerAngles(0.24577, 6.28319, 6.28319),
      midjointAngle: quat.fromEulerAngles(6.23742, 6.28318, 6.28318),
      upperAngle: quat.fromEulerAngles(4.19687, 6.08889, 6.16971),
    },
    index: {
      knuckleAngle: quat.fromEulerAngles(0.160838, 0.309054, 0.282197),
      midjointAngle: quat.fromEulerAngles(6.14149, 6.28318, 8.20305e-7),
      upperAngle: quat.fromEulerAngles(6.27961, 6.27181, 6.24327),
    },
    middle: {
      knuckleAngle: quat.fromEulerAngles(0.0337789, 0.103503, 0.0572974),
      midjointAngle: quat.fromEulerAngles(6.20403, 5.06146e-6, 2.96706e-7),
      upperAngle: quat.fromEulerAngles(6.23647, 1.309e-6, 6.28318),
    },
    ring: {
      knuckleAngle: quat.fromEulerAngles(6.24348, 6.17257, 6.13301),
      midjointAngle: quat.fromEulerAngles(0.02161, 6.28318, 6.28319),
      upperAngle: quat.fromEulerAngles(0.002532, 6.28318, 7.46093e-18),
    },
    pinky: {
      knuckleAngle: quat.fromEulerAngles(0.0276598, 5.98048, 5.90167),
      midjointAngle: quat.fromEulerAngles(0.0216124, 1.37881e-6, 1.26163e-17),
      upperAngle: quat.fromEulerAngles(6.18429, 6.28319, 6.28319),
    },
  },
}

/**
 * All joint angles slightly bent (relaxed)
 */
const RELAXED_FINGER: FingerConfig = {
  knuckleAngle: quat.fromEulerAngles(10 * DEG_TO_RAD, 0, 0),
  midjointAngle: quat.fromEulerAngles(10 * DEG_TO_RAD, 0, 0),
  upperAngle: quat.fromEulerAngles(10 * DEG_TO_RAD, 0, 0),
}

/**
 * ========== RELAXED CONFIG ==========
 */
const RELAXED_HAND = {
  thumb: RELAXED_FINGER,
  index: RELAXED_FINGER,
  middle: RELAXED_FINGER,
  ring: RELAXED_FINGER,
  pinky: RELAXED_FINGER,
}
const RELAXED_CONFIG: GestureConfig = {
  left: RELAXED_HAND,
  right: RELAXED_HAND,
}

/**
 * ========== FIST CONFIG ==========
 */

/**
 * Joints are bent in one axis to create a fist
 */
const FIST_FOUR_FINGERS: FingerConfig = {
  knuckleAngle: quat.fromEulerAngles(-80, 0, 0),
  midjointAngle: quat.fromEulerAngles(45, 0, 0),
  upperAngle: quat.fromEulerAngles(15, 0, 0),
}

const FIST_CONFIG: GestureConfig = {
  left: {
    thumb: {
      ...RELAXED_FINGER,
      knuckleAngle: quat.fromEulerAngles(45, 45, 0),
    },
    index: {
      ...FIST_FOUR_FINGERS,
    },
    middle: {
      ...FIST_FOUR_FINGERS,
    },
    ring: {
      ...FIST_FOUR_FINGERS,
    },
    pinky: {
      ...FIST_FOUR_FINGERS,
    },
  },
  right: {
    thumb: {
      ...FIST_FOUR_FINGERS,
      knuckleAngle: quat.fromEulerAngles(45, -45, 0),
    },
    index: {
      ...FIST_FOUR_FINGERS,
    },
    middle: {
      ...FIST_FOUR_FINGERS,
    },
    ring: {
      ...FIST_FOUR_FINGERS,
    },
    pinky: {
      ...FIST_FOUR_FINGERS,
    },
  },
}

/**
 * ========== PINCH CONFIG ==========
 *
 * Pinch sets finger angles only — it deliberately does *not* override
 * `handRotation`. The hand stays at whatever orientation the caller put it
 * in (typically {@link VERTICAL_HAND_ROTATION} for IK-driven hands), so
 * pinching never rotates the hand off the targeting pose.
 */

/**
 * Sympathetic curl for fingers that ride along with a thumb+index pinch —
 * tendon coupling makes middle/ring/pinky bend partway when the index curls.
 * Angles are interpolated from {@link RELAXED_FINGER} (10°/10°/10°) toward
 * the index pinch pose (70°/30°/20°), with decreasing coupling outward.
 */
const PINCH_SYMPATHETIC_MIDDLE: FingerConfig = {
  knuckleAngle: quat.fromEulerAngles(40 * DEG_TO_RAD, 0, 0),
  midjointAngle: quat.fromEulerAngles(20 * DEG_TO_RAD, 0, 0),
  upperAngle: quat.fromEulerAngles(15 * DEG_TO_RAD, 0, 0),
}
const PINCH_SYMPATHETIC_RING: FingerConfig = {
  knuckleAngle: quat.fromEulerAngles(28 * DEG_TO_RAD, 0, 0),
  midjointAngle: quat.fromEulerAngles(16 * DEG_TO_RAD, 0, 0),
  upperAngle: quat.fromEulerAngles(13 * DEG_TO_RAD, 0, 0),
}
const PINCH_SYMPATHETIC_PINKY: FingerConfig = {
  knuckleAngle: quat.fromEulerAngles(22 * DEG_TO_RAD, 0, 0),
  midjointAngle: quat.fromEulerAngles(14 * DEG_TO_RAD, 0, 0),
  upperAngle: quat.fromEulerAngles(12 * DEG_TO_RAD, 0, 0),
}

const PINCH_CONFIG: GestureConfig = {
  left: {
    thumb: {
      ...RELAXED_FINGER,
      knuckleAngle: quat.fromEulerAngles(40 * DEG_TO_RAD, 25 * DEG_TO_RAD, 0),
    },
    index: {
      knuckleAngle: quat.fromEulerAngles(70 * DEG_TO_RAD, 0, 0),
      midjointAngle: quat.fromEulerAngles(30 * DEG_TO_RAD, 0, 0),
      upperAngle: quat.fromEulerAngles(20 * DEG_TO_RAD, 0, 0),
    },
    middle: PINCH_SYMPATHETIC_MIDDLE,
    ring: PINCH_SYMPATHETIC_RING,
    pinky: PINCH_SYMPATHETIC_PINKY,
  },
  right: {
    thumb: {
      ...RELAXED_FINGER,
      knuckleAngle: quat.fromEulerAngles(60 * DEG_TO_RAD, -60 * DEG_TO_RAD, 0),
    },
    index: {
      knuckleAngle: quat.fromEulerAngles(70 * DEG_TO_RAD, 0, 0),
      midjointAngle: quat.fromEulerAngles(30 * DEG_TO_RAD, 0, 0),
      upperAngle: quat.fromEulerAngles(20 * DEG_TO_RAD, 0, 0),
    },
    middle: PINCH_SYMPATHETIC_MIDDLE,
    ring: PINCH_SYMPATHETIC_RING,
    pinky: PINCH_SYMPATHETIC_PINKY,
  },
}

/**
 * ========== PALM CONFIG ==========
 */
const PALM_CONFIG: GestureConfig = {
  left: {
    ...NEUTRAL_CONFIG.left,
    handRotation: quat.fromEulerAngles(180 * DEG_TO_RAD, 0, 90 * DEG_TO_RAD),
    handPosition: {
      coordinates: "screen",
      value: new vec2(0.2, 0.95),
      depth: 70,
    },
  },
  right: {
    ...NEUTRAL_CONFIG.right,
    handRotation: quat.fromEulerAngles(-90 * DEG_TO_RAD, 0, -90 * DEG_TO_RAD),
    handPosition: {
      coordinates: "screen",
      value: new vec2(0.8, 0.95),
      depth: 70,
    },
  },
}

/**
 * ========== BACKHAND CONFIG ==========
 */
const BACKHAND_CONFIG: GestureConfig = {
  left: {
    ...NEUTRAL_CONFIG.left,
    handRotation: quat.fromEulerAngles(0, 0, 90 * DEG_TO_RAD),
    handPosition: {
      coordinates: "screen",
      value: new vec2(0.2, 0.95),
      depth: 70,
    },
  },
  right: {
    ...NEUTRAL_CONFIG.right,
    handRotation: quat.fromEulerAngles(90 * DEG_TO_RAD, 0, -90 * DEG_TO_RAD),
    handPosition: {
      coordinates: "screen",
      value: new vec2(0.8, 0.95),
      depth: 70,
    },
  },
}

/**
 * ========== EXPORT ALL GESTURES ==========
 */

export const GESTURE_CONFIG = {
  fist: FIST_CONFIG,
  pinch: PINCH_CONFIG,
  palm: PALM_CONFIG,
  backhand: BACKHAND_CONFIG,
  relaxed: RELAXED_CONFIG,
}

export type GestureType = keyof typeof GESTURE_CONFIG | "neutral" | "unknown"

/*
 * ========== EXPORT GESTURE RELATED CONSTANTS ==========
 */
/**
 * Approximated distance between the thumb and index finger in a relaxed hand pose.
 * Accurate values for left and right respectively are:
 * right: 13.364873886108398
 * left: 13.421989440917969
 */
export const RELAXED_THUMB_INDEX_DISTANCE = 13.4

/**
 * The minimum pinch strength to consider a pinch gesture valid.
 */
export const PINCH_STRENGTH_THRESHOLD = 0.85

/**
 * The vector to offset the hand wrist position to make sure the index finger
 * is in the set position when a pinch gesture is performed.
 */
export const PINCH_POSITION_OFFSET = {
  right: new vec3(7.05321, -10.9036, 5.62354),
  left: new vec3(-5.96139, -9.57339, 8.54925),
}

/**
 * Special predefined positions for the hands. Currently only contains
 * the hidden positions for left and right hands.
 */
export const HAND_TRANSFORMS = {
  left: {
    hiddenPosition: new vec3(-10, -80, 0),
    initialPosition: vec3.zero(), // Initial position for left hand
    initialRotation: quat.fromEulerAngles(0, 0, 0), // Initial rotation for left hand
  },
  right: {
    hiddenPosition: new vec3(10, -80, 0),
    initialPosition: vec3.zero(), // Initial position for right hand
    initialRotation: quat.fromEulerAngles(0, 0, 0), // Initial rotation for right hand
  },
}

/**
 * Baseline vertical hand orientation used by interactors that drive the hand
 * in space (IK or simulated). Sets the hand's world rotation so the palm
 * faces inward and fingers point forward — a natural targeting pose. Gestures
 * with their own `handRotation` (pinch, palm, backhand) override this.
 */
export const VERTICAL_HAND_ROTATION = {
  left: quat.fromEulerAngles(0, 0, 90 * DEG_TO_RAD),
  right: quat.fromEulerAngles(90 * DEG_TO_RAD, 0, -90 * DEG_TO_RAD),
}
