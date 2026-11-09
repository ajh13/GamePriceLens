import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {UpdateDispatcher} from "Leaf.lspkg/Utils/common/UpdateDispatcher"

/**
 * Augment LensCore's `Pass` with the shader-graph properties the overlay
 * material exposes at runtime but doesn't declare statically (the .mat
 * is authored in the shader graph; the d.ts doesn't reflect it).
 */
declare global {
  interface Pass {
    baseTex: Texture
  }
}

/** Lens Studio's fixed render-layer count (0..31). */
const LS_LAYER_COUNT = 32

/** Camera-placement parameters relative to the user (centimeters). */
const CAMERA_PLACEMENT = {
  /** Horizontal distance from the user. */
  distanceCm: 500,
  /** Height above eye level. */
  heightCm: 200,
  /**
   * Vertical drop below eye level for the look-at point. Tuned to land
   * near the avatar's chest now that the Bitmoji root sits ~143cm below
   * the user's eye line.
   */
  lookAtDropCm: 90,
}

/** Perspective camera that captures the avatar into the overlay texture. */
const PERSP_CAMERA = {
  fovDegrees: 50,
  /** Drawn first — the result is the texture the ortho compositor samples. */
  renderOrder: 0,
}

/** Orthographic compositor that draws the overlay image on screen. */
const ORTHO_COMPOSITOR = {
  /** > the device preview UI render order so the overlay isn't occluded. */
  renderOrder: 1000,
  nearPlane: -1,
  farPlane: 200,
}

/** Dedicated lighting for the layer-isolated overlay subject. */
const OVERLAY_LIGHTING = {
  keyIntensity: 1,
  fillIntensity: 0.6,
  /** 45° down, 45° right from world axes — soft 3/4 view of the avatar. */
  rotation: quat.fromEulerAngles(-Math.PI / 4, Math.PI / 4, 0),
}

/** Debug-overlay center in screen anchor space; (-1, -1) = bottom-left. */
const DEBUG_OVERLAY_CENTER = new vec2(-0.7, -0.7)
/** Debug-overlay image size in screen anchor space. */
const DEBUG_OVERLAY_SIZE = new vec2(0.55, 0.55)
/** Dark-purple debug-overlay background — set as the persp camera's clear color. */
const DEBUG_OVERLAY_BACKING_COLOR = new vec4(0.18, 0.08, 0.32, 1)

export type ThirdPersonCameraConfig = {
  /**
   * Optional layer restriction — only SceneObjects on this layer appear
   * in the debug overlay. Omit to render every scene object.
   */
  visibleLayer?: LayerSet
}

/**
 * Debug camera that renders the scene from a fixed diagonal viewpoint
 * relative to the user and composites the result as a debug overlay in
 * the bottom-left corner. Recreated per-instance so multi-player scenes
 * can give each player its own debug overlay.
 *
 * When `visibleLayer` is set, the camera also spawns a directional light
 * on the same layer so subjects rendered into the overlay aren't
 * silhouetted by the scene's lights ignoring that layer.
 */
export class ThirdPersonCamera {
  private readonly _cameraObject: SceneObject
  private readonly _orthoObject: SceneObject
  private readonly _lightObject?: SceneObject
  private readonly _unsubscribe: () => void
  private _destroyed = false

