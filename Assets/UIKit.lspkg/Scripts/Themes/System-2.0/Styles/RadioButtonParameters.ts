import {Style} from "../../Style"
import {PrimaryGradients} from "../Gradients/PrimaryGradients"
import {SecondaryGradients} from "../Gradients/SecondaryGradients"

export const RadioButtonParameters: {
  base: Record<string, Style>
  toggled: Record<string, Style>
} = {
  base: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: SecondaryGradients.defaultBackground,
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: SecondaryGradients.defaultBorder,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseGradient: SecondaryGradients.hoverBackground,
        borderGradient: SecondaryGradients.hoverBorder
      },
      toggledDefault: {
        baseGradient: PrimaryGradients.defaultBackground,
        borderGradient: PrimaryGradients.defaultBorder
      },
      toggledHovered: {
        baseGradient: PrimaryGradients.hoverBackground,
        borderGradient: PrimaryGradients.triggeredBorder
      }
    }
  },
  toggled: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: {
          enabled: true,
          type: "Linear",
          stop0: {
            enabled: false,
            percent: 0,
            color: vec4.zero()
          },
          stop1: {
            enabled: false,
            percent: 1,
            color: vec4.zero()
          }
        },
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      toggledDefault: {
        baseGradient: PrimaryGradients.triggeredBackground,
        hasBorder: true,
        borderSize: 0.05,
        borderType: "Gradient",
        borderGradient: PrimaryGradients.triggeredBorder
      },
      toggledHovered: {
        baseGradient: PrimaryGradients.triggeredBackground,
        hasBorder: true,
        borderSize: 0.05,
        borderType: "Gradient",
        borderGradient: PrimaryGradients.triggeredBorder
      },
      toggledTriggered: {
        baseGradient: PrimaryGradients.triggeredBackground,
        hasBorder: true,
        borderSize: 0.05,
        borderType: "Gradient",
        borderGradient: PrimaryGradients.triggeredBorder
      }
    }
  }
}
