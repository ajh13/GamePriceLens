// @module System-3.0/Colors — DO NOT REMOVE: prevents Lens Studio module collision
import {colorFrom255, HSVtoRGB} from "../../Utility/UIKitUtilities"
import {
  DSButtonFillCTAIdle,
  DSButtonIconTextHovered,
  DSButtonIconTextIdle,
  DSButtonIconTextPressed,
  DSButtonOutlineSecondaryIdle,
  DSColorHierarchyGeneralLevel0,
  DSColorHierarchyPanelLevel0,
  DSColorHierarchyPanelLevel1,
  DSColorHierarchyPanelLevel2,
  DSColorHierarchyUIAccentGreen,
  DSColorHierarchyUIAccentGreenLight,
  DSColorHierarchyUIAccentPurpleLight,
  DSColorHierarchyUIAccentViolet,
  DSColorHierarchyUILevel0,
  DSColorHierarchyUILevel1,
  DSColorHierarchyUILevel2,
  DSColorHierarchyUILevel3,
  DSTextColorLinkHovered,
  DSTextColorLinkIdle,
  DSTextColorLinkPressed,
  DSTextFillBody,
  DSTextFillTitleHeadline
} from "./DesignSystemColors"

// System 3.0 palette. Values are sourced from the System 3.0 design tokens.

export const DarkestGray = HSVtoRGB(210, 0.15, 0.15, 1)
export const DarkerGray = HSVtoRGB(210, 0.15, 0.18, 1)
export const DarkerLessGray = HSVtoRGB(210, 0.15, 0.2, 1)
export const DarkGray = HSVtoRGB(210, 0.2, 0.25, 1)
export const MediumDarkGray = HSVtoRGB(210, 0.2, 0.35, 1)
export const MediumGray = HSVtoRGB(210, 0.2, 0.5, 1)

export const TriggeredBorderCyan = HSVtoRGB(190, 0.8, 0.95, 1)
export const TriggeredBorderCyanDim = HSVtoRGB(190, 0.7, 0.7, 1)
export const TriggeredBorderClearGray = HSVtoRGB(210, 0, 0.16, 0)

export const DarkestBlue = HSVtoRGB(210, 0.7, 0.25, 1)
export const DarkerBlue = HSVtoRGB(210, 0.65, 0.35, 1)
export const DarkBlue = HSVtoRGB(210, 0.7, 0.4, 1)
export const DarkerMediumBlue = HSVtoRGB(210, 0.7, 0.45, 1)
export const DarkMediumBlue = HSVtoRGB(210, 0.75, 0.55, 1)
export const MediumBlue = HSVtoRGB(210, 0.7, 0.6, 1)
export const BrightCoolBlue = HSVtoRGB(200, 0.8, 0.65, 1)
export const BrightCyan = HSVtoRGB(190, 0.85, 0.9, 1)

export const DarkCoolGray = HSVtoRGB(220, 0.15, 0.25, 1)
export const MediumCoolGray = HSVtoRGB(220, 0.2, 0.4, 1)

export const DarkestPurple = HSVtoRGB(270, 0.7, 0.25, 1)
export const DarkPurple = HSVtoRGB(270, 0.75, 0.4, 1)
export const DarkWarmPurple = HSVtoRGB(270, 0.8, 0.5, 1)
export const MediumDarkPurple = HSVtoRGB(270, 0.65, 0.5, 1)
export const MediumPurple = HSVtoRGB(270, 0.8, 0.55, 1)
export const MediumLightPurple = HSVtoRGB(270, 0.65, 0.6, 1)
export const LightPurple = HSVtoRGB(270, 0.6, 0.7, 1)

export const Transparent = HSVtoRGB(0, 0, 0, 0)

