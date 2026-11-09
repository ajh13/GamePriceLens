// @module System-3.0/Styles/RadioButtonParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {Style} from "../../Style"
import {RadioAccentViolet, RadioBorderGray, RadioFillGray, Transparent} from "../Colors"

export const RadioButtonParameters: {
  base: Record<string, Style>
  toggled: Record<string, Style>
} = {
  base: {
    default: {
      default: {
        baseType: "Color",
        baseColor: RadioFillGray,
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Color",
        borderColor: RadioBorderGray,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseColor: RadioFillGray,
        borderColor: RadioBorderGray
      },
      triggered: {
        baseType: "Color",
        baseColor: RadioAccentViolet,
        hasBorder: false
      },
      toggledDefault: {
        baseColor: RadioFillGray,
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Color",
        borderColor: RadioBorderGray
      },
      toggledHovered: {
        baseColor: RadioFillGray,
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Color",
        borderColor: RadioAccentViolet
      },
      toggledTriggered: {
        baseType: "Color",
        baseColor: RadioAccentViolet,
        hasBorder: false
      }
    }
  },
  toggled: {
    default: {
      default: {
        baseType: "Color",
        baseColor: Transparent,
        hasBorder: false,
        borderType: "Color",
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseColor: RadioBorderGray
      },
      triggered: {
        baseColor: RadioAccentViolet
      },
      toggledDefault: {
        baseType: "Color",
        baseColor: RadioAccentViolet,
        hasBorder: false
      },
      toggledHovered: {
        baseColor: RadioBorderGray,
        hasBorder: false
      },
      toggledTriggered: {
        baseColor: RadioAccentViolet,
        hasBorder: false
      }
    }
  }
}
