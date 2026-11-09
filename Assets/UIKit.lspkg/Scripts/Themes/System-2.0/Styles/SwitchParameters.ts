import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {
  DarkerLessGray,
  DarkestGray,
  DarkGray,
  DarkWarmGray,
  MediumDarkGray,
  MediumWarmGray,
  SwitchBorderYellowBright,
  SwitchBorderYellowBrighter,
  SwitchBorderYellowLight,
  SwitchBorderYellowMedium,
  SwitchHoverOrange,
  SwitchHoverYellow,
  SwitchKnobBorderGray,
  SwitchKnobBorderTransparent,
  SwitchKnobBorderTransparentHover,
  SwitchKnobBorderYellow,
  SwitchKnobBorderYellowBright,
  SwitchKnobBorderYellowHover,
  SwitchKnobBorderYellowMedium,
  SwitchKnobGray,
  SwitchTrackBorderGray,
  SwitchTrackBorderTransparent,
  SwitchTrackFillGray,
  SwitchTrackGray,
  SwitchTrackYellowDark,
  SwitchTrackYellowMedium,
  SwitchYellowBright,
  SwitchYellowBrightestHover,
  SwitchYellowBrightHover,
  SwitchYellowDark,
  TriggeredBorderYellow
} from "../Colors"

export const SwitchParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Partial<RoundedRectangleVisualParameters>>
  fill: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      default: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackGray},
          stop1: {percent: 0.5, color: SwitchTrackGray},
          stop2: {percent: 1, color: SwitchTrackGray}
        },
        baseType: "Gradient",
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: SwitchTrackBorderGray},
          stop1: {percent: 0.5, color: SwitchTrackBorderTransparent},
          stop2: {percent: 1, color: SwitchTrackBorderGray}
        }
      },
      hovered: {
        baseGradient: {
          start: new vec2(0, 1.8),
          end: new vec2(0, -1.8),
          stop0: {percent: 0, color: DarkGray},
          stop1: {percent: 0.5, color: DarkGray},
          stop2: {percent: 1, color: MediumDarkGray}
        }
      },
      triggered: {
        baseGradient: {
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackGray},
          stop1: {percent: 0.5, color: SwitchTrackGray},
          stop2: {percent: 1, color: SwitchTrackGray}
        }
      },
      toggledDefault: {
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.9, 1),
          end: new vec2(0.9, -1),
          stop0: {percent: 0, color: SwitchBorderYellowLight},
          stop1: {percent: 0.55, color: SwitchBorderYellowMedium},
          stop2: {percent: 1, color: SwitchBorderYellowLight}
        }
      },
      toggledHovered: {
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.9, 1),
          end: new vec2(0.9, -1),
          stop0: {percent: 0, color: SwitchBorderYellowBright},
          stop1: {percent: 0.55, color: SwitchBorderYellowBrighter},
          stop2: {percent: 1, color: SwitchBorderYellowBright}
        }
      },
      toggledTriggered: {
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.9, 1),
          end: new vec2(0.9, -1),
          stop0: {percent: 0, color: SwitchBorderYellowLight},
          stop1: {percent: 0.55, color: SwitchBorderYellowMedium},
          stop2: {percent: 1, color: SwitchBorderYellowLight}
        }
      }
    }
  },
  knob: {
    default: {
      default: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          start: new vec2(-1, 1),
          end: new vec2(1, -1),
          stop0: {percent: 0, color: DarkestGray},
          stop1: {percent: 1, color: DarkWarmGray}
        },
        baseType: "Gradient",
        hasBorder: true,
        borderSize: 0.05,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: SwitchKnobBorderGray},
          stop1: {percent: 1, color: SwitchKnobBorderTransparent}
        }
      },
      hovered: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          start: new vec2(-1, 1),
          end: new vec2(1, -1),
          stop0: {percent: 0, color: DarkerLessGray},
          stop1: {percent: 1, color: SwitchKnobGray}
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: MediumWarmGray},
          stop1: {percent: 1, color: SwitchKnobBorderTransparentHover}
        }
      },
      triggered: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {percent: 0, color: SwitchYellowDark},
          stop1: {percent: 1, color: SwitchYellowBright}
        }
      },
      toggledDefault: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {percent: 0, color: SwitchYellowDark},
          stop1: {percent: 1, color: SwitchYellowBright}
        },
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: SwitchKnobBorderYellow},
          stop1: {percent: 0.55, color: SwitchKnobBorderYellowMedium},
          stop2: {percent: 1, color: SwitchKnobBorderYellowBright}
        }
      },
      toggledHovered: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {percent: 0, color: SwitchYellowBrightHover},
          stop1: {percent: 1, color: SwitchYellowBrightestHover}
        },
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: TriggeredBorderYellow},
          stop1: {percent: 0.55, color: SwitchKnobBorderYellowHover},
          stop2: {percent: 1, color: TriggeredBorderYellow}
        }
      },
      toggledTriggered: {
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {percent: 0, color: SwitchYellowDark},
          stop1: {percent: 1, color: SwitchYellowBright}
        },
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: SwitchKnobBorderYellow},
          stop1: {percent: 0.55, color: SwitchKnobBorderYellowMedium},
          stop2: {percent: 1, color: SwitchKnobBorderYellowBright}
        }
      }
    }
  },
  fill: {
    default: {
      default: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackFillGray},
          stop1: {percent: 1, color: SwitchTrackFillGray}
        },
        baseType: "Gradient"
      },
      hovered: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchHoverOrange},
          stop1: {percent: 1, color: SwitchHoverYellow}
        }
      },
      toggledDefault: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackYellowDark},
          stop1: {percent: 1, color: SwitchTrackYellowDark}
        }
      },
      toggledHovered: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackYellowMedium},
          stop1: {percent: 1, color: SwitchTrackYellowMedium}
        }
      },
      toggledTriggered: {
        baseGradient: {
          type: "Linear",
          start: new vec2(-1, 0),
          end: new vec2(1, 0),
          stop0: {percent: 0, color: SwitchTrackYellowDark},
          stop1: {percent: 1, color: SwitchTrackYellowDark}
        }
      }
    }
  }
}
