/**
 * The Motion token library — first-class and Motion-owned.
 *
 * All motion numbers live here (and in registered profiles), nowhere else.
 * A MotionProfile is PURE DATA — durations, eases, staggers. Design systems
 * contribute rather than own: register a profile at startup and switching
 * profiles switches the feel; no profile registered means these library
 * defaults. (Deliberately NOT the theme componentData pattern — Motion works
 * without ThemeService, is typed end to end, and doesn't collide with
 * Themes/ work. Precedent: TextStylePresets.)
 *
 * The founding values are the System 3.0 motion properties (spec slide 3) and
 * the spec's per-intent choreography (recipes). Intent implementations live
 * in the typed catalog (SpecIntents.ts) and receive the profile explicitly;
 * the comfort/reduced-motion policy sits on every intent invocation — one
 * switch, system-wide. Resolution is intent-construction-time: retained
 * timelines keep the values they were built with.
 */

import {back, cubicBezier, defaultEase, easeInverse, linear, power2, sine, spec} from "Motion.lspkg/Eases"
import {Directional, EaseFn} from "Motion.lspkg/MotionTypes"
import {StaggerVars} from "Motion.lspkg/Stagger"

/** The floor the intent builders put under a derived keyframe leg (a
 * zero-length segment would divide by zero). Validation rejects recipes
 * whose derived legs would need it — on a looping multi-driver build the
 * floor changes one driver's total and desyncs the set. */
export const MIN_LOOP_LEG_SECONDS = 0.001

export interface MotionDurations {
  /** Introduction of UI surfaces (spec: 667 ms). */
  enter: number
  /** Removal of surfaces (spec: 500 ms). */
  exit: number
  /** Simple, stable transitions (spec: 333 ms). */
  base: number
  /** Small state triggers — notification pill trigger etc. (spec: 250 ms). */
  quick: number
  /** Primary frame spawn / horizon reveal (spec: 1000 ms). */
  spawn: number
  /** Skeleton highlight sweep (spec: 2000 ms). */
  sweep: number
}

export interface MotionEases {
  enter: EaseFn
  exit: EaseFn
  precise: EaseFn
  linear: EaseFn
  /** Applied when a tween specifies nothing — an out-curve, never linear. */
  fallback: EaseFn
}

export interface MotionStaggers {
  tight: StaggerVars
  base: StaggerVars
}

/**
 * Intent-specific choreography numbers — recipes. A profile retunes EVERY
 * stock motion, not just the shared scales; values here are pure data the
 * intent builders read alongside durations/eases/staggers. Library defaults
 * are the System 3.0 transcription; fields marked PROVISIONAL are open with
 * the spec authors.
 */
export interface ExpandRecipe {
  /** Item fade seconds, [collapse, expand] (spec slide 15: 183/333 ms). */
  itemFade: [number, number]
  /** Delay before items reveal on expand (PROVISIONAL — slide 16's displaced pattern). */
  revealDelay: number
  /** Collapse stage elision: the container starts closing this many seconds
   * before the last item fade-out ends (PROVISIONAL tuning value). */
  collapseStageOverlap: number
}

export interface NotificationExpandRecipe {
  /** Revealed-content fade seconds (spec slide 16: 333 ms). */
  revealFade: number
  /** Delay before revealed content fades in (spec slide 16: 333 ms). */
  revealDelay: number
}

export interface DrawerSlideRecipe {
  /** Slide ease, single or [reverse, forward] (legacy cubic pair; PROVISIONAL). */
  ease: Directional<EaseFn>
}

export interface DialogEnterRecipe {
  /** Enter pop start scale as a fraction of authored (PROVISIONAL). */
  popScale: number
}

export interface HorizonRevealRecipe {
  /** X-axis hinge the frame rises through, degrees (spec slide 26: 83→0). */
  hingeDegrees: number
  /** Start scale as a fraction of authored (spec: 50%). */
  scaleFrom: number
  /** Enter fade seconds (PROVISIONAL: 667 ms — the spec's 333 ms reads as a
   * pop inside the 1 s rise; flagged for the spec authors). */
  fade: number
  /** Close fade seconds (spec: 333 ms linear). */
  closeFade: number
  /** Close-side fade delay seconds (spec: fade waits 333 ms on close). */
  closeFadeDelay: number
  /** Close duration seconds (spec: 667 ms on the Exit bezier; launch uses durations.spawn). */
  closeDuration: number
}

export interface CardMorphRecipe {
  /** Enter crossfade seconds — card out / panel in (spec slide 17: 333 ms). */
  crossfade: number
  /** Panel fade-in delay on enter (spec: 333 ms — reveal in the second half). */
  revealDelay: number
  /** Close crossfade seconds (spec: 250 ms each way). */
  closeCrossfade: number
  /** Card fade-back delay on close (spec: 250 ms). */
  closeRestoreDelay: number
  /** Grid stage Z push in local units (spec: ±150). */
  gridZPush: number
}

export interface LateralPageRecipe {
  /** Content/header fade seconds, linear (spec slide 18: 333 ms). */
  fade: number
}

export interface BreadcrumbRecipe {
  /** Enter/close slide distance in local units (spec slide 19: 60). */
  enterSlide: number
  /** Step-change slide distance for incoming/outgoing crumbs (spec: 30). */
  stepSlide: number
  /** Step-change crumb fade seconds (spec: 200 ms). */
  stepFade: number
  /** Incoming crumb fade delay on a step change (spec: 167 ms). */
  stepFadeDelay: number
}

