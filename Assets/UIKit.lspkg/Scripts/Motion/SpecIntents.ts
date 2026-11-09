/**
 * The System 3.0 intent catalog — statically typed choreography.
 *
 * `Intents.expand(refs)` and friends: each intent is a plain typed function
 * that builds and plays a timeline from the spec's engineering tables
 * (research brief 09). The STRUCTURE lives here; every NUMBER comes from the
 * profile — shared scales (durations/eases/staggers) plus per-intent recipes,
 * whose library defaults are the spec transcription (MotionTokens.ts). UIKit
 * components call the catalog and nothing else — the "motion is data" rule,
 * enforced by types instead of a string registry.
 *
 * Builders receive the profile EXPLICITLY. Resolution is intent-
 * CONSTRUCTION-time: a retained timeline keeps the values it was built with,
 * and switching the active profile affects only subsequently created motion.
 * Every invocation consults the comfort / reduced-motion policy (intent,
 * direction, profile → animate / snap / adjusted profile) before building.
 *
 * There is deliberately NO custom-intent registry: apps compose the engine
 * verbs (`Motion.to` / `timeline`) directly.
 *
 * Scenes are authored in their EXPANDED / default state ("layout is the
 * reference"); intents animate FROM minimized/collapsed values back to
 * whatever the scene says. Expand plays forward, collapse is the same
 * timeline played in reverse — with its own spec-mandated durations and
 * stagger schedule via directional values.
 */

import * as Channels from "Motion.lspkg/Channels"
import {easeInverse} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {AnimatableValue, DirectionalCallback} from "Motion.lspkg/MotionTypes"
import {distribute} from "Motion.lspkg/Stagger"
import {Timeline} from "Motion.lspkg/Timeline"
import {ScopeHooks, Tween} from "Motion.lspkg/Tween"
import {
  applyMotionPolicy,
  ensureProfileValidated,
  getActiveMotionProfile,
  MIN_LOOP_LEG_SECONDS,
  MotionProfile
} from "./MotionTokens"

const ch = Channels.ch

/** Floor for a keyframe leg — shared with recipe validation, which rejects
 * recipes whose derived legs would need it on a looping build. */
const MIN_KEYFRAME_LEG_SECONDS = MIN_LOOP_LEG_SECONDS

/**
 * One growth channel of an expanding surface: explicit collapsed (`from`) and
 * expanded (`to`) values, so the timeline is deterministic and reusable —
 * build once, play/reverse forever, independent of live state. A dropdown
 * passes a drawer-height channel + an anchor channel; the test surface passes
 * transform scale + position.
 */
export interface ExpandGrowthRef {
  target: unknown
  channel: Channels.ChannelSelector<AnimatableValue>
  from: AnimatableValue
  to: AnimatableValue
}

export interface ExpandRefs {
  /** Growth channels, all riding the same window (spec: BG scale + position). */
  growth: ExpandGrowthRef[]
  /** Optional BG fade writer (0→100% linear over the full expand). */
  bgFade?: Channels.OpacityWriter
  /** Item opacity writers in REVEAL order: the first element fades in first
   * on expand, and collapse retreats in reverse (last element first). Order
   * them in the drawer's opening direction — a drop-DOWN passes top→bottom,
   * a drop-UP bottom→top — so the reveal chases the growing edge and the
   * collapse walks back toward where the drawer emerged. */
  items?: Channels.OpacityWriter[]
  scope?: ScopeHooks
  /** forward=true → expanded state reached; false → collapsed. */
  onComplete?: DirectionalCallback
}

/**
 * "expand" — spec slide 15 (Dropdown etc. Transform). The intent four
 * components hand-rolled separately, named once:
 *  - BG growth Start→End, Enter bezier 667 ms; collapse Exit bezier 500 ms.
 *  - BG opacity 0→100% linear alongside.
 *  - Items fade 333 ms each, staggered in reveal order on expand
 *    (200+(n−1)·100 ms); collapse fades 183 ms each, in reverse (n·83 ms) —
 *    the caller orders `items` in the drawer's opening direction.
 */
function buildExpand(refs: ExpandRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: [profile.durations.exit, profile.durations.enter],
      ease: [profile.eases.exit, profile.eases.enter]
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })

  const recipe = profile.recipes.expand
  const itemCount = refs.items?.length ?? 0
  // Items are in REVEAL order (refs.items doc): expand fades them in first
  // element first; collapse retreats the way it came — last element first —
  // so the choreography always walks back toward where the drawer emerged.
  const collapseDelayOf = distribute(itemCount, {...profile.staggers.tight, from: "end"})
  // Collapse choreography: contents stagger out FIRST, then the container
  // closes over the emptying space — growth channels start (in reverse) as
  // the last item fade-out is finishing (stage elision, not a strict queue).
  // Expand is unchanged: room opens immediately, items reveal into it.
  // PROVISIONAL vs slide 15's simultaneous collapse — flagged for the spec
  // authors alongside the reveal-delay note.
  const collapseContentLead =
    itemCount > 0 ? Math.max(0, collapseDelayOf(0) + recipe.itemFade[0] - recipe.collapseStageOverlap) : 0

  const growth = refs.growth
  for (let i = 0; i < growth.length; i++) {
    timeline.add(
      growth[i].target,
      {channel: growth[i].channel, from: growth[i].from, to: growth[i].to},
      i === 0 ? {time: [collapseContentLead, 0]} : {at: "withPrevious"}
    )
  }
  if (refs.bgFade !== undefined) {
    timeline.add(refs.bgFade, {channel: ch.alpha, from: 0, to: 1, ease: profile.eases.linear}, {at: "withPrevious"})
  }

  const items = refs.items ?? []
  // The reveal delay is PROVISIONAL (slide 16's displaced-elements pattern,
  // not slide 15's 200 ms): items fading in under a still-moving make-room
  // row read as noise. Step sizes come from the stagger tokens.
  const expandDelay = distribute(itemCount, {
    ...profile.staggers.base,
    base: recipe.revealDelay,
    from: "start"
  })
  for (let i = 0; i < itemCount; i++) {
    timeline.add(
      items[i],
      {
        channel: ch.alpha,
        from: 0,
        to: 1,
        duration: recipe.itemFade,
        ease: profile.eases.linear
      },
      {time: [collapseDelayOf(i), expandDelay(i)]}
    )
  }
  return timeline
}

export interface NotificationExpandRefs {
  /** Notification background; authored state = expanded/default. */
  bg: SceneObject
  /** BG scale in the minimized state. */
  minimizedScale: vec3
  /** Elements pushed aside by the expansion, with their minimized positions. */
  displaced?: {target: SceneObject; minimizedPosition: vec3}[]
  /** Content that only exists expanded: fades in late, settles vertically. */
  revealed?: {fade: Channels.OpacityWriter; target?: SceneObject; minimizedPosition?: vec3}[]
  scope?: ScopeHooks
}

