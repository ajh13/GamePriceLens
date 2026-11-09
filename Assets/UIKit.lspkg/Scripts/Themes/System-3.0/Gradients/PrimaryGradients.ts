// @module System-3.0/Gradients/PrimaryGradients — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  AccentBlue,
  AccentBlueBright,
  AccentBlueDimLight,
  AccentBlueOnHovered,
  AccentBlueSelected,
  AccentPurple,
  AccentPurpleBright,
  AccentPurpleDimLight,
  AccentPurpleOnHovered,
  AccentPurpleSelected,
  AccentTeal,
  AccentTealBright,
  AccentTealDimLight,
  AccentTealOnHovered,
  AccentTealSelected,
  InactivePrimary,
  WarmLightGray
} from "../Colors"

const GRADIENT_MIDDLE_POINT = 0.5
const ROTATION_ANGLE = 0.2
export const PrimaryGradients: Record<string, GradientParameters> = {
  idleBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: WarmLightGray,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: WarmLightGray,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: WarmLightGray,
      percent: 1
    }
  },
  idleBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: WarmLightGray,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: WarmLightGray,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: WarmLightGray,
      percent: 1
    }
  },
  hoverBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurple,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlue,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTeal,
      percent: 1
    }
  },
  hoverBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurple,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlue,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTeal,
      percent: 1
    }
  },
  onHoveredBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleOnHovered,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueOnHovered,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealOnHovered,
      percent: 1
    }
  },
  onHoveredBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleOnHovered,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueOnHovered,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealOnHovered,
      percent: 1
    }
  },
  pressedBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleDimLight,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueDimLight,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealDimLight,
      percent: 1
    }
  },
  pressedBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleBright,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueBright,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealBright,
      percent: 1
    }
  },
  selectedBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleSelected,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueSelected,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealSelected,
      percent: 1
    }
  },
  selectedBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: AccentPurpleSelected,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: AccentBlueSelected,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: AccentTealSelected,
      percent: 1
    }
  },
  inactiveBackground: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: InactivePrimary,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: InactivePrimary,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: InactivePrimary,
      percent: 1
    }
  },
  inactiveBorder: {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {
      enabled: true,
      color: InactivePrimary,
      percent: 0
    },
    stop1: {
      enabled: true,
      color: InactivePrimary,
      percent: GRADIENT_MIDDLE_POINT
    },
    stop2: {
      enabled: true,
      color: InactivePrimary,
      percent: 1
    }
  }
}
