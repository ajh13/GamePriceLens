const EDGE_FADE_MESH_MIN_RATIO = 0.0001
const EDGE_FADE_MESH_MAX_RATIO = 0.5

/**
 * Owns a normalized unit-plane mesh that only covers the top and bottom fade
 * bands. The material still receives full-window UVs, so shader output matches
 * a full quad without rasterizing the transparent interior. Updating the ratio
 * mutates the linked mesh instead of allocating a new RenderMesh.
 */
export class VerticalEdgeFadeBandMesh {
  public readonly mesh: RenderMesh

  private readonly meshBuilder = new MeshBuilder([
    {name: "position", components: 3},
    {name: "texture0", components: 2}
  ])
  private edgeRatio = Number.NaN

  public constructor(edgeRatio: number = EDGE_FADE_MESH_MAX_RATIO) {
    this.meshBuilder.topology = MeshTopology.Triangles
    this.meshBuilder.indexType = MeshIndexType.UInt16
    this.meshBuilder.appendVerticesInterleaved([
      -0.5, -0.5, 0, 0, 0, 0.5, -0.5, 0, 1, 0, -0.5, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0.5, -0.5, 0, 0, 0, 0.5, 0.5, 0, 0, 1,
      0.5, -0.5, 0.5, 0, 0, 1, 0.5, 0.5, 0, 1, 1
    ])
    this.meshBuilder.appendIndices([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6])

    if (!this.meshBuilder.isValid()) {
      throw new Error("EdgeFadeMesh: vertical edge fade band mesh data invalid")
    }

    this.setEdgeRatio(edgeRatio)
    this.mesh = this.meshBuilder.getMesh()
  }

  public setEdgeRatio(edgeRatio: number): void {
    const bandRatio = MathUtils.clamp(edgeRatio, EDGE_FADE_MESH_MIN_RATIO, EDGE_FADE_MESH_MAX_RATIO)
    if (bandRatio === this.edgeRatio) {
      return
    }

    this.edgeRatio = bandRatio
    const innerBottom = -0.5 + bandRatio
    const innerTop = 0.5 - bandRatio
    const innerUvBottom = bandRatio
    const innerUvTop = 1 - bandRatio

    this.meshBuilder.setVertexInterleaved(2, [-0.5, innerBottom, 0, 0, innerUvBottom])
    this.meshBuilder.setVertexInterleaved(3, [0.5, innerBottom, 0, 1, innerUvBottom])
    this.meshBuilder.setVertexInterleaved(4, [-0.5, innerTop, 0, 0, innerUvTop])
    this.meshBuilder.setVertexInterleaved(5, [0.5, innerTop, 0, 1, innerUvTop])
    this.meshBuilder.updateMesh()
  }
}
