// @module System-3.0/Gradients/GhostGradients — DO NOT REMOVE: prevents Lens Studio module collision
import {withAlpha} from "InteractionKit.lspkg/Utils/color"
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {GhostHoverGray, GhostOnHoveredGray, GhostPressedGray, GhostSelectedGray, Transparent} from "../Colors"

export const GhostGradients: Record<string, GradientParameters> = {
  idleBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: withAlpha(GhostHoverGray, 0)
    },
    stop1: {
      percent: 1,
      color: withAlpha(GhostHoverGray, 0)
    }
  },
  idleBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: withAlpha(GhostHoverGray, 0)
    },
    stop1: {
      percent: 1,
      color: withAlpha(GhostHoverGray, 0)
    }
  },
  hoverBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: GhostHoverGray
    },
    stop1: {
      percent: 1,
      color: GhostHoverGray
    }
  },
  hoverBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: GhostHoverGray
    },
    stop1: {
      percent: 1,
      color: GhostHoverGray
    }
  },
  onHoveredBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: GhostOnHoveredGray
    },
    stop1: {
      percent: 1,
      color: GhostOnHoveredGray
    }
  },
  onHoveredBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: GhostOnHoveredGray
    },
    stop1: {
      percent: 1,
      color: GhostOnHoveredGray
    }
  },
  pressedBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: GhostPressedGray
    },
    stop1: {
      percent: 1,
      color: GhostPressedGray
    }
  },
  pressedBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: GhostPressedGray
    },
    stop1: {
      percent: 1,
      color: GhostPressedGray
    }
  },
  selectedBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: GhostSelectedGray
    },
    stop1: {
      percent: 1,
      color: GhostSelectedGray
    }
  },
  selectedBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: GhostSelectedGray
    },
    stop1: {
      percent: 1,
      color: GhostSelectedGray
    }
  },
  // Disabled ghost stays chromeless like idle — no fill or border; only the
  // content dims. (Was GhostSelectedGray, which made disabled read as
  // selected.)
  inactiveBackground: {
    type: "Linear",
    start: new vec2(-0.6, 1),
    end: new vec2(0.6, -1),
    stop0: {
      percent: 0,
      color: Transparent
    },
    stop1: {
      percent: 1,
      color: Transparent
    }
  },
  inactiveBorder: {
    type: "Linear",
    start: new vec2(-0.8, 1),
    end: new vec2(0.8, -1),
    stop0: {
      percent: 0,
      color: Transparent
    },
    stop1: {
      percent: 1,
      color: Transparent
    }
  }
}