/**
 * "notification.expand" — spec slide 16 (Notification / AI Agent). BG scales
 * up over the full Enter duration; displaced elements ride the same window;
 * revealed content waits a beat (333 ms) then fades in (333 ms) while its
 * position settles over the full window — the reveal-in-the-second-half
 * choreography. Collapse = reverse (Exit curve/duration via defaults).
 */
function buildNotificationExpand(refs: NotificationExpandRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: [profile.durations.exit, profile.durations.enter],
      ease: [profile.eases.exit, profile.eases.enter]
    },
    scope: refs.scope
  })

  timeline.add(refs.bg, {channel: ch.scale, from: refs.minimizedScale})

  const displaced = refs.displaced ?? []
  for (let i = 0; i < displaced.length; i++) {
    timeline.add(
      displaced[i].target,
      {channel: ch.position, from: displaced[i].minimizedPosition},
      {at: "withPrevious"}
    )
  }

  const revealed = refs.revealed ?? []
  const revealRecipe = profile.recipes.notificationExpand
  for (let i = 0; i < revealed.length; i++) {
    timeline.add(
      revealed[i].fade,
      {
        channel: ch.alpha,
        from: 0,
        duration: revealRecipe.revealFade,
        ease: profile.eases.linear
      },
      {time: revealRecipe.revealDelay}
    )
    if (revealed[i].target !== undefined && revealed[i].minimizedPosition !== undefined) {
      timeline.add(
        revealed[i].target as SceneObject,
        {channel: ch.position, from: revealed[i].minimizedPosition as vec3},
        {time: 0}
      )
    }
  }
  return timeline
}

export interface PanelFadeRefs {
  /** The panel's fan-out alpha writer (body, buttons, drawer — one write). */
  alpha: Channels.OpacityWriter
  scope?: ScopeHooks
  /** forward=true → fully shown; false → fully hidden. */
  onComplete?: DirectionalCallback
}

/**
 * "panel.fade" — whole-panel show/hide fade. Grounded in spec slide 21
 * (fade in/out, linear, 333 ms) — the closest table for a plain panel fade;
 * legacy Frame used 0.4 s scaled by opacity delta. PROVISIONAL duration
 * pending a dedicated panel row in the spec. Hide = reverse; with a linear
 * ease, timeline progress equals alpha, which consumers use to resync after
 * external opacity writes.
 */
function buildPanelFade(refs: PanelFadeRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: profile.durations.base,
      ease: profile.eases.linear
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  timeline.add(refs.alpha, {channel: ch.alpha, from: 0, to: 1})
  return timeline
}

export interface DrawerSlideRefs {
  /** The sliding surface (e.g. the frame's right drawer root). */
  target: unknown
  /** Local position when tucked away. */
  hidden: vec3
  /** Local position when slid out. */
  visible: vec3
  scope?: ScopeHooks
  /** forward=true → fully visible; false → fully hidden. */
  onComplete?: DirectionalCallback
}

/**
 * "drawer.slide" — a side surface sliding out from behind its parent
 * (spec "Enter & Exit" family; no dedicated table row — legacy Frame drawer
 * used 0.5 s cubic out/in, which matches the Exit duration token; kept both
 * directions, PROVISIONAL). Decelerates out, accelerates back behind.
 */
function buildDrawerSlide(refs: DrawerSlideRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: profile.durations.exit,
      ease: profile.recipes.drawerSlide.ease
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  timeline.add(refs.target, {channel: ch.position, from: refs.hidden, to: refs.visible})
  return timeline
}

export interface HighlightRefs {
  /** Receives the highlight intensity (0..1) each tick. */
  apply: (value: number) => void
  /** Live intensity, for capture; defaults to 0. */
  read?: () => number
  scope?: ScopeHooks
  /** forward=true → fully highlighted; false → fully faded. */
  onComplete?: DirectionalCallback
}

/**
 * "highlight" — a hover/proximity intensity chasing 0↔1 (frame cursor
 * highlight, panel border fade). Retained: hover-out mid-hover-in reverses
 * from the current intensity — never a full-duration replay (the legacy
 * fixed-duration border fade bug). Duration/ease PROVISIONAL (quick +
 * linear ≈ the legacy 0.3 s linear pair) — no spec table for hover yet;
 * Palm UI (slide 24) will supersede.
 */
function buildHighlight(refs: HighlightRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: profile.durations.quick,
      ease: profile.eases.linear
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const read = refs.read ?? (() => 0)
  const channel = Channels.custom<number>("highlight", () => ({
    read,
    write: refs.apply
  }))
  timeline.add(refs, {channel, from: 0, to: 1})
  return timeline
}

export interface DialogEnterRefs {
  /** The dialog root (scaled for the pop). */
  target: SceneObject
  /** The root's authored local scale, captured before any motion. */
  authoredScale: vec3
  /** Whole-dialog alpha writer (typically the dialog's VisibilityGroup). */
  fade: Channels.OpacityWriter
  scope?: ScopeHooks
  /** forward=true → fully shown; false → fully hidden. */
  onComplete?: DirectionalCallback
}

/**
 * "dialog.enter" — a modal surface popping into the FOV: scales from 96% to
 * authored on the Enter bezier while fading in; exit is the reverse on the
 * Exit tuning. (Spec Enter & Exit family, within-FOV surfaces.)
 */
