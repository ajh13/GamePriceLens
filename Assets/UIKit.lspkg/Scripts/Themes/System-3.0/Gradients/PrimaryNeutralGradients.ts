// @module System-3.0/Gradients/PrimaryNeutralGradients — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  DarkerLessGray,
  DarkestGray,
  DarkGray,
  MediumDarkGray,
  MediumGray,
  TriggeredBorderCyan,
  TriggeredBorderCyanDim
} from "../Colors"

export const PrimaryNeutralGradients: Record<string, GradientParameters> = {
  idleBackground: {
    type: "Linear",
    start: new vec2(-2, 1),
    end: new vec2(2, -1),
    stop0: {
      percent: 0,
      color: DarkestGray
    },
    stop1: {
      percent: 1,
      color: DarkGray
    }
  },
  idleBorder: {
    type: "Linear",
    start: new vec2(-1, 0.8),
    end: new vec2(1, -0.8),
    stop0: {
      percent: 0,
      color: MediumDarkGray
    },
    stop1: {
      percent: 1,
      color: DarkerLessGray
    }
  },
  hoverBackground: {
    type: "Linear",
    start: new vec2(-2, 1),
    end: new vec2(2, -1),
    stop0: {
      percent: 0,
      color: DarkestGray
    },
    stop1: {
      percent: 1,
      color: MediumDarkGray
    }
  },
  pressedBackground: {
    type: "Linear",
    start: new vec2(-2, 1),
    end: new vec2(2, -1),
    stop0: {
      percent: 0,
      color: DarkestGray
    },
    stop1: {
      percent: 0.5,
      color: DarkGray
    },
    stop2: {
      percent: 1,
      color: MediumGray
    }
  },
  pressedBorder: {
    type: "Linear",
    start: new vec2(-1, 0.8),
    end: new vec2(1, -0.8),
    stop0: {
      percent: 0,
      color: TriggeredBorderCyan
    },
    stop1: {
      percent: 0.5,
      color: DarkGray
    },
    stop2: {
      percent: 1,
      color: TriggeredBorderCyanDim
    }
  }
}