// --- System 3.0 reference surfaces (exact sRGB 8-bit) ---
// Raw vec4 (not HSVtoRGB) to preserve the reference's exact values, matching the
// existing `new vec4(n/255,...)` precedent in this file. TODO(visdev): fold into the
// production System3 palette during the Colors.ts cleanup.
export const UIlevel0 = DSColorHierarchyUILevel0
export const UIlevel1 = DSColorHierarchyUILevel1
export const UIlevel2 = DSColorHierarchyUILevel2
export const PanelLevel0 = DSColorHierarchyPanelLevel0
// In the Figma color library but not used by any component yet; exported so Colors.ts
// covers the library's styles.
export const PanelLevel2 = DSColorHierarchyPanelLevel2
export const AccentPurpleLight = DSColorHierarchyUIAccentPurpleLight
// Palm button idle ring. Figma Button Outline/Secondary/Idle.
export const PalmButtonIdle = DSButtonOutlineSecondaryIdle
// Pressed PalmButton: a transparent purple->teal center fill matching the accent
// ring hues (AccentPurple/Blue/Teal) at low alpha, so the otherwise-transparent
// center reads as a lit gradient while held. Consumed by the Palm style.
export const PalmPressedFillPurple = HSVtoRGB(251, 0.42, 0.643, 0.4) // AccentPurple @ 40%
export const PalmPressedFillBlue = HSVtoRGB(200, 0.342, 0.596, 0.4) // AccentBlue @ 40%
export const PalmPressedFillTeal = HSVtoRGB(169, 0.539, 0.722, 0.4) // AccentTeal @ 40%

// TextInputField voice-input sweep tokens — the 4-stop gradient from the DS3.0
// "TextInput_bg 5" material (color1-4 with the shader's -13 lightness applied),
// at stops 0 / 0.43 / 0.66 / 1 along a ~170deg axis. The teal stop is Figma
// UI/Accent Green; the other three stay the material colors.
export const TextInputFieldVoiceSweepViolet = new vec4(0.411768, 0.372108, 0.610017, 1) // #695F9C
export const TextInputFieldVoiceSweepBlue = new vec4(0.306631, 0.413951, 0.466078, 1) // #4E6A77
export const TextInputFieldVoiceSweepTeal = DSColorHierarchyUIAccentGreen
export const TextInputFieldVoiceSweepDarkTeal = new vec4(0.241177, 0.376844, 0.363275, 1) // #3E605D
// Animated bottom-edge ("Bottom Line") scan color from the same material (#A5E7FF).
export const TextInputFieldVoiceEdge = new vec4(0.645685, 0.905516, 1, 1) // #A5E7FF

// Slider-specific colors
export const SliderKnobTriggeredBorderMid = HSVtoRGB(195, 0.75, 0.35, 0.5)
export const SliderKnobPurple = HSVtoRGB(270, 0.7, 0.35, 1)
export const SliderKnobCyan = HSVtoRGB(190, 0.75, 0.5, 1)
export const SliderKnobBorderPurple = HSVtoRGB(270, 0.6, 0.5, 1)
export const SliderKnobBorderCyan = HSVtoRGB(190, 0.65, 0.65, 1)

export const SliderKnobHoverPurple = HSVtoRGB(270, 0.65, 0.45, 1)
export const SliderKnobHoverCyan = HSVtoRGB(190, 0.7, 0.6, 1)
export const SliderKnobHoverBorderPurple = HSVtoRGB(270, 0.55, 0.6, 1)
export const SliderKnobHoverBorderCyan = HSVtoRGB(190, 0.6, 0.75, 1)

export const SliderFillPurple = HSVtoRGB(270, 0.6, 0.4, 1)
export const SliderFillCyan = HSVtoRGB(190, 0.65, 0.55, 1)
export const SliderFillHoverPurple = HSVtoRGB(270, 0.55, 0.5, 1)
export const SliderFillHoverCyan = HSVtoRGB(190, 0.6, 0.65, 1)

