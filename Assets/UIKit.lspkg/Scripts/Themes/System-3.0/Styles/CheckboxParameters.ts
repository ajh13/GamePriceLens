// @module System-3.0/Styles/CheckboxParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {Style} from "../../Style"
import {
  AccentPurple,
  CheckboxBaseBackground,
  CheckboxBaseBorder,
  CheckboxBaseInactiveBorder,
  CheckboxToggledBorder,
  CheckboxToggledInactive,
  ListCheckboxBaseBackground
} from "../Colors"

// Checkmark glyph sourced from the Icons package (Iconography/Alerts-notifications/
// checkmark.png), recolored per state at author time into these textures. The
// squircle check visual can't tint a texture at runtime, so each color is its
// own baked PNG.
const CHECK_TEXTURES: {gray: Texture; lightGray: Texture; purple: Texture} = {
  gray: requireAsset("../../../../Textures/check_system3_gray.png") as Texture,
  lightGray: requireAsset("../../../../Textures/check_system3_light_gray.png") as Texture,
  purple: requireAsset("../../../../Textures/check_system3_purple.png") as Texture
}

const GRADIENT_MIDDLE_POINT = 0.5
const ROTATION_ANGLE = 0.2

function solidGradient(color: vec4): GradientParameters {
  return {
    type: "Linear",
    start: new vec2(-1, ROTATION_ANGLE),
    end: new vec2(1, -ROTATION_ANGLE),
    stop0: {enabled: true, color: color, percent: 0},
    stop1: {enabled: true, color: color, percent: GRADIENT_MIDDLE_POINT},
    stop2: {enabled: true, color: color, percent: 1}
  }
}

const TRANSPARENT_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Linear",
  stop0: {enabled: false, percent: 0, color: vec4.zero()},
  stop1: {enabled: false, percent: GRADIENT_MIDDLE_POINT, color: vec4.zero()},
  stop2: {enabled: false, percent: 1, color: vec4.zero()}
}

const ListCheckboxGradients: Record<string, GradientParameters> = {
  baseBackground: solidGradient(ListCheckboxBaseBackground),
  transparent: TRANSPARENT_GRADIENT
}

const CheckboxGradients: Record<string, GradientParameters> = {
  baseBackground: solidGradient(CheckboxBaseBackground),
  baseBorder: solidGradient(CheckboxBaseBorder),
  accent: solidGradient(AccentPurple),
  toggledBorder: solidGradient(CheckboxToggledBorder),
  toggledInactive: solidGradient(CheckboxToggledInactive),
  baseInactiveBorder: solidGradient(CheckboxBaseInactiveBorder),
  transparent: TRANSPARENT_GRADIENT
}

export const CheckboxComponentData = {
  cornerRadiusFactor: 0.2
}

export const CheckboxParameters: {
  base: Record<string, Style>
  toggled: Record<string, Style>
  mark: Record<string, Style>
} = {
  base: {
    Default: {
      default: {
        baseType: "Gradient",
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: CheckboxGradients.baseBorder,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseGradient: CheckboxGradients.baseBackground,
        borderGradient: CheckboxGradients.baseBorder
      },
      triggered: {
        baseGradient: CheckboxGradients.accent,
        hasBorder: false
      },
      toggledDefault: {
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: CheckboxGradients.toggledBorder
      },
      toggledHovered: {
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: CheckboxGradients.accent
      },
      toggledTriggered: {
        baseGradient: CheckboxGradients.accent,
        hasBorder: false
      },
      inactive: {
        baseGradient: CheckboxGradients.baseBackground,
        borderGradient: CheckboxGradients.baseInactiveBorder
      }
    },
    ListCheckbox: {
      default: {
        baseType: "Gradient",
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      triggered: {
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: false
      },
      toggledDefault: {
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: false
      },
      toggledHovered: {
        baseGradient: CheckboxGradients.transparent,
        hasBorder: false
      },
      toggledTriggered: {
        baseGradient: CheckboxGradients.baseBackground,
        hasBorder: false
      },
      inactive: {
        baseGradient: ListCheckboxGradients.baseBackground,
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: CheckboxGradients.baseInactiveBorder
      }
    }
  },
  toggled: {
    Default: {
      default: {
        baseType: "Gradient",
        baseGradient: CheckboxGradients.transparent,
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseGradient: CheckboxGradients.baseBorder,
        hasBorder: false
      },
      triggered: {
        baseGradient: CheckboxGradients.transparent,
        hasBorder: false
      },
      toggledDefault: {
        baseGradient: CheckboxGradients.accent,
        hasBorder: false
      },
      toggledHovered: {
        baseGradient: CheckboxGradients.baseBorder,
        hasBorder: false
      },
      toggledTriggered: {
        baseGradient: CheckboxGradients.transparent,
        hasBorder: false
      },
      inactive: {
        baseGradient: CheckboxGradients.toggledInactive,
        hasBorder: false
      }
    },
    ListCheckbox: {
      default: {
        baseType: "Gradient",
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      triggered: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      toggledDefault: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      toggledHovered: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      toggledTriggered: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      },
      inactive: {
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false
      }
    }
  },
  mark: {
    Default: {
      default: {
        baseType: "Gradient",
        baseGradient: CheckboxGradients.transparent,
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      triggered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      toggledDefault: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      toggledHovered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      toggledTriggered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      inactive: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      }
    },
    ListCheckbox: {
      default: {
        baseType: "Gradient",
        baseGradient: ListCheckboxGradients.transparent,
        hasBorder: false,
        shouldScale: false,
        shouldPosition: false,
        localScale: new vec3(1, 1, 1),
        localPosition: new vec3(0, 0, 0)
      },
      hovered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.gray
      },
      triggered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.lightGray
      },
      toggledDefault: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.purple
      },
      toggledHovered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.purple
      },
      toggledTriggered: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.lightGray
      },
      inactive: {
        baseType: "Texture",
        baseTexture: CHECK_TEXTURES.purple
      }
    }
  }
}