  constructor(config: ThirdPersonCameraConfig = {}) {
    /**
     * String literals — `requireAsset` is a compile-time resolver.
     * Assets live alongside this source file inside the package so the
     * scenario doesn't need to wire them up.
     */
    const renderTarget = requireAsset(
      "./bitmoji/Debug Render Target Persp.renderTarget",
    ) as Texture
    const debugOverlayMaterial = requireAsset(
      "./bitmoji/Image Persp.mat",
    ) as Material

    const debugOverlayLayer = LayerSet.makeUnique()

    this._cameraObject = global.scene.createSceneObject("ThirdPersonCam")
    const camera = this._cameraObject.createComponent(
      "Component.Camera",
    ) as Camera
    camera.type = Camera.Type.Perspective
    camera.fov = PERSP_CAMERA.fovDegrees * MathUtils.DegToRad
    camera.renderOrder = PERSP_CAMERA.renderOrder
    camera.renderTarget = renderTarget
    /**
     * Persp clears to dark purple — the renderTarget then has a solid
     * glass-like background wherever the avatar doesn't draw, so the
     * overlay image alone gives the boxed-frame look without a separate
     * backing.
     */
    if (camera.colorRenderTargets.length > 0) {
      camera.colorRenderTargets[0].clearColorOption =
        ClearColorOption.CustomColor
      camera.colorRenderTargets[0].clearColor = DEBUG_OVERLAY_BACKING_COLOR
    }
    /**
     * Default to rendering every layer so the Bitmoji / IK visuals
     * appear in the overlay without the caller enumerating layers.
     */
    camera.renderLayer = config.visibleLayer ?? allLayers()

    /**
     * When the overlay is layer-isolated, the scene's default-layer
     * lights won't reach the subject. Spawn a dedicated directional
     * light + ambient fill on the same layer so it's visibly lit
     * instead of silhouetted. LightSource defaults to Point at zero
     * distance, which doesn't reach the avatar.
     */
    if (config.visibleLayer) {
      this._lightObject = global.scene.createSceneObject(
        "ThirdPersonDebugOverlayLight",
      )
      this._lightObject.layer = config.visibleLayer

      const keyLight = this._lightObject.createComponent(
        "Component.LightSource",
      ) as LightSource
      keyLight.lightType = LightType.Directional
      keyLight.color = vec3.one()
      keyLight.intensity = OVERLAY_LIGHTING.keyIntensity
      keyLight.renderLayer = config.visibleLayer

      const fillLight = this._lightObject.createComponent(
        "Component.LightSource",
      ) as LightSource
      fillLight.lightType = LightType.Ambient
      fillLight.color = vec3.one()
      fillLight.intensity = OVERLAY_LIGHTING.fillIntensity
      fillLight.renderLayer = config.visibleLayer

      this._lightObject
        .getTransform()
        .setLocalRotation(OVERLAY_LIGHTING.rotation)
    }

    this._orthoObject = global.scene.createSceneObject(
      "ThirdPersonDebugOverlayOrtho",
    )
    const orthoCamera = this._orthoObject.createComponent(
      "Component.Camera",
    ) as Camera
    orthoCamera.type = Camera.Type.Orthographic
    orthoCamera.renderOrder = ORTHO_COMPOSITOR.renderOrder
    orthoCamera.renderTarget = global.scene.liveTarget
    orthoCamera.renderLayer = debugOverlayLayer
    orthoCamera.near = ORTHO_COMPOSITOR.nearPlane
    orthoCamera.far = ORTHO_COMPOSITOR.farPlane
    if (orthoCamera.colorRenderTargets.length > 0) {
      orthoCamera.colorRenderTargets[0].clearColorOption = ClearColorOption.None
    }

    const debugOverlayObject = global.scene.createSceneObject(
      "ThirdPersonDebugOverlay",
    )
    debugOverlayObject.setParent(this._orthoObject)
    debugOverlayObject.layer = debugOverlayLayer
    debugOverlayObject.getTransform().setLocalPosition(vec3.zero())

    const image = debugOverlayObject.createComponent("Component.Image") as Image
    image.addMaterial(debugOverlayMaterial)
    /**
     * Bind the render target to the material's base texture at runtime —
     * the .mat file's static reference can fail to resolve depending on
     * the order assets load in.
     */
    image.mainMaterial.mainPass.baseTex = renderTarget

    const screenTransform = debugOverlayObject.createComponent(
      "ScreenTransform",
    ) as ScreenTransform
    screenTransform.anchors.setCenter(DEBUG_OVERLAY_CENTER)
    screenTransform.anchors.setSize(DEBUG_OVERLAY_SIZE)

    this._unsubscribe = UpdateDispatcher.getInstance().onUpdate.add(() => {
      if (this._destroyed) return
      this.aim()
    })
  }

  /** Tear down the cameras and lights spawned by the constructor. Idempotent. */
  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this._unsubscribe()
    this._cameraObject.destroy()
    this._orthoObject.destroy()
    this._lightObject?.destroy()
  }

  /**
   * Reposition the debug camera each frame so it stays diagonally above
   * and in front of the user, looking back at them — so the Bitmoji's
   * face is visible in the overlay.
   */
  private aim(): void {
    const camera = WorldCameraFinderProvider.getInstance()
    const cameraPosition = camera.getWorldPosition()

    /** World-fixed front-left offset — head turns shouldn't spin the avatar in the overlay. */
    const offsetX = -Math.SQRT1_2
    const offsetZ = -Math.SQRT1_2
    const debugPosition = new vec3(
      cameraPosition.x + offsetX * CAMERA_PLACEMENT.distanceCm,
      cameraPosition.y + CAMERA_PLACEMENT.heightCm,
      cameraPosition.z + offsetZ * CAMERA_PLACEMENT.distanceCm,
    )
    this._cameraObject.getTransform().setWorldPosition(debugPosition)

    const targetY = cameraPosition.y - CAMERA_PLACEMENT.lookAtDropCm
    const pitch = Math.atan2(
      targetY - debugPosition.y,
      CAMERA_PLACEMENT.distanceCm,
    )
    // Look back from `offset` direction to the user.
    const yaw = Math.atan2(offsetX, offsetZ)
    this._cameraObject
      .getTransform()
      .setWorldRotation(quat.fromEulerAngles(pitch, yaw, 0))
  }
}

/** LayerSet covering every Lens Studio layer. */
function allLayers(): LayerSet {
  let layers = LayerSet.fromNumber(0)
  for (let i = 1; i < LS_LAYER_COUNT; i++) {
    layers = layers.union(LayerSet.fromNumber(i))
  }
  return layers
}