export const SliderHoverFillPurple = DSColorHierarchyUIAccentViolet
export const SliderHoverFillGrayBlue = HSVtoRGB(228, 0.26, 0.58, 1)
export const SliderHoverFillCyan = HSVtoRGB(169, 0.54, 0.72, 1)

// ProgressBar-specific colors. Figma uses both Accent Green and Accent Green
// Light for progress bar fills; UIKit's fill is Accent Green.
export const ProgressBarTrackGray = DSColorHierarchyUILevel1
export const ProgressBarFillGreen = DSColorHierarchyUIAccentGreen

// Spinner-specific colors (Figma "UI/Accent Green Light").
export const SpinnerArcTeal = DSColorHierarchyUIAccentGreenLight

// Loading Bar colors. Head is the Spinner teal (Figma UI/Accent Green Light);
// comet tail is Figma UI/Accent Purple Light.
export const LoadingBarTeal = DSColorHierarchyUIAccentGreenLight
export const LoadingBarCometPurple = DSColorHierarchyUIAccentPurpleLight

// Content text/icon colors. Figma input fields use the Caption style, whose fill
// is Text Fill/Body, so the shared input text is that color.
export const ContentIdleGray = DSTextFillBody
export const ContentWhite = DSTextFillTitleHeadline
export const ContentPressedGray = HSVtoRGB(0, 0, 0.75, 1)
export const ContentInactiveWhite = HSVtoRGB(0, 0, 1, 0.35)
export const ContentAccentBlue = HSVtoRGB(214, 0.62, 1.0, 1)
export const ContentAccentBlueDim = HSVtoRGB(214, 0.62, 1.0, 0.35)

// Button text/icon colors (Figma "Button/Icon+Text/*")
export const ButtonContentIdle = DSButtonIconTextIdle
export const ButtonContentHovered = DSButtonIconTextHovered
export const ButtonContentPressed = DSButtonIconTextPressed

// Link text colors (System 3.0) — Figma "Text Color/Link/*". A desaturated
// sage/teal family; the underline tracks the text color per state. Figma has
// no disabled link style: Disabled uses the Pressed style.
export const ContentLinkDefault = DSTextColorLinkIdle
export const ContentLinkHovered = DSTextColorLinkHovered
export const ContentLinkTriggered = DSTextColorLinkPressed
export const ContentLinkDisabled = DSTextColorLinkPressed

// 3.0 button colors
// buttons
export const WarmLightGray = DSButtonFillCTAIdle
export const DarkInside = HSVtoRGB(0, 0, 0.1, 1)
export const WarmDarkGray = DSButtonOutlineSecondaryIdle
export const InactivePrimary = HSVtoRGB(150, 0.032, 0.251, 1)
export const InactiveSecondary = InactivePrimary.mult(DarkInside)
export const DarkInsideLight = HSVtoRGB(0, 0, 0.2, 1)
export const OutlineBrightness = HSVtoRGB(0, 0, 0.102, 0)
export const AccentPurple = HSVtoRGB(251, 0.42, 0.643, 1)
export const AccentPurpleDim = AccentPurple.mult(DarkInside)
export const AccentPurpleDimLight = AccentPurple.mult(DarkInsideLight)
export const AccentPurpleBright = AccentPurple.add(OutlineBrightness)
export const AccentBlue = HSVtoRGB(200, 0.342, 0.596, 1)
export const AccentBlueDim = AccentBlue.mult(DarkInside)
export const AccentBlueDimLight = AccentBlue.mult(DarkInsideLight)
export const AccentBlueBright = AccentBlue.add(OutlineBrightness)
export const AccentTeal = HSVtoRGB(169, 0.539, 0.722, 1)
export const AccentTealDim = AccentTeal.mult(DarkInside)
export const AccentTealDimLight = AccentTeal.mult(DarkInsideLight)
export const AccentTealBright = AccentTeal.add(OutlineBrightness)
export const AccentPurpleSelected = HSVtoRGB(251, 0.36, 0.48, 1)
export const AccentBlueSelected = HSVtoRGB(200, 0.29, 0.45, 1)
export const AccentTealSelected = HSVtoRGB(169, 0.46, 0.54, 1)