export interface CarouselRecipe {
  /** One keyframe segment, seconds (spec slide 20: 333 ms; two segments chain). */
  segment: number
  /** The two chained segment eases — one continuous arc cut at its midpoint. */
  segmentEases: [EaseFn, EaseFn]
  /** Outgoing mid-keyframe offset from rest, local units (spec: x−185, z−70). */
  exitMidX: number
  exitMidZ: number
  /** Incoming start offset from rest (spec: x+50, z+50). */
  enterStartX: number
  enterStartZ: number
  /**
   * Where the outgoing item's Y rotation ends up, degrees.
   *
   * The spec writes "0→315 then 315→0", and 315 is −45 — the same 45° the
   * incoming item unwinds. Read as a wrap it would be a full revolution;
   * read as −45 it is the wings angle, and the reference footage is
   * unmistakably the latter: off-centre items sit tilted, the featured one
   * sits flat, and an advance is a quiet shuffle rather than a spin.
   */
  exitTilt: number
  /** Incoming entry tilt, degrees (spec: rest+45 → 0). */
  entryTilt: number
  /** Non-featured items dim to this opacity (spec: 50%). */
  dimmed: number
  /** Opacity fade seconds + delay (spec: 333 ms after 333 ms). */
  fade: number
  fadeDelay: number
  /** Hover shift of the featured item, local units (spec: x−80). */
  hoverShift: number
}

/**
 * The indeterminate sweep is a head position plus an animated LAG — the
 * distance the trail hangs back behind it — not a rigid band and not two
 * independent ends. The head crosses once; the lag opens fast, holds, and
 * closes again, so the streak stretches out of the start, reforms mid-flight,
 * and arrives compact.
 *
 * Lag is its own animated quantity because two independent 0→1 ends cannot
 * express that: a tail that fully caught the head before the head landed
 * would have to overtake it, and with both ends sharing a destination the
 * trailing gap can only close AT the far edge, never before it.
 *
 * The spec's Loading Phase Animation page has no engineering table, so the
 * shape came from tracking the reference video's streak frame by frame
 * (20 fps, head/tail extents per frame): length ran 14% → 57% → 7% of the
 * bar within one 1.1 s cycle, head on a cubic out over ≈0.50 s, tail
 * near-linear over ≈0.75 s.
 *
 * The values below DELIBERATELY DEPART from that measurement (art direction,
 * 2026-08-22): the stretch peaks at ≈90% of the bar instead of 57%, and the
 * trail is fully caught up well before the head reaches the end — the
 * reference's tail was still closing as it landed. Fields record the measured
 * value next to the shipped one where one exists, so nobody later "corrects"
 * this back thinking it is a transcription error.
 *
 * The shape is three phases, set by lagPeak against lagCloseAtHead: the
 * streak GROWS out of the start edge (trail pinned, span = head), then SLIDES
 * at its full length — the phase that carries it across the bar's centre —
 * then the trail CATCHES UP, finishing while the head still has bar left to
 * cross. A compact streak lands and fades.
 *
 * Those three compete for one budget, and the arithmetic is worth knowing
 * before retuning: the slide and the close both have to fit inside the head
 * travelling `lagCloseAtHead - lagPeak` of the bar, so
 *   slide = headTravel × (lagCloseAtHead − lagPeak) − lagFall.
 * A longer streak (bigger lagPeak) shortens that window from one side, and
 * keeping the close smooth lengthens lagFall from the other — so asking for
 * more stretch without a longer headTravel spends the slide. Smoothness sets
 * a floor on lagFall too: with a sine in-out the trail's peak speed is
 * 1.57 × (distance ÷ lagFall), and the distance it must cover is roughly
 * lagPeak. Stretch, slide, smoothness, cycle length: pick three.
 *
 * FRAME BUDGET: these are tuned against the product's 45 fps target, where a
 * frame is 22 ms. Motion has to be spent in frames, not seconds — a leg under
 * ~4 frames (89 ms) reads as a jump rather than a move. An early pass ran the
 * head across in 0.32 s on a quartic out, which spent the first half of its
 * travel in 2.3 frames and looked like a teleport; the head now covers that
 * half in ≈8.4 frames. Check any retune in frames before seconds.
 *
 * PACING: the sweep runs deliberately slower than the reference (art
 * direction, 2026-08-22) — travels are the measured shape scaled up 1.5×.
 * Scaling every travel by the same factor leaves the stretch profile exactly
 * where it was (the span depends on t/travel per end, so it is scale
 * invariant) and only changes how long you watch it. The dark rest is held
 * near 0.5 s rather than scaled with it — a longer gap starts to read as
 * "stalled" instead of "loading".
 */
