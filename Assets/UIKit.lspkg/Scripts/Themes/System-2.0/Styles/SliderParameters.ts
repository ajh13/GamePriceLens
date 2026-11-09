import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {
  DarkerLessGray,
  DarkestGray,
  DarkestYellow,
  DarkWarmGray,
  MediumDarkGray,
  MediumWarmGray,
  SliderKnobTriggeredBorderMid,
  SwitchBorderYellowLight,
  SwitchKnobBorderGray,
  SwitchKnobBorderTransparent,
  SwitchKnobBorderYellow,
  SwitchKnobBorderYellowBright,
  SwitchKnobBorderYellowMedium,
  SwitchTrackBorderGray,
  SwitchTrackBorderTransparent,
  SwitchTrackGray,
  SwitchYellowBright,
  SwitchYellowDark,
  TriggeredBorderClearGray,
  TriggeredBorderYellow
} from "../Colors"

export const SliderComponentData = {
  cornerRadiusFactor: 0.5,
  knob: {
    knobVisible: true
  }
}

export const SliderParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Partial<RoundedRectangleVisualParameters>>
  fill: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: {
          type: "Linear",
          start: new vec2(0, 1),
          end: new vec2(0, -1),
          stop0: {
            percent: 0,
            color: SwitchTrackGray
          },
          stop1: {
            percent: 1,
            color: DarkerLessGray
          }
        },
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: SwitchTrackBorderGray
          },
          stop1: {
            percent: 0.5,
            color: SwitchTrackBorderTransparent
          },
          stop2: {
            percent: 1,
            color: SwitchTrackBorderGray
          }
        }
      },
      hovered: {},
      triggered: {
        baseGradient: {
          start: new vec2(0, 1),
          end: new vec2(0, -1),
          stop0: {
            percent: 0,
            color: DarkestYellow
          },
          stop1: {
            percent: 1,
            color: DarkestYellow
          }
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: SwitchKnobBorderYellow
          },
          stop1: {
            percent: 0.5,
            color: SwitchKnobBorderYellowMedium
          },
          stop2: {
            percent: 1,
            color: SwitchKnobBorderYellow
          }
        }
      }
    }
  },
  knob: {
    default: {
      default: {
        baseType: "Gradient",
        borderSize: 0.07,
        baseGradient: {
          enabled: true,
          type: "Linear",
          start: new vec2(-1, 1),
          end: new vec2(1, -1),
          stop0: {percent: 0, color: DarkestGray},
          stop1: {percent: 1, color: DarkWarmGray}
        },
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: SwitchKnobBorderGray
          },
          stop1: {
            percent: 1,
            color: SwitchKnobBorderTransparent
          }
        }
      },
      hovered: {
        baseGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: DarkWarmGray
          },
          stop1: {
            percent: 1,
            color: SwitchKnobBorderGray
          }
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: MediumWarmGray
          },
          stop1: {
            percent: 1,
            color: TriggeredBorderClearGray
          }
        }
      },
      triggered: {
        baseGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: SwitchYellowDark
          },
          stop1: {
            percent: 1,
            color: SwitchYellowBright
          }
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: TriggeredBorderYellow
          },
          stop1: {
            percent: 0.5,
            color: SliderKnobTriggeredBorderMid
          },
          stop2: {
            percent: 1,
            color: SwitchKnobBorderYellowBright
          }
        }
      }
    }
  },
  fill: {
    default: {
      default: {
        baseType: "Color",
        baseColor: MediumDarkGray,
        hasBorder: false
      },
      hovered: {
        baseColor: MediumWarmGray
      },
      triggered: {
        baseColor: SwitchBorderYellowLight
      }
    }
  }
}