export const AccentPurpleOnHovered = HSVtoRGB(251, 0.42, 0.8, 1)
export const AccentBlueOnHovered = HSVtoRGB(200, 0.342, 0.75, 1)
export const AccentTealOnHovered = HSVtoRGB(169, 0.539, 0.9, 1)

export const GhostHoverGray = DSColorHierarchyUILevel3
export const GhostPressedGray = DSColorHierarchyUILevel2
export const GhostSelectedGray = DSColorHierarchyUILevel1
export const GhostOnHoveredGray = HSVtoRGB(173, 0.097, 0.36, 1)

// Frame (System 3.0 panel) body fill — #202020
export const FramePanelBackgroundGray = DSColorHierarchyPanelLevel0

// Input-specific colors
export const InputIdleBackground = DSColorHierarchyUILevel1
export const InputHoverBackground = GhostHoverGray
export const InputToggledBackground = DSColorHierarchyUILevel0
export const InputInactiveBackground = DSColorHierarchyPanelLevel0
export const InputText = ContentIdleGray
// Text input default. Same Caption fill as InputText (Text Fill/Body).
export const InputTextWarm = DSTextFillBody
export const InputInactiveText = ContentInactiveWhite

// Calendar-specific colors
export const CalendarBackgroundColor = InputInactiveBackground
export const CalendarTodayIndicatorColor = AccentPurple
export const CalendarRectangleButtonTextColor = InputText
export const CalendarDayHeaderTextColor = DSTextFillBody
export const CalendarWeekendHeaderTextColor = colorFrom255(186, 183, 174, 0.5)
export const CalendarCellButtonTextColor = InputText

// DatePicker-specific colors
export const DatePickerFieldBackplateColor = InputIdleBackground
export const DatePickerFieldTextColor = InputText
export const DatePickerTransparentColor = Transparent
// Plate half tint per field-button state, aligned with shared input colors.
// Unmapped states fall back to the resting plate color.
export const DatePickerFieldStatePlateColors: Partial<Record<string, vec4>> = {
  default: InputIdleBackground,
  hovered: InputHoverBackground,
  triggered: InputToggledBackground,
  toggledDefault: InputToggledBackground,
  toggledHovered: InputHoverBackground,
  toggledTriggered: InputToggledBackground
}

// ColorPicker-specific colors
export const ColorPickerBackplateRestingColor = DSColorHierarchyPanelLevel1
export const ColorPickerBackplateHoveredColor = DSColorHierarchyUILevel3
export const ColorPickerBackplateToggledColor = UIlevel2 // #454D4B
// Format-dropdown trigger: borderless in every state and fully transparent
// at rest, so the row backplate shows through. Hover and press fill with the
// shared input-surface tints (the row backplate tracks the SWATCH button, not
// this one, so the plate is the trigger's only state feedback), and the plate
// holds #3D4242 while the drawer is open.
export const ColorPickerFormatTriggerHoveredColor = InputHoverBackground // #404746
export const ColorPickerFormatTriggerTriggeredColor = InputToggledBackground // #2F3231
export const ColorPickerFormatTriggerToggledColor = InputIdleBackground // #3D4242
// Invisible (alpha 0) like a plain Transparent, but carrying the hover
// tint's RGB. The visual cross-fades state colors in straight alpha, so a
// transparent BLACK resting color drags the plate's RGB down through black
// while alpha ramps up: mid-fade it composites darker than BOTH endpoints.
// Against the dark collapsed backplate that is invisible, but while the
// popup is open the plate sits on #454D4B and the dip reads as a flash of
// the wrong color before the right one. Hover is the worst case — its
// endpoints are nearly equal in brightness, so the excursion is the entire
// visible effect. Matching the RGB makes the fade a pure alpha ramp.
export const ColorPickerFormatTriggerRestingColor = new vec4(
  ColorPickerFormatTriggerHoveredColor.r,
  ColorPickerFormatTriggerHoveredColor.g,
  ColorPickerFormatTriggerHoveredColor.b,
  0
)
// The expanded popup panel shares the row backplate's resting tint.
export const ColorPickerPanelColor = ColorPickerBackplateRestingColor
export const ColorPickerLabelTextColor = InputText
// Field-row backplate tint per swatch-button state: hovering the swatch
// lifts the plate to #545957, pressing settles it to #2F3231, and while
// the popup is open (toggledDefault) the plate holds one step above the
// #262626 resting base at #454D4B (UIlevel2). Unmapped states fall back
// to the resting color.
export const ColorPickerBackplateStateColors: Partial<Record<string, vec4>> = {
  default: ColorPickerBackplateRestingColor,
  hovered: ColorPickerBackplateHoveredColor,
  triggered: InputToggledBackground,
  toggledDefault: ColorPickerBackplateToggledColor,
  toggledHovered: ColorPickerBackplateHoveredColor,
  toggledTriggered: InputToggledBackground
}

