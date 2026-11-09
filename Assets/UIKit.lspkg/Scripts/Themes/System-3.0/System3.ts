import {Style} from "../Style"
import {Theme} from "../Theme"
import {BeveledPrismButtonParameters} from "./Styles/BeveledPrismButtonParameters"
import {ButtonParameters} from "./Styles/ButtonParameters"
import {CapsuleButtonParameters} from "./Styles/CapsuleButtonParameters"
import {CheckboxComponentData, CheckboxParameters} from "./Styles/CheckboxParameters"
import {ColorSliderComponentData, ColorSliderParameters} from "./Styles/ColorSliderParameters"
import {ConfirmationSliderComponentData, ConfirmationSliderParameters} from "./Styles/ConfirmationSliderParameters"
import {FrameParameters} from "./Styles/FrameParameters"
import {LoadingBarComponentData} from "./Styles/LoadingBarParameters"
import {LongPressButtonComponentData, LongPressButtonParameters} from "./Styles/LongPressButtonParameters"
import {ProgressBarComponentData, ProgressBarParameters} from "./Styles/ProgressBarParameters"
import {RadioButtonParameters} from "./Styles/RadioButtonParameters"
import {RoundButtonParameters} from "./Styles/RoundButtonParameters"
import {SkeletonComponentData} from "./Styles/SkeletonParameters"
import {SliderComponentData, SliderParameters} from "./Styles/SliderParameters"
import {SpinnerComponentData} from "./Styles/SpinnerParameters"
import {SwitchKnobPrismParameters} from "./Styles/SwitchKnobPrismParameters"
import {SwitchComponentData, SwitchKnobComponentData, SwitchParameters} from "./Styles/SwitchParameters"
import {System3ContentColors} from "./Styles/System3ContentColorParameters"
import {TextInputFieldParameters} from "./Styles/TextInputFieldParameters"
import {TooltipComponentData} from "./Styles/TooltipParameters"

export enum System3Styles {
  "Prism" = "Prism",
  "PrismGhost" = "PrismGhost",
  "Primary" = "Primary",
  "Secondary" = "Secondary",
  "Ghost" = "Ghost",
  "Tag" = "Tag",
  "Chip" = "Chip",
  "Palm" = "Palm"
}

const SYSTEM3_BUTTON_PARAMETERS = {...ButtonParameters, ...BeveledPrismButtonParameters}
const SYSTEM3_SWITCH_KNOB_PARAMETERS = {...SwitchParameters.knob, ...SwitchKnobPrismParameters}

const SYSTEM3_STYLES: Record<string, Record<string, Style>> = {
  Button: SYSTEM3_BUTTON_PARAMETERS,
  LongPressButton: LongPressButtonParameters,
  RoundButton: RoundButtonParameters,
  RectangleButton: ButtonParameters,
  CapsuleButton: CapsuleButtonParameters,
  SliderTrack: SliderParameters.track,
  SliderKnob: SliderParameters.knob,
  SliderFill: SliderParameters.fill,
  SwitchTrack: SwitchParameters.track,
  SwitchKnob: SYSTEM3_SWITCH_KNOB_PARAMETERS,
  SwitchFill: SwitchParameters.fill,
  RadioButton: RadioButtonParameters.base,
  RadioButtonToggled: RadioButtonParameters.toggled,
  Checkbox: CheckboxParameters.base,
  CheckboxToggled: CheckboxParameters.toggled,
  CheckboxMark: CheckboxParameters.mark,
  TextInputField: TextInputFieldParameters.style,
  ConfirmationSliderTrack: ConfirmationSliderParameters.track,
  ConfirmationSliderKnob: ConfirmationSliderParameters.knob,
  ColorSliderTrack: ColorSliderParameters.track,
  ColorSliderKnob: ColorSliderParameters.knob,
  ProgressBarTrack: ProgressBarParameters.track,
  ProgressBarFill: ProgressBarParameters.fill
}

const SYSTEM3_COMPONENT_DATA: Record<string, unknown> = {
  Frame: FrameParameters,
  LongPressButton: LongPressButtonComponentData,
  Slider: SliderComponentData,
  SliderKnob: SliderComponentData.knob,
  ConfirmationSlider: ConfirmationSliderComponentData,
  ConfirmationSliderKnob: ConfirmationSliderComponentData.knob,
  ProgressBar: ProgressBarComponentData,
  Spinner: SpinnerComponentData,
  LoadingBar: LoadingBarComponentData,
  Skeleton: SkeletonComponentData,
  Switch: SwitchComponentData,
  SwitchKnob: SwitchKnobComponentData,
  Tooltip: TooltipComponentData,
  Checkbox: CheckboxComponentData,
  ColorSlider: ColorSliderComponentData,
  ColorSliderKnob: ColorSliderComponentData.knob,
  ContentColors: System3ContentColors
}

export const System3: Theme = {
  get name(): string {
    return "System 3.0"
  },
  get defaultStyleName(): string {
    return "Primary"
  },
  get defaultShapeName(): string {
    return "Rectangle"
  },
  get styles(): Record<string, Record<string, Style>> {
    return SYSTEM3_STYLES
  },
  get componentData(): Record<string, unknown> {
    return SYSTEM3_COMPONENT_DATA
  }
}