export interface LoadingBarRecipe {
  /** One full loop — sweep plus the dark rest before the next, seconds.
   * Measured 1.15 / 1.10 / 1.10 on the list row (the pill measures ≈1.05, so
   * both variants share one cadence); shipped much slower, at travel × 1.5
   * plus a ≈0.5 s rest. */
  period: number
  /** Seconds for the HEAD to cross the bar (measured ≈0.50, shipped 1.5×). */
  headTravel: number
  /** Head ease — a cubic out, which is what the reference measures (0.47 /
   * 0.68 / 0.81 of the span at 0.10 / 0.15 / 0.20 s vs a cubic's 0.49 / 0.66 /
   * 0.78). A quartic launches harder but eats the frame budget at 45 fps. NB
   * `power2` is this library's cubic family and `power3` its quartic — the
   * naming is one off from GSAP's. */
  headEase: EaseFn
  /** The streak's full length, as a fraction of the bar — the trail hangs
   * exactly this far behind the head once open. The shader clamps it by the
   * head's own progress, so early on (before the head has travelled this far)
   * the trail is simply pinned at the start edge and the streak grows; after
   * that the trail lifts off and the streak slides at constant full length.
   * That sliding phase is what carries the streak across the bar's centre at
   * its longest. */
  lagPeak: number
  /** Seconds for the lag to open to lagPeak. Short: the streak should start
   * hanging back immediately, not ease into it. */
  lagRise: number
  /** Curve the lag opens on — an out-curve, so most of the stretch appears in
   * the first frames. */
  lagRiseEase: EaseFn
  /**
   * WHERE the trail has finished catching up, as a head position along the
   * bar. Positional rather than a duration because that is what you watch:
   * 0.85 means the streak has reformed while the head still has the last
   * sixth of the bar to cross, so the catch-up reads as finishing BEFORE it
   * lands rather than snapping shut on the edge.
   *
   * Set it against lagPeak. Below lagPeak the trail never lifts off and the
   * streak just grows and closes; above it, the streak plateaus at full
   * length and SLIDES — which is the phase that carries it across the bar's
   * centre. The gap between them is the length of that slide.
   *
   * The closing time is derived from headEase (via `easeInverse`) rather than
   * stored, so this stays true if the head's curve is retuned.
   */
  lagCloseAtHead: number
  /** Seconds the trail takes to catch up, ending at lagCloseAtHead. The hold
   * at full stretch before it is DERIVED as the remainder, so this reads as
   * "how briskly it closes" and the positional promise stays fixed. Under
   * ~3 frames it stops reading as a catch-up and becomes a snap. */
  lagFall: number
  /**
   * Curve the lag closes on, and the single biggest lever on whether the
   * catch-up feels smooth.
   *
   * It must be an IN-OUT: this segment sits between two holds — the slide at
   * full length before it, the compact residual after — so only an in-out
   * leaves and arrives at rest and avoids a velocity jump at either seam. An
   * out-curve departs the plateau at 3× its average speed, which reads as a
   * snap however long the segment is.
   *
   * Among in-outs, prefer the flattest velocity peak: sine peaks at π/2
   * (≈1.57×) of its own average where a cubic in-out spikes to 3×. Measured
   * on the shipped recipe, swapping cubic for sine took the worst
   * single-frame trail movement from 10.6% of the bar to 5.5%.
   */
  lagFallEase: EaseFn
  /** Lag the streak settles at once caught up: a compact streak, not zero,
   * because a zero-length span renders nothing at all. */
  lagResidual: number
  /** Quick rise as a sweep enters, seconds (measured ≈0.08, shipped 1.5×). */
  entryFade: number
  /** Fade as the collapsed streak leaves, seconds (measured ≈0.15, shipped 1.5×). */
  exitFade: number
  /** Determinate fill smoothing time-constant, seconds (PROVISIONAL — no
   * determinate state appears in the spec; matched to Spinner's feel). */
  fillSmoothing: number
}

export interface SkeletonPulseRecipe {
  /**
   * One full loop of the group pulse, seconds. The spec's skeleton sweep
   * token (durations.sweep, 2 s) proved too short once the depth cascade
   * existed: every beat plus the band's own crossing must FIT INSIDE one
   * period — (deepest level × depthDelay) + waveDuration × the pass window —
   * or the deepest beats wrap past the loop seam and flash BEFORE their
   * parents (measured: at a 2 s period with 0.9 s beats, the detail lines
   * flashed 0.1 of a phase ahead of the cards — a scrambled, unreadable
   * cascade rather than a slow one).
   */
  wavePeriod: number
  /** One sheen-band crossing of the WHOLE group, seconds (PROVISIONAL —
   * video ≈ 0.8–1 s). */
  waveDuration: number
  /** Band travel direction, degrees CCW from +X. Negative Y component means
   * the wave descends: −30° reads top-left → bottom-right (art direction
   * 2026-08-23; the reference video ran lower-left → upper-right). */
  waveAngleDegrees: number
  /** Band width as a fraction of the group's swept span (PROVISIONAL). */
  bandWidth: number
  /** Seconds of wave delay per HIERARCHY level below the shallowest visual:
   * a tile's background flashes first, its thumbnail and title one beat
   * later, nested panels' text lines one further — the cascade rippling down
   * the tree. Depth is tree depth under the scan target, normalized so the
   * shallowest skeletonized visual is level 0.
   *
   * Delays WRAP at wavePeriod — see its note for the fit constraint that
   * keeps deep beats from flashing before their parents. At 0.9 s over the
   * 3.5 s period a three-level tree beats at 0 / 0.9 / 1.8 with the whole
   * cascade done before the next wave (art direction 2026-08-23; 0.18, 0.3
   * and 0.6 all read too tight). */
  depthDelay: number
  /** Added brightness right after the band passes — the afterglow the block
   * keeps, decaying quadratically over emberFade until the next wave
   * rearms it. */
  emberBoost: number
  /** Seconds the afterglow takes to settle back to the base tone. Shorter
   * than the period, so the glow is a wake behind the wave rather than a
   * permanent lift (it originally decayed over the whole period — "the fade
   * down is too long", art direction 2026-08-24). */
  emberFade: number
  /** Handoff (content arrived): seconds the placeholder blocks take to fade
   * out, all together, with the wave frozen where it was. */
  handoffFadeOut: number
  /** Handoff: seconds each piece of revealed content takes to fade in. */
  handoffFadeIn: number
  /** Handoff: each piece also BOUNCES in — it starts at this fraction of its
   * original scale and overshoots back to it (handoffScaleEase) alongside
   * its fade, on the same stagger. */
  handoffScaleFrom: number
  /** Handoff: seconds the scale bounce takes — a touch longer than the fade
   * so the overshoot settles after the piece is fully lit. */
  handoffScaleIn: number
  /** Handoff: the bounce curve — an overshooting out-ease (back). */
  handoffScaleEase: EaseFn
  /** Handoff: seconds between top-level GROUPS of the reveal — each tile
   * (a level-0 chrome piece and everything under it) arrives as a unit,
   * one after another in scan order. On a flat target every piece is its
   * own group, so a plain list staggers item by item. */
  handoffGroupStagger: number
  /** Handoff: seconds between cascade LEVELS inside a group — the tile's
   * chrome fades in first, its children a beat later, matching the pulse's
   * own hierarchy language. */
  handoffStagger: number
  /** Handoff: seconds between SIBLINGS within a level — the 1st child of a
   * container fades first, the 2nd next, and so on, so a tile's contents
   * arrive one at a time in reading order rather than as one blink. */
  handoffSiblingStagger: number
  /** Block alpha between waves — the grouped-pulse breathing floor
   * (PROVISIONAL; spec: "fade in and out in grouped pulses"). */
  pulseMinAlpha: number
  /** Block alpha at the pulse peak (PROVISIONAL). */
  pulseMaxAlpha: number
  /** Peak added brightness under the passing band. Sized with emberBoost
   * against the theme's block tone so the full stack (base + band crest +
   * the ember's crest-time half-value) stays at or under the reference's
   * measured ceiling — the brightest block pixel in the spec video is
   * #2B2B2B (43/256, measured 2026-08-24). */
  waveBoost: number
}