function buildDialogEnter(refs: DialogEnterRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {
      duration: [profile.durations.exit, profile.durations.enter],
      ease: [profile.eases.exit, profile.eases.enter]
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const authored = refs.authoredScale
  // Pop scale is PROVISIONAL — dialogs sit under Enter & Exit (slide 13)
  // with no engineering table yet.
  const pop = profile.recipes.dialogEnter.popScale
  timeline.add(refs.target, {
    channel: ch.scale,
    from: new vec3(authored.x * pop, authored.y * pop, authored.z * pop),
    to: new vec3(authored.x, authored.y, authored.z)
  })
  timeline.add(refs.fade, {channel: ch.alpha, from: 0, to: 1, ease: profile.eases.linear}, {at: "withPrevious"})
  return timeline
}

export interface HorizonRevealRefs {
  /** The materializing surface (frame root); receives position/scale/rotation.x. */
  target: unknown
  /** Authored local rest position — the pose the frame lands on. */
  restPosition: vec3
  /** Frame height in the target's local units (spawn offset = height/2 above rest). */
  height: number
  /** Authored local scale. */
  authoredScale: vec3
  /** Whole-frame alpha writer. */
  fade: Channels.OpacityWriter
  scope?: ScopeHooks
  /** forward=true → fully revealed at rest; false → closed at the horizon. */
  onComplete?: DirectionalCallback
}

/**
 * "horizon.reveal" — spec slide 26 (Spatial Spawning). Primary frames
 * materialize: position settles from half the frame's height above rest,
 * scale 50→100%, X-hinge 83°→0°, all riding the spawn duration (1 s Enter
 * bezier); opacity is a linear fade from the recipe's `fade` value. Close is the
 * reverse on Exit tuning (667 ms) with the fade delayed 333 ms, so the
 * frame recedes visibly before it vanishes. Uses: primary OS windows from
 * the launcher, heavy media frames.
 */
function buildHorizonReveal(refs: HorizonRevealRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.horizonReveal
  const timeline = Motion.timeline({
    defaults: {
      duration: [recipe.closeDuration, profile.durations.spawn],
      ease: [profile.eases.exit, profile.eases.enter]
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const rest = refs.restPosition
  timeline.add(refs.target, {
    channel: ch.position,
    from: new vec3(rest.x, rest.y + refs.height / 2, rest.z),
    to: new vec3(rest.x, rest.y, rest.z)
  })
  const authored = refs.authoredScale
  timeline.add(
    refs.target,
    {
      channel: ch.scale,
      from: new vec3(authored.x * recipe.scaleFrom, authored.y * recipe.scaleFrom, authored.z * recipe.scaleFrom),
      to: new vec3(authored.x, authored.y, authored.z)
    },
    {at: "withPrevious"}
  )
  timeline.add(refs.target, {channel: ch.rotationX, from: recipe.hingeDegrees, to: 0}, {at: "withPrevious"})
  timeline.add(
    refs.fade,
    {channel: ch.alpha, from: 0, to: 1, duration: [recipe.closeFade, recipe.fade], ease: profile.eases.linear},
    {time: [recipe.closeFadeDelay, 0]}
  )
  return timeline
}

export interface NavCrossfadeRefs {
  /** The surface being left — fades out. */
  outgoing: Channels.OpacityWriter
  /** The surface being entered — fades in. */
  incoming: Channels.OpacityWriter
  scope?: ScopeHooks
  /** forward=true → incoming shown; false → back on the outgoing surface. */
  onComplete?: DirectionalCallback
}

/**
 * "nav.fade" — top-level navigation crossfade (spec slide 21): outgoing
 * 100→0%, incoming 0→100%, linear, 333 ms, together. Reverse navigates back.
 * The spec pairs this with depth shifts (slide 12); depth is the caller's
 * choreography — this intent owns only the crossfade.
 */
function buildNavCrossfade(refs: NavCrossfadeRefs, profile: MotionProfile): Timeline {
  const timeline = Motion.timeline({
    defaults: {duration: profile.durations.base, ease: profile.eases.linear},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  timeline.add(refs.outgoing, {channel: ch.alpha, from: 1, to: 0})
  timeline.add(refs.incoming, {channel: ch.alpha, from: 0, to: 1}, {at: "withPrevious"})
  return timeline
}

export interface LateralPageTarget {
  target: unknown
  /** Rest local position — the on-screen pose. */
  restPosition: vec3
  fade: Channels.OpacityWriter
}

export interface LateralPageRefs {
  /**
   * Signed X travel of the navigation in the targets' local units. The spec's
   * tables say ±500 for headers and "outside of frame" for content — the unit
   * space is an open spec question (brief 09 §6 #3), so travel is a ref, not
   * a recipe token: the caller knows its frame width.
   */
  travel: number
  /** Header travel; defaults to `travel`. */
  headerTravel?: number
  /** Content leaving the frame (slides −travel, fades out). */
  outgoing: LateralPageTarget[]
  /** Content arriving (slides in from +travel, fades in). */
  incoming: LateralPageTarget[]
  outgoingHeader?: LateralPageTarget
  incomingHeader?: LateralPageTarget
  scope?: ScopeHooks
  /** forward=true → landed on the new page; false → back on the old one. */
  onComplete?: DirectionalCallback
}

/**
 * "lateral.page" — 2D lateral motion (spec slide 18): tabs / page navigation.
 * Incoming content slides in from +travel while outgoing slides out to
 * −travel, headers riding their own travel; fades are 333 ms linear inside
 * the 667 ms move. Position rows use the spec's "Start: Ease-Out / End:
 * Ease-In", read as the Precise curve (slide 3 names it "standard
 * ease-out-in") — PROVISIONAL interpretation. The table gives no separate
 * exit tuning; back-navigation is the same timeline reversed.
 */
function buildLateralPage(refs: LateralPageRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.lateralPage
  const timeline = Motion.timeline({
    defaults: {duration: profile.durations.enter, ease: profile.eases.precise},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const travel = refs.travel
  const headerTravel = refs.headerTravel ?? travel
  const addSlide = (entry: LateralPageTarget, distance: number, arriving: boolean): void => {
    const rest = entry.restPosition
    timeline.add(
      entry.target,
      arriving
        ? {
            channel: ch.position,
            from: new vec3(rest.x + distance, rest.y, rest.z),
            to: new vec3(rest.x, rest.y, rest.z)
          }
        : {
            channel: ch.position,
            from: new vec3(rest.x, rest.y, rest.z),
            to: new vec3(rest.x - distance, rest.y, rest.z)
          },
      {time: 0}
    )
    timeline.add(
      entry.fade,
      {
        channel: ch.alpha,
        from: arriving ? 0 : 1,
        to: arriving ? 1 : 0,
        duration: recipe.fade,
        ease: profile.eases.linear
      },
      {time: 0}
    )
  }
  for (const entry of refs.outgoing) addSlide(entry, travel, false)
  for (const entry of refs.incoming) addSlide(entry, travel, true)
  if (refs.outgoingHeader !== undefined) addSlide(refs.outgoingHeader, headerTravel, false)
  if (refs.incomingHeader !== undefined) addSlide(refs.incomingHeader, headerTravel, true)
  return timeline
}

export interface CardMorphRefs {
  /**
   * The morph's transform channels — explicit from/to for BOTH instances
   * (spec: card and panel ride the same Start→End scale/position window), so
   * the timeline is deterministic and reusable.
   */
  transforms: ExpandGrowthRef[]
  /** The Start component (card): visible at rest, fades out on enter. */
  cardFade: Channels.OpacityWriter
  /** The End component (panel): hidden at rest, fades in late on enter. */
  panelFade: Channels.OpacityWriter
  /** The grid stage behind the morph: pushed back in Z and hidden. */
  grid?: {target: unknown; fade: Channels.OpacityWriter; restZ: number}
  scope?: ScopeHooks
  /** forward=true → panel shown; false → back to the card in the grid. */
  onComplete?: DirectionalCallback
}

/**
 * "card.morph" — card/thumbnail → panel (spec slide 17): the shared-element
 * morph as a crossfading pair of scaled components plus a Z-pushed grid
 * stage — NOT a reparenting FLIP. Enter: transforms ride 667 ms Enter
 * bezier, card fades out 333 ms immediately, panel fades in 333 ms after a
 * 333 ms delay (reveal in the second half), grid pushes back z+150 and
 * hides. Close: 500 ms Exit tuning, panel out 250 ms immediately, card back
 * 250 ms delayed 250 ms, grid returns.
 */
function buildCardMorph(refs: CardMorphRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.cardMorph
  const timeline = Motion.timeline({
    defaults: {
      duration: [profile.durations.exit, profile.durations.enter],
      ease: [profile.eases.exit, profile.eases.enter]
    },
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  for (let i = 0; i < refs.transforms.length; i++) {
    const entry = refs.transforms[i]
    timeline.add(entry.target, {channel: entry.channel, from: entry.from, to: entry.to}, {time: 0})
  }
  timeline.add(
    refs.cardFade,
    {
      channel: ch.alpha,
      from: 1,
      to: 0,
      duration: [recipe.closeCrossfade, recipe.crossfade],
      ease: profile.eases.linear
    },
    {time: [recipe.closeRestoreDelay, 0]}
  )
  // Panel opacity uses the spec's "Start: Ease-Out / End: Ease-In" on enter,
  // read as the Precise curve (PROVISIONAL, same as lateral.page); linear on
  // close per the table.
  timeline.add(
    refs.panelFade,
    {
      channel: ch.alpha,
      from: 0,
      to: 1,
      duration: [recipe.closeCrossfade, recipe.crossfade],
      ease: [profile.eases.linear, profile.eases.precise]
    },
    {time: [0, recipe.revealDelay]}
  )
  if (refs.grid !== undefined) {
    const grid = refs.grid
    timeline.add(grid.target, {channel: ch.positionZ, from: grid.restZ, to: grid.restZ + recipe.gridZPush}, {time: 0})
    timeline.add(grid.fade, {channel: ch.alpha, from: 1, to: 0, ease: profile.eases.linear}, {time: 0})
  }
  return timeline
}

export interface BreadcrumbEnterRefs {
  target: unknown
  /** Rest local position — where the breadcrumb sits when shown. */
  restPosition: vec3
  fade: Channels.OpacityWriter
  scope?: ScopeHooks
  /** forward=true → shown; false → closed. */
  onComplete?: DirectionalCallback
}

/**
 * "breadcrumb.enter" — spec slide 19, Enter & Close: the breadcrumb slides
 * in from x−60 while fading, 333 ms, both on the spec's "Start: Ease-Out /
 * End: Ease-In" (read as the Precise curve — PROVISIONAL, as elsewhere).
 * Close is the reverse.
 */
function buildBreadcrumbEnter(refs: BreadcrumbEnterRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.breadcrumb
  const timeline = Motion.timeline({
    defaults: {duration: profile.durations.base, ease: profile.eases.precise},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const rest = refs.restPosition
  timeline.add(refs.target, {
    channel: ch.position,
    from: new vec3(rest.x - recipe.enterSlide, rest.y, rest.z),
    to: new vec3(rest.x, rest.y, rest.z)
  })
  timeline.add(refs.fade, {channel: ch.alpha, from: 0, to: 1}, {at: "withPrevious"})
  return timeline
}

export interface BreadcrumbStepRefs {
  /** BG scale between the two crumb widths — explicit from/to (Start↔End). */
  bg?: ExpandGrowthRef
  /** The crumb arriving: slides in from x−stepSlide, fades in late. */
  incoming: {target: unknown; restPosition: vec3; fade: Channels.OpacityWriter}
  /** The crumb leaving: slides out to x+stepSlide, fades out. */
  outgoing: {target: unknown; restPosition: vec3; fade: Channels.OpacityWriter}
  scope?: ScopeHooks
  /** forward=true → stepped deeper (expand); false → back a level (shrink). */
  onComplete?: DirectionalCallback
}

/**
 * "breadcrumb.step" — spec slide 19, Expand & Shrink: the BG scales to the
 * new crumb width while the incoming crumb slides in from x−30 (fade 200 ms
 * delayed 167 ms) and the outgoing slides out to x+30 (200 ms linear slide,
 * 333 ms fade). Shrink is the reverse. The ± slide directions are a
 * PROVISIONAL read of the table's Start↔End shorthand.
 */
function buildBreadcrumbStep(refs: BreadcrumbStepRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.breadcrumb
  const timeline = Motion.timeline({
    defaults: {duration: profile.durations.base, ease: profile.eases.precise},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  if (refs.bg !== undefined) {
    timeline.add(refs.bg.target, {channel: refs.bg.channel, from: refs.bg.from, to: refs.bg.to}, {time: 0})
  }
  const inRest = refs.incoming.restPosition
  timeline.add(
    refs.incoming.target,
    {
      channel: ch.position,
      from: new vec3(inRest.x - recipe.stepSlide, inRest.y, inRest.z),
      to: new vec3(inRest.x, inRest.y, inRest.z)
    },
    {time: 0}
  )
  timeline.add(
    refs.incoming.fade,
    {channel: ch.alpha, from: 0, to: 1, duration: recipe.stepFade, ease: profile.eases.linear},
    {time: recipe.stepFadeDelay}
  )
  const outRest = refs.outgoing.restPosition
  timeline.add(
    refs.outgoing.target,
    {
      channel: ch.position,
      from: new vec3(outRest.x, outRest.y, outRest.z),
      to: new vec3(outRest.x + recipe.stepSlide, outRest.y, outRest.z),
      duration: recipe.stepFade,
      ease: profile.eases.linear
    },
    {time: 0}
  )
  timeline.add(refs.outgoing.fade, {channel: ch.alpha, from: 1, to: 0}, {time: 0})
  return timeline
}

export interface CarouselItemRefs {
  target: unknown
  /**
   * The item's slot in the CURRENT arrangement — the reference origin the
   * spec's offsets are measured from (the outgoing arc's mid stop, the
   * incoming item's entry point).
   *
   * Not the value the move starts at. The outgoing item picks its start up
   * from wherever it actually is, so a trigger fired straight out of hover
   * flows on from the hover offset instead of snapping back here first.
   */
  rest: vec3
  /** Destination slot local position. */
  toSlot: vec3
  fade: Channels.OpacityWriter
}

export interface CarouselAdvanceRefs {
  /** The featured item rotating out to the (N−1)st slot. */
  outgoing: CarouselItemRefs
  /** The next item arriving at the featured slot. */
  incoming: CarouselItemRefs
  scope?: ScopeHooks
  onComplete?: DirectionalCallback
}

/**
 * "carousel.advance" — 3D lateral motion (spec slide 20): the keyframe
 * showcase. The outgoing item travels through a mid keyframe (x−185, z−70)
 * to the previous slot over two chained 333 ms segments — the split-bezier
 * pair is one continuous ease cut at its midpoint — leaning to the wings
 * angle over the full 667 ms and dimming to 50%. The incoming item arrives
 * from its offset (x+50, z+50) over the same two segments, unwinding its own
 * 45° to flat and brightening to 100%. The two rotations are mirror images:
 * whoever is featured is flat, whoever is off to the side is tilted.
 *
 * The two-segment position and rotation moves are KEYFRAME data on a single
 * tween each, so reverse() retraces the arc rather than scrambling it, and
 * killing the item's position stops the whole move.
 *
 * HOVER HANDOFF: a trigger normally fires while the item is still hovered, so
 * the outgoing arc and the incoming untilt both start from the LIVE value
 * instead of an authored one. Nothing jumps whether or not hover ran first,
 * and reverse() retraces to wherever the move began. The `rest` refs stay the
 * reference origin for the spec's offsets — they are not the start value.
 */
function buildCarouselAdvance(refs: CarouselAdvanceRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.carousel
  const [easeA, easeB] = recipe.segmentEases
  const timeline = Motion.timeline({
    defaults: {duration: recipe.segment, ease: easeA},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const out = refs.outgoing
  const outMid = new vec3(out.rest.x + recipe.exitMidX, out.rest.y, out.rest.z + recipe.exitMidZ)
  // Two-stop moves as KEYFRAME DATA on one tween each, so the whole move owns
  // its property (killable and queryable as a unit) and reverse retraces the
  // stops. The split-bezier pair is one continuous arc cut at its midpoint:
  // easeA to the mid keyframe, easeB to the slot.
  // No `from`: the arc starts from the item's LIVE position. Hover has
  // usually shifted it by `hoverShift` already, and the spec measures both
  // the hover offset and this arc from the same origin — so the trigger
  // continues from the hovered pose rather than snapping back to `rest`.
  // `outMid` stays anchored to `rest`, so the arc keeps its authored shape.
  timeline.add(
    out.target,
    {channel: ch.position, keyframes: [{value: outMid}, {value: out.toSlot, ease: easeB}]},
    {time: 0}
  )
  // Mirror of the incoming untilt, and live-started for the same reason: the
  // outgoing item leans to the wings angle over the whole move. One smooth
  // 45° lean, not a revolution — see `exitTilt`.
  timeline.add(
    out.target,
    {channel: ch.rotationY, to: recipe.exitTilt, duration: recipe.segment * 2, ease: profile.eases.precise},
    {time: 0}
  )
  timeline.add(
    out.fade,
    {channel: ch.alpha, from: 1, to: recipe.dimmed, duration: recipe.fade, ease: profile.eases.linear},
    {time: recipe.fadeDelay}
  )
  const incoming = refs.incoming
  const inStart = new vec3(incoming.rest.x + recipe.enterStartX, incoming.rest.y, incoming.rest.z + recipe.enterStartZ)
  const inMid = new vec3(
    inStart.x + (incoming.toSlot.x - inStart.x) * 0.5,
    inStart.y + (incoming.toSlot.y - inStart.y) * 0.5,
    inStart.z + (incoming.toSlot.z - inStart.z) * 0.5
  )
  timeline.add(
    incoming.target,
    {channel: ch.position, from: inStart, keyframes: [{value: inMid}, {value: incoming.toSlot, ease: easeB}]},
    {time: 0}
  )
  // Also live-start: the spec's "Start.p+45 → 0" assumes hover's pre-tilt is
  // still on, so reading it back gives the spec's 667ms 45→0 exactly. Trigger
  // from an un-hovered item instead and this is a no-op rather than a snap up
  // to 45 and back — either way nothing jumps.
  timeline.add(
    incoming.target,
    {channel: ch.rotationY, to: 0, duration: recipe.segment * 2, ease: profile.eases.precise},
    {time: 0}
  )
  timeline.add(
    incoming.fade,
    {channel: ch.alpha, from: recipe.dimmed, to: 1, duration: recipe.fade, ease: profile.eases.linear},
    {time: recipe.fadeDelay}
  )
  return timeline
}

export interface CarouselHoverRefs {
  /** The featured item shifting toward the viewer. */
  featured: {target: unknown; rest: vec3}
  /** The next item pre-tilting (rest rotation + entryTilt). */
  next?: {target: unknown}
  scope?: ScopeHooks
  onComplete?: DirectionalCallback
}

/**
 * "carousel.hover" — slide 20's hover state: the featured item shifts
 * x−80 and the next item pre-tilts +45°, both 333 ms on the Precise curve.
 * Hover-out is the reverse.
 */
function buildCarouselHover(refs: CarouselHoverRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.carousel
  const timeline = Motion.timeline({
    defaults: {duration: recipe.segment, ease: profile.eases.precise},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  const rest = refs.featured.rest
  timeline.add(refs.featured.target, {
    channel: ch.position,
    from: new vec3(rest.x, rest.y, rest.z),
    to: new vec3(rest.x + recipe.hoverShift, rest.y, rest.z)
  })
  if (refs.next !== undefined) {
    timeline.add(refs.next.target, {channel: ch.rotationY, from: 0, to: recipe.entryTilt}, {at: "withPrevious"})
  }
  return timeline
}

export interface LoaderSweepRefs {
  /** Owner of the driven positions — typically the bar material (claim identity). */
  target: unknown
  /** Receives the HEAD position, 0..1 along the bar (typically
   * `Channels.shaderFloat` on the material's headPos uniform). */
  head: Channels.ChannelSelector<number>
  /** Receives the LAG — how far the trail hangs back behind the head, as a
   * fraction of the bar (the material's lagSpan uniform; the shader derives
   * the trail's start from head − lag, anchored at the bar's start edge). */
  lag: Channels.ChannelSelector<number>
  /** Whole-bar opacity writer — the per-sweep entry rise and exit fade, and
   * the dark hold between sweeps, ride this. */
  alpha: Channels.OpacityWriter
  scope?: ScopeHooks
}

/**
 * "loader.sweep" — the Loading Bar's indeterminate sweep (spec "Loading
 * Phase Animation" page; no engineering table, so the recipe carries
 * frame-tracked measurements off the reference video).
 *
 * Two driven quantities: the head's position, and the LAG the trail hangs
 * back behind it. The head crosses once and parks. The lag opens almost
 * immediately — pinning the trail at the bar's start, so the streak grows as
 * the head runs — then closes so the trail has caught up by the time the head
 * reaches `lagCloseAtHead` along the bar (mid-bar on the shipped recipe). A
 * compact streak then finishes the crossing and fades as it lands.
 *
 * Driving the lag instead of a second position is what makes that possible:
 * two independent 0→1 ends share a destination, so their gap can only close
 * AT the far edge — a trail that caught the head sooner would have to
 * overtake it.
 *
 * One cycle is: entry rise → sweep (stretch, then squash) → exit fade →
 * dark rest to fill out the period.
 *
 * The loop is THREE standalone `repeat: -1` tweens, one per driven property,
 * each a keyframed cycle exactly one period long — not a timeline that
 * re-arms itself. A timeline cannot loop: `Timeline.tick` calls `complete()`
 * and returns false, so the ticker drops it immediately after `onComplete`
 * runs, and re-playing from inside that callback is a no-op (the node is
 * still in the ticker's list, so `add` dedupes, then the walk splices it
 * out). Repeating tweens are the engine's own idle-loop path: they reset and
 * report alive, so they stay scheduled. Equal totals keep the three in
 * phase — they advance on one shared dt.
 *
 * Stop by killing the returned drivers — a stopped loader must cost nothing.
 */
function buildLoaderSweep(refs: LoaderSweepRefs, profile: MotionProfile): Tween<number>[] {
  const recipe = profile.recipes.loadingBar
  // Legs are floored to a hair above zero: a retune that leaves no room for
  // one (period == headTravel, say) would otherwise hand the leg solver a
  // zero-length segment to divide by, and a 1 ms leg is instant anyway.
  const leg = (seconds: number): number => Math.max(seconds, MIN_KEYFRAME_LEG_SECONDS)
  const linear = profile.eases.linear
  // Each cycle: travel, then hold at the far edge through the fade and rest,
  // so the snap back to the left edge happens while the bar is dark.
  const head = Motion.keyframes(refs.target, {
    channel: refs.head,
    from: 0,
    keyframes: [
      {value: 1, duration: leg(recipe.headTravel), ease: recipe.headEase},
      {value: 1, duration: leg(recipe.period - recipe.headTravel), ease: linear}
    ],
    repeat: -1,
    scope: refs.scope
  })
  // The lag: open fast, then close so that the trail has caught up by the
  // time the head reaches `lagCloseAtHead` along the bar. That time is SOLVED
  // from the head's own curve rather than stored as a duration, so the
  // positional promise survives a retune of headEase.
  const closeTime = recipe.headTravel * easeInverse(recipe.headEase, recipe.lagCloseAtHead)
  // The hold is the remainder: it keeps the lag ABOVE the head's progress, so
  // the trail stays pinned at the bar's start and the streak keeps growing.
  // Holding is what buys the stretch — drop it and the falling lag crosses the
  // rising head almost immediately, capping the span at a quarter of the bar.
  const lagHold = closeTime - recipe.lagRise - recipe.lagFall
  // It settles at a residual rather than zero — a zero-length span renders
  // nothing — and holds there for the rest of the period, so a compact streak
  // finishes the crossing and the snap back happens while the bar is dark.
  const lagSettled = recipe.period - closeTime
  const lag = Motion.keyframes(refs.target, {
    channel: refs.lag,
    from: 0,
    keyframes: [
      {value: recipe.lagPeak, duration: leg(recipe.lagRise), ease: recipe.lagRiseEase},
      {value: recipe.lagPeak, duration: leg(lagHold), ease: linear},
      {value: recipe.lagResidual, duration: leg(recipe.lagFall), ease: recipe.lagFallEase},
      {value: recipe.lagResidual, duration: leg(lagSettled), ease: linear}
    ],
    repeat: -1,
    scope: refs.scope
  })
  // Rise in → hold lit while the streak crosses → fade out as it lands →
  // stay dark for the rest of the period. The visible life ends when the head
  // parks, so the fades key off headTravel.
  const litHold = recipe.headTravel - recipe.entryFade - recipe.exitFade
  const alpha = Motion.keyframes(refs.alpha, {
    channel: ch.alpha,
    from: 0,
    keyframes: [
      {value: 1, duration: leg(recipe.entryFade)},
      {value: 1, duration: leg(litHold)},
      {value: 0, duration: leg(recipe.exitFade)},
      {value: 0, duration: leg(recipe.period - recipe.headTravel)}
    ],
    ease: linear,
    repeat: -1,
    scope: refs.scope
  })
  return [head, lag, alpha]
}

export interface LoaderFillRefs {
  /** Owner of the driven fill (claim identity) — typically the bar material. */
  target: unknown
  /** Receives the displayed fill level each tick. Determinate mode is the
   * same span the sweep lights, pinned at the left edge, so this drives the
   * material's headPos uniform (with tailPos held at 0). */
  channel: Channels.ChannelSelector<number>
  /** Fill level to ease toward (0..1). */
  to: number
  scope?: ScopeHooks
  /** Fires when the displayed level reaches `to` (forward=true always). */
  onComplete?: DirectionalCallback
}

/**
 * "loader.fill" — the Loading Bar's determinate mode: the displayed fill
 * eases toward the set level over the recipe's fillSmoothing (PROVISIONAL —
 * the spec video shows no determinate state; API-complete per the design
 * decision). Repeated sets retarget via the channel's claim key — the new
 * tween kills the old one.
 */
function buildLoaderFill(refs: LoaderFillRefs, profile: MotionProfile): Tween<number> {
  return Motion.to(refs.target, {
    channel: refs.channel,
    value: refs.to,
    duration: profile.recipes.loadingBar.fillSmoothing,
    ease: profile.eases.precise,
    scope: refs.scope,
    onFinish: refs.onComplete
  })
}

export interface SkeletonPulseRefs {
  /** Owner of the shared group clock (claim identity) — the group, not a block. */
  target: unknown
  /** Receives the loop phase 0..1 each tick. ONE clock per group: the write
   * typically fans out to every block's material (group pulses = one wave in
   * group space, blocks catch it by position). */
  channel: Channels.ChannelSelector<number>
  /** Loop period in seconds; defaults to durations.sweep (spec: 2000 ms). */
  period?: number
  scope?: ScopeHooks
}

/**
 * "skeleton.pulse" — the Skeleton Loaders' grouped-pulse clock (spec
 * "Skeleton Loaders" page: "fade in and out in grouped pulses, supported by
 * a soft shimmer that passes"). One linear 0→1 phase loops every
 * durations.sweep; block materials map phase → the shared sheen band and the
 * alpha breathing, parameterized by each block's group-space placement.
 */
function buildSkeletonPulse(refs: SkeletonPulseRefs, profile: MotionProfile): Tween<number> {
  return Motion.fromTo(refs.target, {
    channel: refs.channel,
    from: 0,
    value: 1,
    duration: refs.period ?? profile.durations.sweep,
    ease: profile.eases.linear,
    repeat: -1,
    scope: refs.scope
  })
}

export interface SkeletonHandoffRefs {
  /** The placeholder blocks — faded out together, wave frozen where it was
   * (kill the pulse clock BEFORE launching this). */
  blocks: Channels.OpacityWriter[]
  /** The arriving content: each writer fades 0→`to` (its ORIGINAL opacity,
   * not 1 — dimmed subtitles must come back dimmed), staggered by the same
   * three ordinals: `group` (each tile — a top-level chrome piece and its
   * subtree — arrives as a unit, one after another), then `level` (the
   * tile's own cascade), then `sibling` order within the level. Each piece
   * also bounces in on the same beat: `node`'s local scale runs
   * baseScale·handoffScaleFrom → `baseScale` (its scale at complete-time)
   * on an overshooting ease alongside the fade. */
  reveals: {
    fade: Channels.OpacityWriter
    node: Transform
    baseScale: vec3
    group: number
    level: number
    sibling: number
    to: number
  }[]
  scope?: ScopeHooks
  /** forward=true → content fully shown, blocks fully hidden. */
  onComplete?: DirectionalCallback
}

/**
 * "skeleton.handoff" — the Skeleton loader's exit: the content has arrived,
 * the placeholders bow out. Blocks fade out together (handoffFadeOut), then
 * the real content fades AND bounces in level by level (handoffFadeIn +
 * handoffScaleIn per piece, handoffStagger between cascade levels,
 * handoffSiblingStagger between siblings inside a level). Under a snap
 * policy the timeline completes instantly — blocks gone, content shown at
 * its original opacity and scale.
 */
function buildSkeletonHandoff(refs: SkeletonHandoffRefs, profile: MotionProfile): Timeline {
  const recipe = profile.recipes.skeletonPulse
  const timeline = Motion.timeline({
    defaults: {ease: profile.eases.linear},
    scope: refs.scope,
    onComplete: refs.onComplete
  })
  for (const block of refs.blocks) {
    timeline.add(block, {channel: ch.alpha, from: 1, to: 0, duration: recipe.handoffFadeOut}, {time: 0})
  }
  for (const reveal of refs.reveals) {
    const time =
      recipe.handoffFadeOut +
      reveal.group * recipe.handoffGroupStagger +
      reveal.level * recipe.handoffStagger +
      reveal.sibling * recipe.handoffSiblingStagger
    timeline.add(reveal.fade, {channel: ch.alpha, from: 0, to: reveal.to, duration: recipe.handoffFadeIn}, {time})
    // The bounce rides the same beat as the fade — but the piece must sit
    // at its DEFAULT scale until then. A timeline holds a child's
    // from-value before its window opens, so `from` is the base scale and
    // the shrink is the first keyframe leg INSIDE the window: snap down
    // right as the fade begins (alpha is still 0 — never visible), then
    // overshoot back up. Both ends of the child are the piece's
    // complete-time scale, so pre-beat frames, a snap policy, and an early
    // complete() all land on the original transform.
    timeline.add(
      reveal.node,
      {
        channel: ch.scale,
        from: reveal.baseScale,
        keyframes: [
          {value: reveal.baseScale.uniformScale(recipe.handoffScaleFrom), duration: 0.001},
          {value: reveal.baseScale, duration: recipe.handoffScaleIn, ease: recipe.handoffScaleEase}
        ]
      },
      {time}
    )
  }
  return timeline
}

export interface IntentOptions {
  /** Default "forward" (toward the entered/expanded/shown state). */
  direction?: "forward" | "reverse"
  /** Resolve against a specific profile instead of the active one. */
  profile?: MotionProfile
}

/**
 * Policy consult → build → play. The comfort / reduced-motion policy sees
 * (intent, direction, profile) BEFORE the build, so it can substitute an
 * adjusted profile or snap: snap builds normally, then jumps to the
 * direction's end state — completion callbacks still fire.
 */
function launch(
  name: string,
  options: IntentOptions | undefined,
  build: (profile: MotionProfile) => Timeline
): Timeline {
  const forward = options?.direction !== "reverse"
  const requested = options?.profile ?? getActiveMotionProfile()
  // A profile can arrive here without ever passing through makeMotionProfile
  // or registerMotionProfile (a hand-authored literal in options.profile), so
  // this is the last gate before recipe values reach transform and opacity
  // writes. Validated once per profile object, not per call.
  ensureProfileValidated(requested)
  const decision = applyMotionPolicy({intent: name, direction: forward ? "forward" : "reverse", profile: requested})
  // The policy's profile is the one built against — and the one most likely
  // computed at runtime, so it is the one that most needs checking.
  const resolved = decision.profile ?? requested
  ensureProfileValidated(resolved)
  const timeline = build(resolved).play(forward)
  // A forward-only timeline refuses reverse; completing anyway would write its
  // FORWARD end state and report success for a direction it never played.
  if (decision.action === "snap" && timeline.isForward === forward) {
    timeline.complete()
  }
  return timeline
}

/**
 * Policy consult → build → run, for the TWEEN-shaped intents (loaders).
 * These return a standalone tween instead of a timeline — the looping ones
 * (repeat:-1) are held and `kill()`ed to stop (a stopped loader costs
 * nothing). A "snap" policy decision jumps the tween to its end value and
 * kills the driver: the loader renders as a static placeholder with zero
 * per-frame work.
 */
/**
 * Static pose a snapped loader rests on: the streak mid-slide at its full
 * recipe length (lagPeak 0.6, trail lifted off the start edge), so a
 * reduced-motion user still sees a loading affordance rather than an empty
 * bar. Keep in step with the recipe's lagPeak and the material's authored
 * resting values (LoadingBar.mat / LoadingBarVisual defaults).
 */
const LOADER_SNAP_HEAD = 0.7
const LOADER_SNAP_LAG = 0.6

/**
 * Policy consult → build → run, for the looping sweep drivers. On snap the
 * drivers are killed and a static pose is written through the same channels,
 * so a reduced-motion loader shows a still streak at zero per-frame cost.
 */
function launchSweep(name: string, refs: LoaderSweepRefs, options: IntentOptions | undefined): Tween<number>[] {
  const requested = options?.profile ?? getActiveMotionProfile()
  ensureProfileValidated(requested)
  const decision = applyMotionPolicy({intent: name, direction: "forward", profile: requested})
  const resolved = decision.profile ?? requested
  ensureProfileValidated(resolved)
  if (decision.action === "snap") {
    Motion.set(refs.target, {channel: refs.head, value: LOADER_SNAP_HEAD})
    Motion.set(refs.target, {channel: refs.lag, value: LOADER_SNAP_LAG})
    Motion.set(refs.alpha, {channel: ch.alpha, value: 1})
    return []
  }
  return buildLoaderSweep(refs, resolved)
}

function launchTween(
  name: string,
  options: IntentOptions | undefined,
  build: (profile: MotionProfile) => Tween<number>
): Tween<number> {
  const requested = options?.profile ?? getActiveMotionProfile()
  // Same last gate as launch(): a hand-authored profile in options.profile
  // reaches shader uniforms here, and a NaN period would loop forever on a
  // broken clock. Validated once per profile object, not per call.
  ensureProfileValidated(requested)
  const decision = applyMotionPolicy({intent: name, direction: "forward", profile: requested})
  const resolved = decision.profile ?? requested
  ensureProfileValidated(resolved)
  const tween = build(resolved)
  if (decision.action === "snap") {
    tween.snapTo(true)
    tween.kill()
  }
  return tween
}

/**
 * The typed intent catalog. Each call consults the motion policy, builds the
 * timeline from the resolved profile's tokens and recipes, plays it, and
 * returns it — hold the timeline and `play(forward)` it thereafter
 * (retained-timeline pattern; rebuild only when geometry changes). The
 * timeline keeps the profile values it was built with.
 */
export const Intents = {
  /** Spec slide 15 — expanding surface with staggered item reveal (Dropdown). */
  expand(refs: ExpandRefs, options?: IntentOptions): Timeline {
    return launch("expand", options, (profile) => buildExpand(refs, profile))
  },
  /** Whole-panel show/hide fade (spec slide 21 grounding). */
  panelFade(refs: PanelFadeRefs, options?: IntentOptions): Timeline {
    return launch("panel.fade", options, (profile) => buildPanelFade(refs, profile))
  },
  /** Side surface sliding out from behind its parent (Frame right drawer). */
  drawerSlide(refs: DrawerSlideRefs, options?: IntentOptions): Timeline {
    return launch("drawer.slide", options, (profile) => buildDrawerSlide(refs, profile))
  },
  /** Hover/proximity intensity chasing 0↔1 (border fade, cursor highlight). */
  highlight(refs: HighlightRefs, options?: IntentOptions): Timeline {
    return launch("highlight", options, (profile) => buildHighlight(refs, profile))
  },
  /** Modal surface popping into the FOV: scale pop + fade (DialogPopup). */
  dialogEnter(refs: DialogEnterRefs, options?: IntentOptions): Timeline {
    return launch("dialog.enter", options, (profile) => buildDialogEnter(refs, profile))
  },
  /** Spec slide 16 — notification/AI-agent expansion. Inert spec data: no UIKit consumer. */
  /** Spec slide 26 — primary frames materializing from the horizon (Frame spawn/despawn). */
  horizonReveal(refs: HorizonRevealRefs, options?: IntentOptions): Timeline {
    return launch("horizon.reveal", options, (profile) => buildHorizonReveal(refs, profile))
  },
  /** Spec slide 21 — top-level navigation crossfade; reverse navigates back. */
  navCrossfade(refs: NavCrossfadeRefs, options?: IntentOptions): Timeline {
    return launch("nav.fade", options, (profile) => buildNavCrossfade(refs, profile))
  },
  /** Spec slide 18 — 2D lateral tab/page navigation; reverse is back-navigation. */
  lateralPage(refs: LateralPageRefs, options?: IntentOptions): Timeline {
    return launch("lateral.page", options, (profile) => buildLateralPage(refs, profile))
  },
  /** Spec slide 17 — card→panel morph-lite (crossfading pair + Z-pushed grid stage). */
  cardMorph(refs: CardMorphRefs, options?: IntentOptions): Timeline {
    return launch("card.morph", options, (profile) => buildCardMorph(refs, profile))
  },
  /** Spec slide 19 — breadcrumb enter/close (slide in from x−60 while fading). */
  breadcrumbEnter(refs: BreadcrumbEnterRefs, options?: IntentOptions): Timeline {
    return launch("breadcrumb.enter", options, (profile) => buildBreadcrumbEnter(refs, profile))
  },
  /** Spec slide 19 — breadcrumb step change (BG rescale + crumb swap); reverse shrinks. */
  breadcrumbStep(refs: BreadcrumbStepRefs, options?: IntentOptions): Timeline {
    return launch("breadcrumb.step", options, (profile) => buildBreadcrumbStep(refs, profile))
  },
  /** Spec slide 20 — carousel advance; two-segment moves as keyframe data, reversible. */
  carouselAdvance(refs: CarouselAdvanceRefs, options?: IntentOptions): Timeline {
    return launch("carousel.advance", options, (profile) => buildCarouselAdvance(refs, profile))
  },
  /** Spec slide 20 — carousel hover (featured shift + next pre-tilt); hover-out reverses. */
  carouselHover(refs: CarouselHoverRefs, options?: IntentOptions): Timeline {
    return launch("carousel.hover", options, (profile) => buildCarouselHover(refs, profile))
  },
  notificationExpand(refs: NotificationExpandRefs, options?: IntentOptions): Timeline {
    return launch("notification.expand", options, (profile) => buildNotificationExpand(refs, profile))
  },
  /** Loading Phase Animation — the indeterminate sweep: a head position plus
   * an animated lag, so the streak stretches, reforms in flight, and arrives
   * compact. Returns the looping drivers; kill them all to stop (empty under
   * a snap policy). */
  loaderSweep(refs: LoaderSweepRefs, options?: IntentOptions): Tween<number>[] {
    return launchSweep("loader.sweep", refs, options)
  },
  /** Loading Phase Animation — determinate bar fill easing toward the set level. */
  loaderFill(refs: LoaderFillRefs, options?: IntentOptions): Tween<number> {
    return launchTween("loader.fill", options, (profile) => buildLoaderFill(refs, profile))
  },
  /** Loading Phase Animation — skeleton grouped-pulse clock (looping; kill to stop). */
  skeletonPulse(refs: SkeletonPulseRefs, options?: IntentOptions): Tween<number> {
    return launchTween("skeleton.pulse", options, (profile) => buildSkeletonPulse(refs, profile))
  },
  /** Loading Phase Animation — the skeleton's exit: blocks fade out, content
   * fades in staggered by cascade level. */
  skeletonHandoff(refs: SkeletonHandoffRefs, options?: IntentOptions): Timeline {
    return launch("skeleton.handoff", options, (profile) => buildSkeletonHandoff(refs, profile))
  }
}
