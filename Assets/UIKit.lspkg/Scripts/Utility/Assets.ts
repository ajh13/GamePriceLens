// If Asset is used in multiple files, it should be exported here to avoid duplicate imports

// Materials
export const IMAGE_MATERIAL_ASSET: Material = requireAsset("../../Materials/Image.mat") as Material

// Meshes
export const UNIT_PLANE_MESH_ASSET: RenderMesh = requireAsset("../../Meshes/Unit Plane.mesh") as RenderMesh

// Textures
export const CHECK_DEFAULT_TEXTURE_ASSET: Texture = requireAsset("../../Textures/check_default.png") as Texture
export const CHECK_HOVERED_TEXTURE_ASSET: Texture = requireAsset("../../Textures/check_hovered.png") as Texture
export const CHECK_TOGGLED_TEXTURE_ASSET: Texture = requireAsset("../../Textures/check_toggledHovered.png") as Texture