// RadioButton-specific colors
export const RadioFillGray = DSColorHierarchyPanelLevel1
export const RadioBorderGray = DSColorHierarchyUILevel1
export const RadioAccentViolet = DSColorHierarchyUIAccentViolet

// Dropdown colors
export const DropdownBackgroundGray = DSColorHierarchyPanelLevel2
export const DropdownDrawerGray = DSColorHierarchyPanelLevel1

export const NumberPickerBackgroundColor = DSColorHierarchyPanelLevel1
export const NumberPickerSelectionBandDefaultColor = DSColorHierarchyPanelLevel2
export const NumberPickerSelectionBandHoveredColor = InputHoverBackground
export const NumberPickerSelectionBandPressedColor = InputToggledBackground
export const NumberPickerDraggedSelectedOptionTextColor = InputInactiveText

// Switch-specific colors
export const SwitchFlatHoverBackground = DSColorHierarchyUILevel1
// Slider + flat/"System" switch track background. Design feedback (2026-08):
// these components rendered the wrong background — the correct surface color
// is UIlevel0 (#2F3231), not the old #353837.
export const SwitchFlatTrackGray = UIlevel0
export const SwitchFloatBorderGray = DSColorHierarchyUILevel1
export const SwitchFloatBorderGreen = DSColorHierarchyUIAccentGreen
// Pressed border of the Prism pill switch. Figma UI/Level 1, same as the other Prism pill borders.
export const SwitchFloatBorderTeal = DSColorHierarchyUILevel1
export const SwitchNeutralGray30 = HSVtoRGB(0, 0, 0.3, 1)
export const SwitchNeutralGray35 = HSVtoRGB(0, 0, 0.35, 1)
export const SwitchNeutralDarkGray10 = HSVtoRGB(0, 0, 0.1, 1)
export const SwitchNeutralDarkGray12 = HSVtoRGB(0, 0, 0.12, 1)
export const SwitchNeutralDarkGray20 = HSVtoRGB(0, 0, 0.2, 1)
export const SwitchDarkGreen = HSVtoRGB(155, 0.5, 0.3, 1)
export const SwitchDimGreen = HSVtoRGB(150, 0.2, 0.22, 1)
export const SwitchMutedGreen = HSVtoRGB(120, 0.08, 0.6, 1)
export const SwitchDimTeal = HSVtoRGB(169, 0.539, 0.36, 1)
export const SwitchDarkTeal = HSVtoRGB(173, 0.684, 0.373, 1)
export const SwitchMutedTeal = HSVtoRGB(172, 0.388, 0.314, 1)
export const SwitchDimTealGray = HSVtoRGB(180, 0.156, 0.302, 1)
export const SwitchMediumTealGray = HSVtoRGB(180, 0.12, 0.68, 1)
export const SwitchDarkTealGray = HSVtoRGB(183, 0.5, 0.4, 1)
export const SwitchTealGray = HSVtoRGB(184, 0.19, 0.58, 1)
export const SwitchTealGray50 = HSVtoRGB(184, 0.371, 0.5, 1)
export const SwitchDimCyanTeal = HSVtoRGB(187, 0.609, 0.4, 1)
export const SwitchMediumCyanTeal = HSVtoRGB(187, 0.385, 0.357, 1)
export const SwitchDarkCyanTeal = HSVtoRGB(188, 0.3, 0.314, 1)
export const SwitchDarkCyan = HSVtoRGB(189, 0.498, 0.243, 1)
export const SwitchBrightCyan = HSVtoRGB(190, 0.5, 0.95, 1)
export const SwitchMediumCyan = HSVtoRGB(190, 0.47, 0.55, 1)
export const SwitchDimCyan = HSVtoRGB(191, 0.45, 0.48, 1)
export const SwitchDarkCyanGray = HSVtoRGB(191, 0.41, 0.31, 1)
export const SwitchPaleCyan = HSVtoRGB(192, 0.13, 0.753, 1)
export const SwitchDimCyanBlue = HSVtoRGB(193, 0.42, 0.45, 1)
export const SwitchMediumCyanBlue = HSVtoRGB(195, 0.38, 0.42, 1)
export const SwitchPaleWhiteCyan = HSVtoRGB(196, 0.19, 1, 1)
export const SwitchDimBlue = HSVtoRGB(200, 0.342, 0.3, 1)
export const SwitchBrightBlue = HSVtoRGB(201, 0.624, 0.835, 1)
export const SwitchDarkNavy = HSVtoRGB(207, 0.6, 0.15, 1)
export const SwitchMediumBlue = HSVtoRGB(212, 0.644, 0.469, 1)
export const SwitchDimBlueGray = HSVtoRGB(213, 0.592, 0.425, 1)
export const SwitchDimPurple = HSVtoRGB(238, 0.575, 0.45, 1)
export const SwitchDimViolet = HSVtoRGB(249, 0.14, 0.365, 1)
export const SwitchMediumViolet = HSVtoRGB(250, 0.604, 0.565, 1)
export const SwitchDarkViolet = HSVtoRGB(250, 0.4, 0.4, 1)
export const SwitchDimPurpleBlue = HSVtoRGB(251, 0.42, 0.32, 1)
export const SwitchDarkPurple = HSVtoRGB(251, 0.538, 0.35, 1)
export const SwitchDeepPurple = HSVtoRGB(262, 0.59, 0.436, 1)
export const SwitchDarkMagenta = HSVtoRGB(264, 0.5, 0.25, 1)
export const SwitchDeepMagenta = HSVtoRGB(273, 0.577, 0.306, 1)

// Tooltip colors (System 3.0)
export const TooltipFillGray = DSColorHierarchyUILevel0
// Tooltip text uses the Caption style, whose fill is Text Fill/Body.
export const TooltipTextGray = DSTextFillBody

// Checkbox-specific colors
export const CheckboxBaseBackground = DSColorHierarchyPanelLevel1
export const CheckboxBaseBorder = DSColorHierarchyUILevel1
export const CheckboxToggledBorder = HSVtoRGB(0, 0, 0.251, 1)
export const CheckboxToggledInactive = DSColorHierarchyUILevel0
export const CheckboxBaseInactiveBorder = DSColorHierarchyGeneralLevel0
export const ListCheckboxBaseBackground = DSColorHierarchyPanelLevel1

export const SliderFillIdle = DSButtonFillCTAIdle

export const HighlightDefaultColor = new vec4(0.317998, 0.450004, 0.396002, 0.4)
