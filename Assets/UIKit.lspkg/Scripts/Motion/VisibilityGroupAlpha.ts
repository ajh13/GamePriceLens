/**
 * Routes Motion's alpha channel through VisibilityGroup: Motion owns time,
 * the group owns the write.
 *
 * Provider policy — compose, never fight. A SceneObject target covered by a
 * group resolves to a subtree opacity SCALE on that group
 * (setOpacityScale), which multiplies with the group's own fades instead of
 * overwriting them. Driving a group's whole fade (group.opacity) is an owner
 * decision: pass the group itself as the alpha target — it satisfies the
 * opacity-writer shape directly and needs no provider.
 *
 * Non-SceneObject targets (plain opacity writers, Elements' own paths) fall
 * through untouched.
 */

import {OpacityWriter, registerAlphaWriterProvider} from "Motion.lspkg/Channels"
import {VisibilityGroup} from "../Utility/VisibilityGroup"

/** Composes a per-subtree fade with the covering group's own fades. */
class GroupScaleWriter implements OpacityWriter {
  private group: VisibilityGroup
  private node: SceneObject

  public constructor(group: VisibilityGroup, node: SceneObject) {
    this.group = group
    this.node = node
  }

  public get opacity(): number {
    return this.group.getOpacityScale(this.node)
  }

  public set opacity(value: number) {
    this.group.setOpacityScale(this.node, value)
  }
}

let registered = false

export function registerVisibilityGroupAlpha(): void {
  if (registered) {
    return
  }
  registered = true
  registerAlphaWriterProvider((target: unknown): OpacityWriter | null => {
    // Duck-typed SceneObject check (engine classes are not runtime globals).
    // `== null` catches undefined too — `typeof (undefined).x` throws.
    const node = target as SceneObject
    if (node == null || typeof node.getParent !== "function" || typeof node.getChildrenCount !== "function") {
      return null
    }
    const group = VisibilityGroup.groupFor(node)
    if (group === null) {
      return null
    }
    return new GroupScaleWriter(group, node)
  })
}