export interface MotionRecipes {
  expand: ExpandRecipe
  notificationExpand: NotificationExpandRecipe
  drawerSlide: DrawerSlideRecipe
  dialogEnter: DialogEnterRecipe
  horizonReveal: HorizonRevealRecipe
  cardMorph: CardMorphRecipe
  lateralPage: LateralPageRecipe
  breadcrumb: BreadcrumbRecipe
  carousel: CarouselRecipe
  loadingBar: LoadingBarRecipe
  skeletonPulse: SkeletonPulseRecipe
}

/** Pure data — no resolver implementations, no mutable registration. */
export interface MotionProfile {
  name: string
  durations: MotionDurations
  eases: MotionEases
  staggers: MotionStaggers
  recipes: MotionRecipes
}

/** Recursively freezes a profile — registered profiles are readonly snapshots. */
function freezeProfile(profile: MotionProfile): MotionProfile {
  Object.freeze(profile.durations)
  Object.freeze(profile.eases)
  Object.freeze(profile.staggers.tight)
  Object.freeze(profile.staggers.base)
  Object.freeze(profile.staggers)
  Object.freeze(profile.recipes.expand)
  Object.freeze(profile.recipes.expand.itemFade)
  Object.freeze(profile.recipes.notificationExpand)
  Object.freeze(profile.recipes.drawerSlide)
  Object.freeze(profile.recipes.dialogEnter)
  Object.freeze(profile.recipes.horizonReveal)
  Object.freeze(profile.recipes.cardMorph)
  Object.freeze(profile.recipes.lateralPage)
  Object.freeze(profile.recipes.breadcrumb)
  Object.freeze(profile.recipes.carousel.segmentEases)
  Object.freeze(profile.recipes.carousel)
  Object.freeze(profile.recipes.loadingBar)
  Object.freeze(profile.recipes.skeletonPulse)
  Object.freeze(profile.recipes)
  return Object.freeze(profile)
}

function assertFiniteNonNegative(value: number | undefined, what: string, profileName: string): void {
  if (value !== undefined && !(isFinite(value) && value >= 0)) {
    throw new Error(`Motion: profile "${profileName}" has an invalid ${what}: ${value}`)
  }
}

/**
 * For SIGNED choreography values — offsets, pushes, angles. Their sign is
 * meaningful (a Z push recedes one way in a camera-child scene and the other
 * in world space; carousel offsets travel left or right), so only finiteness
 * is a correctness question here.
 */
function assertFinite(value: number | undefined, what: string, profileName: string): void {
  if (value !== undefined && !isFinite(value)) {
    throw new Error(`Motion: profile "${profileName}" has an invalid ${what}: ${value}`)
  }
}

