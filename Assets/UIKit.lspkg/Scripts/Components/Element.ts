import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandInteractor} from "InteractionKit.lspkg/Core/HandInteractor/HandInteractor"
import {Interactor, InteractorInputType, TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {InteractableStateMachine, StateEvent} from "../Utility/InteractableStateMachine"
import {UIKitAudioPlayer} from "../Utility/UIKitAudioPlayer"
import {isEqual} from "../Utility/UIKitUtilities"
import {Layoutable} from "./Layout2D/Layoutable"
import {UIKitBrands} from "./Layout2D/UIKitBrands"
// Side-effect import: register UIKit's Layout2D handlers on the shared
// ItemHandlerRegistry. Element is the canonical UIKit base class, so every
// UIKit-derived component pulls this in transitively. See UIKitBootstrap.ts.
import "../UIKitBootstrap"

const log = new NativeLogger("Element")

const TRIGGER_END_AUDIO_TRACK: AudioTrackAsset = requireAsset("../../Audio/TriggerEndAudioTrack.wav") as AudioTrackAsset
const TRIGGER_END_AUDIO_VOLUME: number = 1

const ENLARGE_COLLIDER_MULTIPLIER: number = 3

export enum StateName {
  default = "default",
  hovered = "hovered",
  triggered = "triggered",
  error = "error",
  errorHovered = "errorHovered",
  inactive = "inactive",
  toggledDefault = "toggledDefault",
  toggledHovered = "toggledHovered",
  toggledTriggered = "toggledTriggered"
}

/**
 * A component managed by an Element's enable/disable lifecycle.
 *
 * `disabledWhenInactive` marks interaction components (interactables,
 * colliders) that must follow the `inactive` flag: they stay disabled while
 * the element is inactive, including across a disabled->enabled SceneObject
 * transition. Plain managed components (visuals, sub-widgets) always re-enable
 * with the SceneObject. Registered via Element.addManagedComponent /
 * addInteractionComponent so the flag travels with the entry — both the
 * `inactive` setter and enableManagedComponents read it from one place.
 */
interface ManagedComponent {
  component: Component
  disabledWhenInactive: boolean
}

/**
 * Abstract class representing an element in UIKit.
 *
 * @abstract
 */
// Bits of Element._input.
const PRESS_IN_FLIGHT = 1
const HOVER_IN_FLIGHT = 2
const DRAG_IN_FLIGHT = 4
// The press in flight was dropped by pausing input, so it ends as a cancel even once resumed.
const PRESS_DROPPED = 8
const INPUT_PAUSED = 16

// The targeting mode a paused element's Interactable had, put back when it resumes. Kept off the
// element, which sits close to the engine's own-property limit.
const targetingModesBeforePause = new WeakMap<Interactable, TargetingMode>()

export abstract class Element extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. Inherited
   * unchanged by every Element subclass so they all resolve to the same
   * handler without redeclaring. See `Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  // Having this here is a hack for re-ordering the inputs in the inspector
  // TODO: Move it to VisualElement once we have a way to re-order the inputs in the inspector
  @input("int")
  protected _renderOrder: number = 0

  @input
  @hint("Size of the element in centimeters")
  protected _size: vec3 = new vec3(6, 3, 3)

  @input
  @hint("Inactive Mode: set the element to ignore inputs")
  private _inactive: boolean = false

  @input
  @label("Play Audio")
  @hint("Enable interaction audio feedback")
  private _playAudio: boolean = false

  private _transform: Transform = this.sceneObject.getTransform()
  private initialPosition: vec3 = vec3.zero()
  private initialScale: vec3 = vec3.one()
  protected currentPosition: vec3 = this.initialPosition
  protected currentScale: vec3 = this.initialScale

  protected colliderObject: SceneObject
  protected colliderTransform: Transform
  protected _collider: ColliderComponent
  protected colliderShape: BoxShape
  protected _colliderFitElement: boolean = true
  protected readonly _colliderSize: vec3 = vec3.one()
  protected _colliderCenter: vec3 = vec3.zero()

  private _interactable: Interactable
  protected _interactableStateMachine: InteractableStateMachine

  protected managedSceneObjects: Set<SceneObject> = new Set<SceneObject>()
  protected managedComponents: ManagedComponent[] = []

  protected stateName: StateName = StateName.default

  protected _initialized: boolean = false
  protected _hasError: boolean = false

  private _triggerEndAudioTrack: AudioTrackAsset = TRIGGER_END_AUDIO_TRACK
  private _triggerEndAudioVolume: number = TRIGGER_END_AUDIO_VOLUME

  /**
   * Indicates whether the element is currently being dragged.
   * This property is used to track the drag state of the element.
   */
  protected _isDragged: boolean = false

  // What this element has reported and not yet ended: PRESS_IN_FLIGHT from onTriggerDown until the
  // one end event (onTriggerUp, onTriggerEndOutside or onTriggerCanceled) that pairs with it, and
  // HOVER_IN_FLIGHT from onHoverEnter until its onHoverExit, and DRAG_IN_FLIGHT from
  // onInteractableDragStart until its onInteractableDragEnd. Also INPUT_PAUSED while inputPaused,
  // and PRESS_DROPPED on a press that pausing dropped. One field for all: subclasses such as Button
  // sit close to the engine's own-property limit.
  private _input: number = 0

  // Backing events grouped into one own-property (was 7 separate fields). Public access is via
  // the lazy getters below; internal dispatch uses these directly (e.g. this._events.sizeChanged.invoke()).
  protected readonly _events = {
    initialized: new ReplayEvent<void>(),
    stateChanged: new ReplayEvent<StateName>(),
    hoverEnter: new Event<InteractorEvent>(),
    hoverExit: new Event<InteractorEvent>(),
    triggerDown: new Event<InteractorEvent>(),
    triggerUp: new Event<InteractorEvent>(),
    triggerEndOutside: new Event<InteractorEvent>(),
    triggerCanceled: new Event<InteractorEvent>(),
    sizeChanged: new Event<vec3>()
  }

  private _onInitialized?: PublicApi<void>
  /**
   * A public API event that is triggered when the element is initialized.
   */
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this._events.initialized.publicApi())
  }

  private _onStateChanged?: PublicApi<StateName>
  /**
   * An event that is triggered whenever the state of the element changes.
   */
  public get onStateChanged(): PublicApi<StateName> {
    return (this._onStateChanged ??= this._events.stateChanged.publicApi())
  }

  private _onHoverEnter?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a hover interaction starts on the element.
   */
  public get onHoverEnter(): PublicApi<InteractorEvent> {
    return (this._onHoverEnter ??= this._events.hoverEnter.publicApi())
  }

  private _onHoverExit?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a hover interaction ends on the element.
   */
  public get onHoverExit(): PublicApi<InteractorEvent> {
    return (this._onHoverExit ??= this._events.hoverExit.publicApi())
  }

  private _onTriggerDown?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a trigger interaction starts on the element.
   */
  public get onTriggerDown(): PublicApi<InteractorEvent> {
    return (this._onTriggerDown ??= this._events.triggerDown.publicApi())
  }

  private _onTriggerUp?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a trigger interaction ends on the element. Only ends a press
   * that onTriggerDown reported and nothing else ended; see onTriggerEndOutside.
   */
  public get onTriggerUp(): PublicApi<InteractorEvent> {
    return (this._onTriggerUp ??= this._events.triggerUp.publicApi())
  }

  private _onTriggerEndOutside?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a press ends with the interactor off the element, e.g. a pinch
   * released after the ray left it.
   *
   * A press that onTriggerDown reported ends with one of onTriggerUp, onTriggerEndOutside or
   * onTriggerCanceled, never more than one, and none of them fires without an onTriggerDown first.
   * This one still fires if the element became inactive during the press.
   */
  public get onTriggerEndOutside(): PublicApi<InteractorEvent> {
    return (this._onTriggerEndOutside ??= this._events.triggerEndOutside.publicApi())
  }

  private _onTriggerCanceled?: PublicApi<InteractorEvent>
  /**
   * An event that is triggered when a press ends without a release, e.g. a parent ScrollWindow took
   * the gesture over, the hand was lost, or the element was disabled or made inactive mid-press. A
   * release that arrives while the element is inactive also ends the press here, since onTriggerUp
   * does not fire for an inactive element.
   *
   * Fires once per press, only after onTriggerDown, and only when the last interactor holding the
   * element lets go: losing one of two hands does not end the press.
   */
  public get onTriggerCanceled(): PublicApi<InteractorEvent> {
    return (this._onTriggerCanceled ??= this._events.triggerCanceled.publicApi())
  }

  private _onSizeChanged?: PublicApi<vec3>
  /**
   * An event that is triggered when the size of the element changes.
   */
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._onSizeChanged ??= this._events.sizeChanged.publicApi())
  }

  // Interactable listener unsubscribes. Bound at registration (setUpInteractableListeners) and
  // torn down by draining these arrays. Replaces eager `.bind(this)` handler fields and lets
  // subclasses toggle drag listeners without disturbing hover/trigger/toggle subscriptions.
  private interactableStateUnsubs: unsubscribe[] = []
  private interactableHoverUnsubs: unsubscribe[] = []
  private interactableTriggerUnsubs: unsubscribe[] = []
  private interactableDraggableUnsubs: unsubscribe[] = []

  /**
   * Gets the layout width in local space centimeters.
   * @returns The current width of the element.
   */
  public get width(): number {
    return this._size.x
  }

  /**
   * Sets the layout width in local space centimeters.
   * @param value - The new width value.
   */
  public set width(value: number) {
    this.size = new vec3(value, this._size.y, this._size.z)
  }

  /**
   * Gets the layout height in local space centimeters.
   * @returns The current height of the element.
   */
  public get height(): number {
    return this._size.y
  }

  /**
   * Sets the layout height in local space centimeters.
   * @param value - The new height value.
   */
  public set height(value: number) {
    this.size = new vec3(this._size.x, value, this._size.z)
  }

  /**
   * Gets the layout depth in local space centimeters.
   * @returns The current depth of the element.
   */
  public get depth(): number {
    return this._size.z
  }

  /**
   * Sets the layout depth in local space centimeters.
   * @param value - The new depth value.
   */
  public set depth(value: number) {
    this.size = new vec3(this._size.x, this._size.y, value)
  }

  /**
   * Gets the layout size as a vec3.
   * @returns The layout size with width, height, and depth.
   */
  public get layoutSize(): vec3 {
    return this._size
  }

  /**
   * Gets the transform associated with this element.
   *
   * @returns {Transform} The transform of the element.
   */
  public get transform(): Transform {
    return this._transform
  }

  /**
   * Gets the children of the element that are not managed by the element.
   *
   * @returns {SceneObject[]} The children of the element that are not managed by the element.
   */
  public get contentChildren(): SceneObject[] {
    return this.sceneObject.children.filter((child) => !this.managedSceneObjects.has(child))
  }

  /**
   * Gets the number of children of the element that are not managed by the element.
   *
   * @returns {number} The number of children of the element that are not managed by the element.
   */
  public get contentChildrenCount(): number {
    let managedChildrenCount = 0
    this.managedSceneObjects.forEach((child) => {
      if (child.getParent() === this.sceneObject) {
        managedChildrenCount++
      }
    })
    return this.sceneObject.children.length - managedChildrenCount
  }

  /**
   * Register an externally-managed SceneObject so it is excluded from
   * contentChildren and destroyed on release().
   */
  public registerManagedChild(sceneObject: SceneObject): void {
    this.managedSceneObjects.add(sceneObject)
  }

  /**
   * Gets the ColliderComponent instance associated with this element.
   * The collider is used for detecting interactions or collisions with the element.
   *
   * @returns {ColliderComponent} The collider instance.
   */
  public get collider(): ColliderComponent {
    return this._collider
  }

  /**
   * Gets whether the collider automatically fits the element's size.
   *
   * @returns {boolean} True if the collider fits the element, false if using custom size/position.
   */
  public get colliderFitElement(): boolean {
    return this._colliderFitElement
  }

  /**
   * Sets whether the collider should automatically fit the element's size.
   *
   * @param colliderFitElement - True to make the collider fit the element, false to use custom size/position.
   */
  public set colliderFitElement(colliderFitElement: boolean) {
    this._colliderFitElement = colliderFitElement
    if (this._initialized) {
      if (this._colliderFitElement) {
        const delta = this.deltaPosition.div(this.deltaScale)
        this.colliderShape.size = this._size.add(delta)
        this.colliderTransform.setLocalPosition(vec3.zero())
      } else {
        this.colliderShape.size = this._colliderSize
        this.colliderTransform.setLocalPosition(this._colliderCenter)
      }
      this._collider.shape = this.colliderShape
    }
  }

  /**
   * Gets the custom size of the collider.
   * This size is only used when colliderFitElement is false.
   *
   * @returns {vec3} The custom collider size in local space coordinates.
   */
  public get colliderSize(): vec3 {
    return this._colliderSize
  }

  /**
   * Sets the custom size of the collider.
   * This size is only applied when colliderFitElement is false.
   *
   * @param size - The custom collider size in local space coordinates.
   */
  public set colliderSize(size: vec3) {
    this._colliderSize.x = size.x
    this._colliderSize.y = size.y
    this._colliderSize.z = size.z
    if (this._initialized) {
      if (!this._colliderFitElement) {
        this.colliderShape.size = this._colliderSize
        this._collider.shape = this.colliderShape
      }
    }
  }

  /**
   * Gets the custom center position of the collider.
   * This position is only used when colliderFitElement is false.
   *
   * @returns {vec3} The custom collider center position in local space coordinates.
   */
  public get colliderCenter(): vec3 {
    return this._colliderCenter
  }

  /**
   * Sets the custom center position of the collider.
   * This position is only applied when colliderFitElement is false.
   *
   * @param center - The custom collider center position in local space coordinates.
   */
  public set colliderCenter(center: vec3) {
    this._colliderCenter = center
    if (this._initialized) {
      if (!this._colliderFitElement) {
        this.colliderTransform.setLocalPosition(this._colliderCenter)
      }
    }
  }

  /**
   * Gets the interactable property of the element.
   *
   * @returns {Interactable} The current interactable instance associated with this element.
   */
  public get interactable(): Interactable {
    return this._interactable
  }

  /**
   * Indicates whether the element has been initialized.
   *
   * @returns {boolean} `true` if the element is initialized, otherwise `false`.
   */
  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * Gets whether TriggerEnd audio playback is enabled.
   *
   * @returns {boolean} `true` if TriggerEnd audio plays on trigger up; otherwise, `false`.
   */
  public get playAudio(): boolean {
    return this._playAudio
  }

  /**
   * Sets whether TriggerEnd audio plays on trigger up.
   *
   * @param playAudio - A boolean indicating whether audio should be played.
   */
  public set playAudio(playAudio: boolean) {
    if (playAudio === undefined) {
      return
    }
    if (isEqual<boolean>(this._playAudio, playAudio)) {
      return
    }
    this._playAudio = playAudio
  }

  /**
   * Gets the audio track to be played at the end of a trigger event.
   *
   * @returns {AudioTrackAsset} The audio track asset associated with the trigger end event.
   */
  public get triggerEndAudioTrack(): AudioTrackAsset {
    return this._triggerEndAudioTrack
  }

  /**
   * Sets the audio track to be played at the end of a trigger event.
   *
   * @param audioTrack - The audio track asset to be assigned.
   */
  public set triggerEndAudioTrack(audioTrack: AudioTrackAsset) {
    if (audioTrack === undefined) {
      return
    }
    this._triggerEndAudioTrack = audioTrack
  }

  /**
   * Gets the volume level for the trigger end audio.
   *
   * @returns {number} The volume level for the trigger end audio.
   */
  public get triggerEndAudioVolume(): number {
    return this._triggerEndAudioVolume
  }

  /**
   * Sets the volume level for the trigger end audio.
   *
   * @param volume - The desired volume level as a number.
   */
  public set triggerEndAudioVolume(volume: number) {
    if (volume === undefined) {
      return
    }
    this._triggerEndAudioVolume = volume
  }

  /**
   * @returns is inactive or not
   */
  public get inactive() {
    return this._inactive
  }

  /**
   * @param inactive set is inactive or is not inactive
   */
  public set inactive(inactive: boolean) {
    if (inactive === undefined) {
      return
    }
    if (isEqual<boolean>(this._inactive, inactive)) {
      return
    }
    this._inactive = inactive
    if (this._initialized) {
      if (this._inactive) {
        // Drop any press in flight first. The state machine never sees IK's cancel for the
        // Interactable disabled below, so it would stay triggered.
        if (this._interactableStateMachine) {
          this._interactableStateMachine.handleOwnerInactive()
        }
        this.setState(StateName.inactive)
      }
      for (const {component, disabledWhenInactive} of this.managedComponents) {
        if (disabledWhenInactive && !isNull(component) && component) {
          component.enabled = !this._inactive
        }
      }
      // After the loop: resuming a press needs the Interactable enabled again.
      if (!this._inactive && !this.resumePress()) {
        if (this.stateName === StateName.inactive) {
          this.stateName = this.activeRestingState
        }
        this.setState(this.stateName)
      }
    }
  }

  /**
   * Whether the element's input is paused: it takes no hover, press or drag, and unlike
   * {@link inactive} it keeps its look. For moments a control must not take input, such as while
   * its panel moves or a command it started runs.
   *
   * Pausing drops a hover or press in flight. The press still ends with onTriggerEndOutside or
   * onTriggerCanceled, never onTriggerUp, even if input resumes before the release. A drag stops
   * where it is and keeps that value. It holds through the element or an ancestor being disabled
   * and enabled again, which turning the collider off does not.
   *
   * @returns Whether input is paused.
   */
  public get inputPaused(): boolean {
    return (this._input & INPUT_PAUSED) !== 0
  }

  /**
   * @param paused - Whether to pause the element's input. Safe before initialize.
   */
  public set inputPaused(paused: boolean) {
    if (paused === undefined || paused === this.inputPaused) {
      return
    }
    if (paused) {
      this._input |= INPUT_PAUSED
    } else {
      this._input &= ~INPUT_PAUSED
    }
    if (this._initialized) {
      this.applyInputPaused()
    }
  }

  // Pauses through the Interactable's targeting mode, which nothing rewrites after initialize. The
  // collider is no gate: Element's and IK's enable paths, Frame's button handler and ScrollWindow's
  // child pass all turn it back on. IK still sends the hover exit for an untargetable Interactable.
  private applyInputPaused(): void {
    const interactable = this._interactable
    const stateMachine = this._interactableStateMachine
    if (this.inputPaused) {
      targetingModesBeforePause.set(interactable, interactable.targetingMode)
      interactable.targetingMode = TargetingMode.None
      if ((this._input & PRESS_IN_FLIGHT) !== 0) {
        this._input |= PRESS_DROPPED
      }
      // Repaints the resting look, keeping a toggle. IK keeps a pinch on its target until the
      // release, so the machine then ignores the rest of the press.
      stateMachine.inputPaused = true
      stateMachine.handleOwnerDisabled()
    } else {
      // A mode someone else wrote while paused is left alone.
      if (interactable.targetingMode === TargetingMode.None) {
        interactable.targetingMode = targetingModesBeforePause.get(interactable) ?? TargetingMode.All
      }
      targetingModesBeforePause.delete(interactable)
      stateMachine.inputPaused = false
    }
  }

  /**
   * The state painted when the element stops being inactive and no press is in flight.
   * BaseButton returns toggledDefault while it is on.
   */
  protected get activeRestingState(): StateName {
    return StateName.default
  }

  /**
   * @returns current size
   */
  public get size(): vec3 {
    return this._size
  }

  /**
   * Sets current size. Stores by copy via `copyFrom`, so callers may reuse
   * the same vec3 reference across multiple setters (e.g. when sizing two
   * sibling Elements with one local). External mutation of the passed vec3
   * after the call does not alias this Element's `_size`.
   *
   * @param size set current size
   */
  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    if (isEqual<vec3>(this._size, size)) {
      return
    }
    this._size.copyFrom(size)
    if (this._initialized) {
      if (this._colliderFitElement) {
        const delta = this.deltaPosition.div(this.deltaScale)
        this.colliderShape.size = this._size.add(delta)
        this._collider.shape = this.colliderShape
      }
      this._events.sizeChanged.invoke(this._size)
    }
  }

  /**
   * Determines whether the element is draggable.
   *
   * @returns {boolean} Always returns `false`, indicating that the element is not draggable.
   */
  public get isDraggable() {
    return false
  }

  protected get shouldEnableInstantDrag(): boolean {
    return this.isDraggable
  }

  /**
   * Initializes the element and its associated components. This method ensures that
   * the element is set up properly, including its collider, interactable state, size,
   * and event listeners.
   *
   * Subclass overrides must stop their own initialization when this returns
   * `false`; that means an earlier call already initialized the hierarchy.
   *
   * @returns `true` when initialization ran, or `false` when already initialized.
   */
  public initialize(): boolean {
    if (this._initialized) {
      return false
    }

    this.colliderObject = global.scene.createSceneObject("Collider")
    this.managedSceneObjects.add(this.colliderObject)
    this.colliderObject.setParent(this.sceneObject)
    this.colliderTransform = this.colliderObject.getTransform()
    this._collider = this.colliderObject.createComponent("ColliderComponent")
    this.collider.fitVisual = false
    this.colliderShape = Shape.createBoxShape()
    if (this._colliderFitElement) {
      const delta = this.deltaPosition.div(this.deltaScale)
      this.colliderShape.size = this._size.add(delta)
      this.colliderTransform.setLocalPosition(vec3.zero())
    } else {
      this.colliderShape.size = this._colliderSize
      this.colliderTransform.setLocalPosition(this._colliderCenter)
    }
    this._collider.shape = this.colliderShape
    this._collider.enabled = !this._inactive
    this.addInteractionComponent(this._collider)

    this._interactable =
      this.sceneObject.getComponent(Interactable.getTypeName()) ||
      this.sceneObject.createComponent(Interactable.getTypeName())
    this._interactable.targetingMode = TargetingMode.All
    this._interactable.enableInstantDrag = this.shouldEnableInstantDrag
    this.addInteractionComponent(this._interactable)
    this._interactableStateMachine = new InteractableStateMachine(this._interactable, this.sceneObject)
    this._interactableStateMachine.initialize()
    this._interactableStateMachine.isDraggable = this.isDraggable
    if (this.inputPaused) {
      this.applyInputPaused()
    }
    this._interactable.enabled = !this._inactive

    this.setUpInteractableListeners()

    this.beforeInitialized()

    this._initialized = true

    if (this._inactive) {
      // A pre-init inactive was only recorded; clear the flag so the setter's
      // equality guard does not no-op the deferred state application.
      this._inactive = false
      this.inactive = true
    } else {
      this.setState(this.stateName)
    }

    this._events.initialized.invoke()
    return true
  }

  protected setUpEventCallbacks() {}

  /**
   * Performs subclass-specific pre-initialization work after interaction setup
   * completes and before the initial state is applied. This includes event
   * callback registration. `initialized` is still false while this hook runs.
   */
  protected beforeInitialized() {
    this.setUpEventCallbacks()
  }

  protected update() {}

  protected release() {
    this.removeInteractableListeners()
    if (this._interactableStateMachine) {
      this._interactableStateMachine.teardown()
    }

    for (const {component} of this.managedComponents) {
      if (!isNull(component) && component) {
        component.destroy()
      }
    }
    this.managedComponents = []
    this.managedSceneObjects.forEach((sceneObject) => {
      if (!isNull(sceneObject) && sceneObject) {
        sceneObject.destroy()
      }
    })
    this.managedSceneObjects.clear()
  }

  protected setState(stateName: StateName) {
    this.stateName = stateName
    this._events.stateChanged.invoke(stateName)
  }

  protected get isToggle(): boolean {
    return false
  }

  protected get deltaPosition(): vec3 {
    return this.currentPosition.sub(this.initialPosition)
  }

  protected get deltaScale(): vec3 {
    return this.currentScale.div(this.initialScale)
  }

  protected setUpInteractableListeners() {
    if (this._interactableStateMachine) {
      this._interactableStateMachine.isToggle = this.isToggle
      this.setUpInteractableStateListeners()
      this.setUpInteractableHoverListeners()
      this.setUpInteractableTriggerListeners()
      this.syncInteractableDraggableState()
    }
  }

  protected removeInteractableListeners() {
    this.drainInteractableUnsubscribes(this.interactableStateUnsubs)
    this.drainInteractableUnsubscribes(this.interactableHoverUnsubs)
    this.drainInteractableUnsubscribes(this.interactableTriggerUnsubs)
    this.removeInteractableDraggableListeners()
  }

  private setUpInteractableStateListeners(): void {
    if (!this._interactableStateMachine || this.interactableStateUnsubs.length > 0) {
      return
    }

    const u = this.interactableStateUnsubs
    u.push(this._interactableStateMachine.onDefault.add(this.gatedOnInactive((e) => this.onInteractableDefault(e))))
    u.push(this._interactableStateMachine.onHovered.add(this.gatedOnInactive((e) => this.onInteractableHovered(e))))
    u.push(this._interactableStateMachine.onTriggered.add(this.gatedOnInactive((e) => this.onInteractableTriggered(e))))
    u.push(
      this._interactableStateMachine.onToggledDefault.add(
        this.gatedOnInactive((e) => this.onInteractableToggledDefault(e))
      )
    )
    u.push(
      this._interactableStateMachine.onToggledHovered.add(
        this.gatedOnInactive((e) => this.onInteractableToggledHovered(e))
      )
    )
    u.push(
      this._interactableStateMachine.onToggledTriggered.add(
        this.gatedOnInactive((e) => this.onInteractableToggledTriggered(e))
      )
    )
  }

  protected setUpInteractableHoverListeners(): void {
    if (!this._interactable || this.interactableHoverUnsubs.length > 0) {
      return
    }

    const u = this.interactableHoverUnsubs
    u.push(this.interactable.onHoverEnter.add(this.gatedOnInput((e) => this.onHoverEnterHandler(e))))
    // Not gated, like the press's end events: going inactive while hovered disables the Interactable,
    // and IK's HoverExit for it arrives after the flag is set. A reported enter still gets its exit.
    u.push(this.interactable.onHoverExit.add((e) => this.onHoverExitHandler(e)))
  }

  protected setUpInteractableTriggerListeners(): void {
    if (!this._interactable || this.interactableTriggerUnsubs.length > 0) {
      return
    }

    const u = this.interactableTriggerUnsubs
    u.push(this.interactable.onTriggerStart.add(this.gatedOnInput((e) => this.onTriggerDownHandler(e))))
    // The end events are not gated: making the element inactive mid-press disables its
    // Interactable, and IK delivers the resulting TriggerCanceled after the flag is set. A press
    // that reported its start must still report its end, so a release while inactive, which must
    // not read as onTriggerUp, ends it as a cancel. So does the release of a press pausing dropped:
    // IK counts a poke as ending on its target whatever its targeting mode.
    u.push(
      this.interactable.onTriggerEnd.add((e) =>
        this._inactive || (this._input & PRESS_DROPPED) !== 0
          ? this.onTriggerCanceledHandler(e)
          : this.onTriggerUpHandler(e)
      )
    )
    u.push(this.interactable.onTriggerEndOutside.add((e) => this.onTriggerEndOutsideHandler(e)))
    u.push(this.interactable.onTriggerCanceled.add((e) => this.onTriggerCanceledHandler(e)))
  }

  protected setUpInteractableDraggableListeners(): void {
    if (!this._interactable || !this.isDraggable || this.interactableDraggableUnsubs.length > 0) {
      return
    }

    const u = this.interactableDraggableUnsubs
    // An inactive or paused element never starts or moves a drag, even when a host re-enabled its
    // Interactable (VirtualizedLayout) or IK kept a pinch on it. The end is not gated, so a drag in
    // progress when the element went inactive or paused still finishes and clears its state. Updates
    // and the end only run for a drag whose start ran: IK still ends one it started while the
    // element was inactive or paused, and overrides such as Switch's and ConfirmationSlider's end act
    // without checking.
    u.push(this._interactable.onDragStart.add(this.gatedOnInput((e) => this.startDrag(e))))
    u.push(this._interactable.onDragUpdate.add(this.gatedOnInput((e) => this.updateDrag(e))))
    u.push(this._interactable.onDragEnd.add((e) => this.endDrag(e)))
  }

  private startDrag(event: DragInteractorEvent): void {
    this._input |= DRAG_IN_FLIGHT
    this.onInteractableDragStart(event)
  }

  private updateDrag(event: DragInteractorEvent): void {
    if ((this._input & DRAG_IN_FLIGHT) !== 0) {
      this.onInteractableDragUpdate(event)
    }
  }

  private endDrag(event: DragInteractorEvent): void {
    if ((this._input & DRAG_IN_FLIGHT) === 0) {
      return
    }
    this._input &= ~DRAG_IN_FLIGHT
    this.onInteractableDragEnd(event)
  }

  protected removeInteractableDraggableListeners(): void {
    this.drainInteractableUnsubscribes(this.interactableDraggableUnsubs)
    // The end of a drag in flight will not arrive now.
    this._input &= ~DRAG_IN_FLIGHT
  }

  protected syncInteractableDraggableState(): void {
    const draggable = this.isDraggable
    if (this._interactableStateMachine) {
      this._interactableStateMachine.isDraggable = draggable
    }
    if (this._interactable) {
      this._interactable.enableInstantDrag = this.shouldEnableInstantDrag
    }

    if (draggable) {
      this.setUpInteractableDraggableListeners()
    } else {
      this.removeInteractableDraggableListeners()
    }
  }

  private drainInteractableUnsubscribes(unsubscribes: unsubscribe[]): void {
    for (let i = 0; i < unsubscribes.length; i++) {
      unsubscribes[i]()
    }
    unsubscribes.length = 0
  }

  // Gates at the registration seam: hosts (e.g. VirtualizedLayout) rewrite
  // collider/interactable enablement, so disabled components can't gate input.
  private gatedOnInactive<E>(handler: (event: E) => void): (event: E) => void {
    return (event) => {
      if (this._inactive) {
        return
      }
      handler(event)
    }
  }

  // Also gated while input is paused. Not used for the state events, which repaint a paused
  // element's resting look and a toggle set from script.
  private gatedOnInput<E>(handler: (event: E) => void): (event: E) => void {
    return (event) => {
      if (this._inactive || (this._input & INPUT_PAUSED) !== 0) {
        return
      }
      handler(event)
    }
  }

  private onInteractableDefault(_: StateEvent) {
    this.setState(this._hasError ? StateName.error : StateName.default)
  }

  private onInteractableHovered(_: StateEvent) {
    this.setState(this._hasError ? StateName.errorHovered : StateName.hovered)
  }

  private onInteractableTriggered(_: StateEvent) {
    this.setState(StateName.triggered)
  }

  private onInteractableToggledDefault(_: StateEvent) {
    this.setState(StateName.toggledDefault)
  }

  private onInteractableToggledHovered(_: StateEvent) {
    this.setState(StateName.toggledHovered)
  }

  private onInteractableToggledTriggered(_: StateEvent) {
    this.setState(StateName.toggledTriggered)
  }

  protected onHoverEnterHandler(event: InteractorEvent) {
    if (event.propagationPhase !== "Target") {
      return
    }
    this._input |= HOVER_IN_FLIGHT
    this._events.hoverEnter.invoke(event)
  }

  protected onHoverExitHandler(event: InteractorEvent) {
    // Only the exit of a reported enter, once: an inactive element whose Interactable a host
    // re-enabled (VirtualizedLayout) can get IK hover events that never raised onHoverEnter.
    if (event.propagationPhase !== "Target" || (this._input & HOVER_IN_FLIGHT) === 0) {
      return
    }
    this._input &= ~HOVER_IN_FLIGHT
    this._events.hoverExit.invoke(event)
  }

  protected onTriggerDownHandler(event: InteractorEvent) {
    if (event.propagationPhase !== "Target") {
      return
    }
    log.d(`${this.sceneObject.name} onTriggerDown by ${event.interactor.inputType}`)
    this._input |= PRESS_IN_FLIGHT
    this._events.triggerDown.invoke(event)
  }

  protected onTriggerUpHandler(event: InteractorEvent) {
    if (!this.endPress(event)) {
      return
    }
    log.d(`${this.sceneObject.name} onTriggerUp by ${event.interactor.inputType}`)
    this.playAudioTrack(this._triggerEndAudioTrack, this._triggerEndAudioVolume)
    this._events.triggerUp.invoke(event)
  }

  protected onTriggerEndOutsideHandler(event: InteractorEvent) {
    if (!this.endPress(event)) {
      return
    }
    log.d(`${this.sceneObject.name} onTriggerEndOutside by ${event.interactor.inputType}`)
    this._events.triggerEndOutside.invoke(event)
  }

  protected onTriggerCanceledHandler(event: InteractorEvent) {
    // Unlike its TriggerEnd, IK fires TriggerCanceled for every interactor, and several times in
    // one frame when a hand is lost. It clears the canceled interactor before invoking, so one
    // still listed means another hand holds the press.
    if (this.interactable.triggeringInteractor !== InteractorInputType.None || !this.endPress(event)) {
      return
    }
    log.d(`${this.sceneObject.name} onTriggerCanceled by ${event.interactor.inputType}`)
    this._events.triggerCanceled.invoke(event)
  }

  // Ends the press onTriggerDown reported, once. False for other phases or with no press in flight.
  private endPress(event: InteractorEvent): boolean {
    if (event.propagationPhase !== "Target" || (this._input & PRESS_IN_FLIGHT) === 0) {
      return false
    }
    this._input &= ~(PRESS_IN_FLIGHT | PRESS_DROPPED)
    return true
  }

  // Puts back the pressed look of a press that outlived going inactive or disabled: active again
  // within the frame, IK never cancels it, so its release still comes and must run from triggered.
  // Never one pausing dropped.
  private resumePress(): boolean {
    return (
      (this._input & (PRESS_IN_FLIGHT | PRESS_DROPPED | INPUT_PAUSED)) === PRESS_IN_FLIGHT &&
      this._interactableStateMachine?.resumePress() === true
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onInteractableDragStart(dragEvent: DragInteractorEvent) {
    if (this._colliderFitElement) {
      const delta = this.deltaPosition.div(this.deltaScale)
      this.colliderShape.size = this._size.add(delta).uniformScale(ENLARGE_COLLIDER_MULTIPLIER)
      this._collider.shape = this.colliderShape
    }
    this._isDragged = true
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onInteractableDragUpdate(dragEvent: DragInteractorEvent) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onInteractableDragEnd(dragEvent: DragInteractorEvent) {
    if (this._colliderFitElement) {
      const delta = this.deltaPosition.div(this.deltaScale)
      this.colliderShape.size = this._size.add(delta)
      this._collider.shape = this.colliderShape
    }
    this._isDragged = false
  }

  protected getInteractionPosition(interactor: Interactor): vec3 | null {
    let currentInteractionPosition: vec3 | null = null
    if (interactor instanceof HandInteractor) {
      const hand = interactor.hand
      // Pinch drag update does not update the target hit position
      if (interactor.activeTargetingMode === TargetingMode.Direct) {
        currentInteractionPosition = this._transform
          .getInvertedWorldTransform()
          .multiplyPoint(hand.indexTip.position.add(hand.thumbTip.position).uniformScale(0.5))
      } else if (interactor.planecastPoint) {
        currentInteractionPosition = this._transform
          .getInvertedWorldTransform()
          .multiplyPoint(interactor.planecastPoint)
      } else {
        currentInteractionPosition = this._transform.getInvertedWorldTransform().multiplyPoint(hand.indexTip.position)
      }
    } else if (interactor.planecastPoint) {
      currentInteractionPosition = this._transform.getInvertedWorldTransform().multiplyPoint(interactor.planecastPoint)
    }
    return currentInteractionPosition
  }

  /**
   * Plays the specified audio track at the given volume.
   *
   * @param audioTrack - The audio track asset to be played.
   * @param volume - The volume level at which the audio track should be played.
   */
  protected playAudioTrack(audioTrack: AudioTrackAsset, volume: number) {
    if (this._playAudio && audioTrack) {
      UIKitAudioPlayer.getInstance().play(audioTrack, volume)
    }
  }

  public onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this))
    // Only run a per-frame UpdateEvent when a subclass actually overrides the
    // (empty) base update(); otherwise every Element pays an idle trampoline.
    if (this.update !== Element.prototype.update) {
      this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
    }
    this.createEvent("OnDestroyEvent").bind(this.onDestroy.bind(this))
    this.createEvent("OnEnableEvent").bind(this.onEnabled.bind(this))
    this.createEvent("OnDisableEvent").bind(this.onDisabled.bind(this))
  }

  private onStart() {
    if (!this._initialized) {
      this.initialize()
    }
  }

  private onUpdate() {
    if (this._initialized) {
      this.update()
    }
  }

  private onDestroy() {
    this.release()
  }

  protected onEnabled() {
    this.enableManagedComponents()
    if (this._initialized && !this._inactive) {
      this.resumePress()
    }
  }

  protected onDisabled() {
    this.disableManagedComponents()
  }

  /**
   * Register a component to follow this Element's enable/disable lifecycle.
   * It always re-enables when the SceneObject is enabled. Use this for visuals
   * and sub-widgets that should not be gated by the inactive state.
   */
  protected addManagedComponent(component: Component): void {
    this.managedComponents.push({component, disabledWhenInactive: false})
  }

  /**
   * Register an interaction component (interactable, collider) whose enablement
   * follows the `inactive` flag: it stays disabled while inactive, including
   * across a disabled->enabled SceneObject transition. Keeps the inactive
   * invariant intact without hardcoding component identities in the enable path.
   */
  protected addInteractionComponent(component: Component): void {
    this.managedComponents.push({component, disabledWhenInactive: true})
  }

  /**
   * Stop managing a component (e.g. before destroying it). Removes it from both
   * the lifecycle loop and any inactive gating.
   */
  protected removeManagedComponent(component: Component): void {
    const index = this.managedComponents.findIndex((managed) => managed.component === component)
    if (index !== -1) {
      this.managedComponents.splice(index, 1)
    }
  }

  protected enableManagedComponents() {
    for (const {component, disabledWhenInactive} of this.managedComponents) {
      if (!isNull(component) && component) {
        // Interaction components stay disabled while the element is inactive so
        // the inactive state survives a disabled->enabled SceneObject
        // transition; everything else re-enables with the SceneObject.
        component.enabled = !(this._inactive && disabledWhenInactive)
      }
    }
  }

  protected disableManagedComponents() {
    for (const {component} of this.managedComponents) {
      if (!isNull(component) && component) {
        component.enabled = false
        if (component === this._interactable && this._interactableStateMachine) {
          this._interactableStateMachine.handleOwnerDisabled()
        }
      }
    }
  }
}