function assertUnitRange(value: number | undefined, what: string, profileName: string): void {
  if (value !== undefined && !(isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error(`Motion: profile "${profileName}" needs ${what} within 0..1: ${value}`)
  }
}

/** An ease, or a [reverse, forward] / [segmentA, segmentB] pair of eases. */
function assertEases(value: Directional<EaseFn> | undefined, what: string, profileName: string): void {
  if (value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    const pair = value as EaseFn[]
    if (pair.length !== 2 || typeof pair[0] !== "function" || typeof pair[1] !== "function") {
      throw new Error(`Motion: profile "${profileName}" needs ${what} to be two ease functions`)
    }
    return
  }
  if (typeof value !== "function") {
    throw new Error(`Motion: profile "${profileName}" needs ${what} to be an ease function`)
  }
}

function validateProfile(profile: MotionProfile): void {
  const d = profile.durations
  const durationKeys: (keyof MotionDurations)[] = ["enter", "exit", "base", "quick", "spawn", "sweep"]
  for (const key of durationKeys) {
    assertFiniteNonNegative(d[key], `durations.${key}`, profile.name)
  }
  const staggerKeys: (keyof MotionStaggers)[] = ["tight", "base"]
  for (const key of staggerKeys) {
    const s = profile.staggers[key]
    assertFiniteNonNegative(s.each, `staggers.${key}.each`, profile.name)
    assertFiniteNonNegative(s.amount, `staggers.${key}.amount`, profile.name)
    assertFiniteNonNegative(s.base, `staggers.${key}.base`, profile.name)
  }
  const r = profile.recipes
  assertFiniteNonNegative(r.expand.itemFade[0], "recipes.expand.itemFade[0]", profile.name)
  assertFiniteNonNegative(r.expand.itemFade[1], "recipes.expand.itemFade[1]", profile.name)
  assertFiniteNonNegative(r.expand.revealDelay, "recipes.expand.revealDelay", profile.name)
  assertFiniteNonNegative(r.expand.collapseStageOverlap, "recipes.expand.collapseStageOverlap", profile.name)
  assertFiniteNonNegative(r.notificationExpand.revealFade, "recipes.notificationExpand.revealFade", profile.name)
  assertFiniteNonNegative(r.notificationExpand.revealDelay, "recipes.notificationExpand.revealDelay", profile.name)
  assertFiniteNonNegative(r.dialogEnter.popScale, "recipes.dialogEnter.popScale", profile.name)
  assertFiniteNonNegative(r.horizonReveal.scaleFrom, "recipes.horizonReveal.scaleFrom", profile.name)
  assertFiniteNonNegative(r.horizonReveal.fade, "recipes.horizonReveal.fade", profile.name)
  assertFiniteNonNegative(r.horizonReveal.closeFade, "recipes.horizonReveal.closeFade", profile.name)
  assertFiniteNonNegative(r.horizonReveal.closeFadeDelay, "recipes.horizonReveal.closeFadeDelay", profile.name)
  assertFiniteNonNegative(r.horizonReveal.closeDuration, "recipes.horizonReveal.closeDuration", profile.name)
  assertFiniteNonNegative(r.cardMorph.crossfade, "recipes.cardMorph.crossfade", profile.name)
  assertFiniteNonNegative(r.cardMorph.revealDelay, "recipes.cardMorph.revealDelay", profile.name)
  assertFiniteNonNegative(r.cardMorph.closeCrossfade, "recipes.cardMorph.closeCrossfade", profile.name)
  assertFiniteNonNegative(r.cardMorph.closeRestoreDelay, "recipes.cardMorph.closeRestoreDelay", profile.name)
  assertFiniteNonNegative(r.lateralPage.fade, "recipes.lateralPage.fade", profile.name)
  assertFiniteNonNegative(r.breadcrumb.stepFade, "recipes.breadcrumb.stepFade", profile.name)
  assertFiniteNonNegative(r.breadcrumb.stepFadeDelay, "recipes.breadcrumb.stepFadeDelay", profile.name)
  assertFiniteNonNegative(r.carousel.segment, "recipes.carousel.segment", profile.name)
  assertFiniteNonNegative(r.carousel.fade, "recipes.carousel.fade", profile.name)
  assertFiniteNonNegative(r.carousel.fadeDelay, "recipes.carousel.fadeDelay", profile.name)
  assertFiniteNonNegative(r.loadingBar.period, "recipes.loadingBar.period", profile.name)
  assertFiniteNonNegative(r.loadingBar.headTravel, "recipes.loadingBar.headTravel", profile.name)
  assertFiniteNonNegative(r.loadingBar.lagRise, "recipes.loadingBar.lagRise", profile.name)
  assertFiniteNonNegative(r.loadingBar.entryFade, "recipes.loadingBar.entryFade", profile.name)
  assertFiniteNonNegative(r.loadingBar.exitFade, "recipes.loadingBar.exitFade", profile.name)
  assertFiniteNonNegative(r.loadingBar.fillSmoothing, "recipes.loadingBar.fillSmoothing", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.wavePeriod, "recipes.skeletonPulse.wavePeriod", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.waveDuration, "recipes.skeletonPulse.waveDuration", profile.name)
  // Choreography values a design system can retune. Signed offsets and angles
  // get finiteness only — their sign carries meaning. `hingeDegrees` is
  // deliberately unbounded: how rotation beyond 180° should behave is an open
  // spec question, so a range check here would invent policy.
  assertFinite(r.horizonReveal.hingeDegrees, "recipes.horizonReveal.hingeDegrees", profile.name)
  assertFinite(r.cardMorph.gridZPush, "recipes.cardMorph.gridZPush", profile.name)
  assertFinite(r.breadcrumb.enterSlide, "recipes.breadcrumb.enterSlide", profile.name)
  assertFinite(r.breadcrumb.stepSlide, "recipes.breadcrumb.stepSlide", profile.name)
  assertFinite(r.carousel.exitMidX, "recipes.carousel.exitMidX", profile.name)
  assertFinite(r.carousel.exitMidZ, "recipes.carousel.exitMidZ", profile.name)
  assertFinite(r.carousel.enterStartX, "recipes.carousel.enterStartX", profile.name)
  assertFinite(r.carousel.enterStartZ, "recipes.carousel.enterStartZ", profile.name)
  assertFinite(r.carousel.exitTilt, "recipes.carousel.exitTilt", profile.name)
  assertFinite(r.carousel.entryTilt, "recipes.carousel.entryTilt", profile.name)
  assertFinite(r.carousel.hoverShift, "recipes.carousel.hoverShift", profile.name)
  // A wave direction is an angle like the others — any heading is legal.
  assertFinite(r.skeletonPulse.waveAngleDegrees, "recipes.skeletonPulse.waveAngleDegrees", profile.name)
  // An additive sheen boost has no ceiling to invent (a hot shimmer may
  // exceed 1), so it gets finiteness and a floor only.
  assertFiniteNonNegative(r.skeletonPulse.waveBoost, "recipes.skeletonPulse.waveBoost", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.depthDelay, "recipes.skeletonPulse.depthDelay", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.emberBoost, "recipes.skeletonPulse.emberBoost", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.emberFade, "recipes.skeletonPulse.emberFade", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.handoffFadeOut, "recipes.skeletonPulse.handoffFadeOut", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.handoffFadeIn, "recipes.skeletonPulse.handoffFadeIn", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.handoffScaleFrom, "recipes.skeletonPulse.handoffScaleFrom", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.handoffScaleIn, "recipes.skeletonPulse.handoffScaleIn", profile.name)
  assertEases(r.skeletonPulse.handoffScaleEase, "recipes.skeletonPulse.handoffScaleEase", profile.name)
  assertFiniteNonNegative(r.skeletonPulse.handoffStagger, "recipes.skeletonPulse.handoffStagger", profile.name)
  assertFiniteNonNegative(
    r.skeletonPulse.handoffGroupStagger,
    "recipes.skeletonPulse.handoffGroupStagger",
    profile.name
  )
  assertFiniteNonNegative(
    r.skeletonPulse.handoffSiblingStagger,
    "recipes.skeletonPulse.handoffSiblingStagger",
    profile.name
  )
  // Opacity and scale factors are genuinely bounded.
  // Opacity is genuinely bounded. Scale FRACTIONS are not: a dialog popping
  // from 104% or a reveal shrinking in are both legitimate, and bounding them
  // would invent policy the same way a hingeDegrees range would.
  assertUnitRange(r.carousel.dimmed, "recipes.carousel.dimmed", profile.name)
  // Band width is a fraction of the swept span; the pulse floor/peak are opacities.
  // Lag lengths are fractions of the bar; the shader clamps them anyway, but
  // a lag over 1 or under 0 means the recipe no longer says what it means.
  assertUnitRange(r.loadingBar.lagPeak, "recipes.loadingBar.lagPeak", profile.name)
  assertUnitRange(r.loadingBar.lagResidual, "recipes.loadingBar.lagResidual", profile.name)
  assertUnitRange(r.loadingBar.lagCloseAtHead, "recipes.loadingBar.lagCloseAtHead", profile.name)
  assertFiniteNonNegative(r.loadingBar.lagFall, "recipes.loadingBar.lagFall", profile.name)
  // The sweep is THREE standalone repeat:-1 drivers (head / lag / alpha)
  // that stay in phase only because their keyframe totals are all exactly
  // `period`. The builder floors each derived leg at 1 ms independently, so
  // a recipe that leaves a leg without room would desync one driver's total
  // from the others — a drift that compounds every cycle, forever. Reject
  // those recipes here instead of letting the loop quietly fall apart.
  {
    const lb = r.loadingBar
    const closeTime = lb.headTravel * easeInverse(lb.headEase, lb.lagCloseAtHead)
    const legs: [number, string][] = [
      [lb.period - lb.headTravel, "period - headTravel (the head's parked rest)"],
      [lb.headTravel - lb.entryFade - lb.exitFade, "headTravel - entryFade - exitFade (the lit hold)"],
      [closeTime - lb.lagRise - lb.lagFall, "lagRise + lagFall inside the solved close time (the stretch hold)"]
    ]
    for (const [seconds, meaning] of legs) {
      if (!(seconds >= MIN_LOOP_LEG_SECONDS)) {
        throw new Error(
          `Motion profile "${profile.name}": recipes.loadingBar leaves no room for ${meaning} — ` +
            `${seconds.toFixed(4)}s < ${MIN_LOOP_LEG_SECONDS}s would desync the sweep's three looping drivers.`
        )
      }
    }
  }
  assertUnitRange(r.skeletonPulse.bandWidth, "recipes.skeletonPulse.bandWidth", profile.name)
  assertUnitRange(r.skeletonPulse.pulseMinAlpha, "recipes.skeletonPulse.pulseMinAlpha", profile.name)
  assertUnitRange(r.skeletonPulse.pulseMaxAlpha, "recipes.skeletonPulse.pulseMaxAlpha", profile.name)
  assertEases(r.carousel.segmentEases, "recipes.carousel.segmentEases", profile.name)
  assertEases(r.drawerSlide.ease, "recipes.drawerSlide.ease", profile.name)
  assertEases(r.loadingBar.headEase, "recipes.loadingBar.headEase", profile.name)
  assertEases(r.loadingBar.lagRiseEase, "recipes.loadingBar.lagRiseEase", profile.name)
  assertEases(r.loadingBar.lagFallEase, "recipes.loadingBar.lagFallEase", profile.name)
  const easeKeys: (keyof MotionEases)[] = ["enter", "exit", "precise", "linear", "fallback"]
  for (const key of easeKeys) {
    assertEases(profile.eases[key], `eases.${key}`, profile.name)
  }
}

/**
 * Profiles this library froze, and therefore the only ones whose validation
 * can be memoized: a frozen profile cannot change after it is checked.
 *
 * A hand-authored profile handed straight to `options.profile` is NOT frozen,
 * so it is deliberately absent here — memoizing it would let a caller pass a
 * valid object once, mutate a duration to NaN, and have every later call skip
 * the check. Those get re-validated on each construction, which is a cold
 * path (building an intent), never per-frame work.
 */
const libraryFrozenProfiles: WeakSet<MotionProfile> = new WeakSet()

/** Records a profile as frozen-by-us, so its validation can be memoized. */
function markLibraryFrozen(profile: MotionProfile): MotionProfile {
  libraryFrozenProfiles.add(profile)
  return profile
}

/**
 * Validates a profile, whatever path it arrived by. Frozen library profiles
 * are checked once; anything mutable is checked every time it is used, because
 * it can have changed since the last look.
 */
export function ensureProfileValidated(profile: MotionProfile): void {
  if (libraryFrozenProfiles.has(profile)) {
    return
  }
  validateProfile(profile)
}

/**
 * Library defaults: the System 3.0 motion properties (shared scales) and the
 * spec's per-intent choreography (recipes). A design-system profile derives
 * from these via {@link makeMotionProfile}.
 */
export const defaultMotionProfile: MotionProfile = markLibraryFrozen(
  freezeProfile({
    name: "MotionDefaults",
    durations: {
      enter: 0.667,
      exit: 0.5,
      base: 0.333,
      quick: 0.25,
      spawn: 1.0,
      sweep: 2.0
    },
    eases: {
      enter: spec.enter,
      exit: spec.exit,
      precise: spec.precise,
      linear: linear,
      fallback: defaultEase
    },
    staggers: {
      tight: {each: 0.083},
      base: {each: 0.1}
    },
    recipes: {
      expand: {itemFade: [0.183, 0.333], revealDelay: 0.333, collapseStageOverlap: 0.117},
      notificationExpand: {revealFade: 0.333, revealDelay: 0.333},
      drawerSlide: {ease: [power2.in, power2.out]},
      dialogEnter: {popScale: 0.96},
      horizonReveal: {
        hingeDegrees: 83,
        scaleFrom: 0.5,
        fade: 0.667,
        closeFade: 0.333,
        closeFadeDelay: 0.333,
        closeDuration: 0.667
      },
      cardMorph: {crossfade: 0.333, revealDelay: 0.333, closeCrossfade: 0.25, closeRestoreDelay: 0.25, gridZPush: 150},
      lateralPage: {fade: 0.333},
      breadcrumb: {enterSlide: 60, stepSlide: 30, stepFade: 0.2, stepFadeDelay: 0.167},
      carousel: {
        segment: 0.333,
        // The spec's split-bezier pair — one continuous ease cut at its midpoint.
        segmentEases: [cubicBezier(0.33, 0, 0.5, 1), cubicBezier(0.5, 0, 0.67, 1)],
        exitMidX: -185,
        exitMidZ: -70,
        enterStartX: 50,
        enterStartZ: 50,
        exitTilt: -45,
        entryTilt: 45,
        dimmed: 0.5,
        fade: 0.333,
        fadeDelay: 0.333,
        hoverShift: -80
      },
      loadingBar: {
        period: 2.5,
        headTravel: 2.0,
        // Linear, so "halfway" means the same thing in time and in space: with
        // a front-loaded curve the head crossed mid-bar 8 frames in, which
        // left the reformed streak crawling the second half for 32.
        headEase: linear,
        lagPeak: 0.6,
        lagRise: 0.08,
        lagRiseEase: power2.out,
        lagCloseAtHead: 0.93,
        lagFall: 0.46,
        // Sine in-out: starts and ends at rest, and of the in-out curves it
        // has the flattest velocity peak (π/2 ≈ 1.57× its own average, where
        // a cubic in-out spikes to 3×), so the catch-up never lurches.
        lagFallEase: sine.inOut,
        lagResidual: 0.1,
        entryFade: 0.12,
        exitFade: 0.12,
        fillSmoothing: 0.15
      },
      skeletonPulse: {
        // 3.5 s fits three 0.9 s beats plus the band's crossing without
        // wrapping: 1.8 + 0.9 × pass window ≈ 2.7 < 3.5, with rest to spare.
        wavePeriod: 3.5,
        waveDuration: 1.1,
        waveAngleDegrees: -60,
        // 0.38 of the group span, with the shader holding full brightness
        // across the band's middle half (flat-top profile) — a broad sheen
        // that SITS at its crest. Transit at a point is now ~0.48 s against
        // the 0.45 s depth beat, so cascade levels overlap deliberately.
        bandWidth: 0.38,
        pulseMinAlpha: 0.75,
        pulseMaxAlpha: 1.0,
        // Reference ceiling +8% headroom (art direction 2026-08-24): the
        // spec video's brightest block pixel is #2B2B2B (0.168); ours peaks
        // at 0.168·1.08 ≈ 0.181. Base #242424 (0.141) + waveBoost at the
        // crest + half the ember (its crest-time ramp value) =
        // 0.141+0.034+0.006 = 0.181 — still a sheen, not a flash.
        waveBoost: 0.034,
        depthDelay: 0.45,
        emberBoost: 0.012,
        emberFade: 0.9,
        handoffFadeOut: 0.25,
        handoffFadeIn: 0.333,
        handoffScaleFrom: 0.85,
        handoffScaleIn: 0.9,
        handoffScaleEase: back(1.0).out,
        // Halved from 0.12/0.15/0.1 (art direction 2026-08-24): the reveal
        // reads as one rolling arrival with heavy overlap — pieces still
        // land in order, the queue just doesn't wait. Per-piece fade and
        // pop durations are untouched.
        handoffGroupStagger: 0.06,
        handoffStagger: 0.08,
        handoffSiblingStagger: 0.05
      }
    }
  })
)

/** Partial overrides for {@link makeMotionProfile} — override only what differs. */
export interface MotionProfileOverrides {
  name: string
  durations?: Partial<MotionDurations>
  eases?: Partial<MotionEases>
  staggers?: Partial<MotionStaggers>
  recipes?: {
    expand?: Partial<ExpandRecipe>
    notificationExpand?: Partial<NotificationExpandRecipe>
    drawerSlide?: Partial<DrawerSlideRecipe>
    dialogEnter?: Partial<DialogEnterRecipe>
    horizonReveal?: Partial<HorizonRevealRecipe>
    cardMorph?: Partial<CardMorphRecipe>
    lateralPage?: Partial<LateralPageRecipe>
    breadcrumb?: Partial<BreadcrumbRecipe>
    carousel?: Partial<CarouselRecipe>
    loadingBar?: Partial<LoadingBarRecipe>
    skeletonPulse?: Partial<SkeletonPulseRecipe>
  }
}

/**
 * Derives a complete profile from a base (default: the library defaults) plus
 * partial overrides — a design system declares only what it changes.
 */
export function makeMotionProfile(
  overrides: MotionProfileOverrides,
  base: MotionProfile = defaultMotionProfile
): MotionProfile {
  const merged = {
    name: overrides.name,
    durations: {...base.durations, ...overrides.durations},
    eases: {...base.eases, ...overrides.eases},
    staggers: {...base.staggers, ...overrides.staggers},
    recipes: {
      expand: {...base.recipes.expand, ...overrides.recipes?.expand},
      notificationExpand: {...base.recipes.notificationExpand, ...overrides.recipes?.notificationExpand},
      drawerSlide: {...base.recipes.drawerSlide, ...overrides.recipes?.drawerSlide},
      dialogEnter: {...base.recipes.dialogEnter, ...overrides.recipes?.dialogEnter},
      horizonReveal: {...base.recipes.horizonReveal, ...overrides.recipes?.horizonReveal},
      cardMorph: {...base.recipes.cardMorph, ...overrides.recipes?.cardMorph},
      lateralPage: {...base.recipes.lateralPage, ...overrides.recipes?.lateralPage},
      breadcrumb: {...base.recipes.breadcrumb, ...overrides.recipes?.breadcrumb},
      carousel: {...base.recipes.carousel, ...overrides.recipes?.carousel},
      loadingBar: {...base.recipes.loadingBar, ...overrides.recipes?.loadingBar},
      skeletonPulse: {...base.recipes.skeletonPulse, ...overrides.recipes?.skeletonPulse}
    }
  }
  // Fail fast where the bad value was authored, not frames later inside a
  // transform write. Registration validates too; so does the intent layer for
  // profiles handed straight to an intent (each object is checked once).
  validateProfile(merged)
  return markLibraryFrozen(freezeProfile(merged))
}

const profiles: Map<string, MotionProfile> = new Map()
let activeProfile: MotionProfile = defaultMotionProfile
// The default profile is always registered, so it can always be restored by name.
profiles.set(defaultMotionProfile.name, defaultMotionProfile)

/**
 * Registers (and optionally activates) a profile. Profiles are validated and
 * frozen; registering an existing name explicitly replaces it (with a console
 * note). Profile resolution is INTENT-CONSTRUCTION-TIME: a retained timeline
 * or handle keeps the values it was built with — switching the active profile
 * affects only subsequently created motion. Live rebuild is not a v1 feature.
 */
export function registerMotionProfile(profile: MotionProfile, activate: boolean = false): void {
  // Always re-validate here even if this object was memoized: an unfrozen
  // hand-authored profile can have been mutated since it was last seen.
  validateProfile(profile)
  if (profiles.has(profile.name) && profiles.get(profile.name) !== profile) {
    print(`Motion: replacing registered profile "${profile.name}"`)
  }
  profiles.set(profile.name, markLibraryFrozen(freezeProfile(profile)))
  if (activate) {
    activeProfile = profile
  }
}

export function setActiveMotionProfile(name: string): void {
  const profile = profiles.get(name)
  if (profile === undefined) {
    print(`Motion: no profile named "${name}" is registered; keeping "${activeProfile.name}"`)
    return
  }
  activeProfile = profile
}

export function getActiveMotionProfile(): MotionProfile {
  return activeProfile
}

/**
 * The comfort / reduced-motion policy. Every intent invocation consults it
 * (SpecIntents' launch path) BEFORE building, with enough context to act:
 * the intent name, the requested direction, and the resolved profile. The
 * decision is animate (optionally with an adjusted profile — shorter
 * durations, reduced amplitude recipes) or snap (jump to the direction's end
 * state; completion callbacks still fire). Pass-through in the first pass —
 * shipping an actual policy later is one central change, zero component
 * changes.
 */
export interface MotionPolicyContext {
  intent: string
  direction: "forward" | "reverse"
  profile: MotionProfile
}

export interface MotionPolicyDecision {
  action: "animate" | "snap"
  /** With "animate": build against this profile instead of the requested one. */
  profile?: MotionProfile
  /**
   * With "animate": multiply VALUE-PARAMETERIZED durations by this (component
   * state transitions, whose durations come from a component input rather than
   * a profile token — see StateMotion). 1 or omitted leaves them alone.
   */
  durationScale?: number
}

export type MotionPolicy = (context: MotionPolicyContext) => MotionPolicyDecision

const ANIMATE: MotionPolicyDecision = {action: "animate"}
let policy: MotionPolicy = () => ANIMATE

export function setMotionPolicy(newPolicy: MotionPolicy): void {
  policy = newPolicy
}

export function applyMotionPolicy(context: MotionPolicyContext): MotionPolicyDecision {
  return policy(context)
}

export {cubicBezier}
