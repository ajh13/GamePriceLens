# Motion — how to use it

A tween engine for UIKit and for anything else in a lens. Retained drivers on one clock,
timelines and staggers on top, and a token library holding the System 3.0 motion values.

The engine lives in its own package — `Assets/Motion.lspkg` (verbs, tweens, timelines,
staggers, channels, eases, scopes, the ticker), with its own minimal README. This directory is
UIKit's layer on it: the token library, the typed intent catalog, and the VisibilityGroup alpha
provider.

Two surfaces, both public:

- **Verbs** — `Motion.to` / `from` / `fromTo` / `set` / `handle` / `timeline`, plus staggers, eases
  and channels. Use these anywhere: app code, system UI, a lens, a prototype.
- **Intents** — `Intents.expand(refs)`: the statically typed catalog of the System 3.0 motions
  (`SpecIntents.ts`). Typed refs in, a retained timeline out for most intents — `loaderSweep`,
  `loaderFill` and `skeletonPulse` return tweens instead. Wrong refs are a compile error, and
  there is nothing to bootstrap (even the VisibilityGroup alpha hookup wires itself when that
  module is in the bundle).

One convention, and it covers **UIKit's own component source only**: components call the intent
catalog instead of writing durations and eases inline, so the design system can retune motion in
one place. Outside `Scripts/Components/**`, use whichever fits.

### The one documented exception

`LongPressButton`'s hold ramp calls `Motion.to` directly instead of going through `animateState`.
The hold duration is an interaction requirement, not decoration: a policy returning `snap` would
complete a deliberate confirmation gesture instantly, which is a correctness bug rather than a
comfort win. Its drain and completion transitions do respect the policy. Any future motion that
gates a user commitment on elapsed time belongs in this exception, not in the convention.

---

## Quick start

```ts
import {ch} from "Motion.lspkg/Channels"
import * as Eases from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"

// Animate a property to a value.
Motion.to(myObject, {channel: ch.positionY, value: 12, duration: 0.4, ease: Eases.power2.out})

// Animate FROM a value to wherever the target already is (the enter idiom).
Motion.from(myObject, {channel: ch.alpha, value: 0, duration: 0.3})

// Write immediately, no animation.
Motion.set(myObject, {channel: ch.alpha, value: 1})
```

`from()` is the one to reach for on enter. It reads the destination off the live target at first
render, so layout stays the source of truth and the value can't go stale when layout re-runs or a
row recycles.

## Interruption

There is nothing to manage. Call again and the property continues from wherever it is:

```ts
Motion.to(obj, {channel: ch.positionX, value: 10, duration: 0.5})
// ...200ms later, different target value, no cancel, no pop:
Motion.to(obj, {channel: ch.positionX, value: -4, duration: 0.5})
```

One live tween per (target, property): a new tween on the same property replaces the old one,
always — there is deliberately no layering option, so the registry is never lying about who
writes what. The built-ins conflict honestly with each other: `position` conflicts with every
position axis (axes compose with one another), same for scale, and all rotation channels conflict
as one family. Beyond the built-ins, a channel's id and target are the conflict contract — two
custom channels writing the same state under different ids are yours to manage.

For high-frequency retargeting (a slider chasing a pointer), `Motion.handle(target, channel, base)`
returns a setter bound to one persistent driver — call it with new destinations as fast as you
like; the driver retargets in place and nothing is allocated per call.

Queries: `Motion.isTweening(target)`, `Motion.getTweensOf(target)`,
`Motion.killTweensOf(target, channelId?)`. `isTweening` reports *running* motion: a completed
timeline releases its targets (and reacquires them on replay), so it goes false when visible
motion ends.

## Channels

A channel is where a value lands. Built in:

| Channel | Writes |
|---|---|
| `ch.position` · `positionX/Y/Z` | local position |
| `ch.scale` · `scaleX/Y/Z` | local scale |
| `ch.rotation` | local rotation (quat, slerped) |
| `ch.rotationX/Y/Z` | one euler axis, **in degrees** |
| `ch.alpha` | an opacity writer, clamped to [0,1] |

`ch.alpha` accepts anything exposing an `opacity` property. If the target is a SceneObject inside a
`VisibilityGroup`, it resolves to that group's subtree opacity scale automatically, so your fade
multiplies with the group's rather than fighting it.

Anything else goes through `custom`:

```ts
import * as Channels from "Motion.lspkg/Channels"

const glow = Channels.custom<number>("myShader.glow", () => ({
  read: () => pass.glow,
  write: (v) => (pass.glow = v)
}))
Motion.to(myObject, {channel: glow, value: 1, duration: 0.3})
```

The string id is the overwrite key — reuse the same id for the same conceptual property.
`Channels.shaderFloat(visual, "paramName")` is a shorthand for material pass floats.

## Timelines

```ts
const tl = Motion.timeline({defaults: {duration: 0.3, ease: Eases.power2.out}})
  .add(panel, {channel: ch.alpha, from: 0})
  .add(panel, {channel: ch.scale, from: new vec3(0.96, 0.96, 0.96)}, {at: "withPrevious"})
  .add(footer, {channel: ch.alpha, from: 0}, {at: "afterPrevious", offset: -0.1})

tl.play()          // forward
tl.play(false)     // backward — this is your exit
tl.reverse()       // flip whichever direction it's going
tl.pause()
tl.scrub(0.5)      // move the playhead without playing
tl.progress        // read it
tl.kill()
```

Everything that mutates returns the timeline, so `.scrub(0.5).play()` chains.

**Positions:** `{at: "afterPrevious" | "withPrevious", offset?}` or `{time}` for an absolute start.
Any of those may be `[reverse, forward]` to differ per direction.

**Exit is the same timeline reversed.** Author the enter once. Durations, eases, and start offsets
can all differ per direction, and the schedule re-resolves when direction changes — so "collapse
is faster and staggers the other way" is data, not a second timeline.

**A reverse ease describes the reverse motion's own feel.** Where you give one, it applies to the
reverse progress (`1 − ease(1 − t)`), not the forward curve played backwards — `[power2.in,
power2.out]` really does accelerate out and accelerate back, and the spec's exit bezier renders as
designed on exit.

**Interruption:** `play(dir)` mid-flight continues from the current playhead.

- Nothing per-direction in the timeline → reverse is a literal retrace (mirrored schedule, forward
  curves), and the flip is exactly continuous on EVERY channel. Nothing pops, ever.
- Something per-direction → two schedules over two curves, which cannot also be continuous. The
  first child (the primary surface in every intent) is held exactly; the rest re-phase.

Most intents are in the first bucket. `expand`, `dialogEnter`, `horizonReveal`,
`cardMorph` and `notificationExpand` are in the second by design — the spec gives them their own
exit timings — so interrupting one of those mid-flight steps on its secondary channels. Worth
knowing before you wire a gesture straight to `reverse()`.

**Scrubbing from input:** `tl.scrub(dragFraction)` — drag-driven motion lives here.

## Multi-step moves (keyframes)

A move that passes through intermediate stops is data on ONE child, not several
children taking turns on the same property:

```ts
tl.add(item, {
  channel: ch.position,
  from: rest,
  keyframes: [
    {value: mid, ease: Eases.power2.out},                     // leg 1
    {value: slot, duration: 0.5, ease: Eases.power2.in}       // leg 2
  ]
})
```

Each entry describes the leg ENDING at that stop; `duration`/`ease` are per leg and fall back
to the child's own values (so the child's `duration` is a per-leg fallback, not the total).
One child owns the property for the whole path, which is what makes the move killable and
queryable as a unit and lets `reverse()` retrace it — including a mid-flight direction change,
which preserves the rendered value by solving inside the active leg. `retarget()` collapses a
path to a straight move from the live value. Adding a SECOND child on a property another child
already animates throws: that shape could not be owned, killed or reversed coherently.

The carousel advance is the case this exists for — see
the Motion keyframe reference in the development project.

## Staggers

`distribute` returns `(index) => delaySeconds`. Pure function, no timers.

```ts
import {distribute} from "Motion.lspkg/Stagger"

const delayOf = distribute(tiles.length, {
  amount: 0.4,        // TOTAL seconds spread across all items
  // each: 0.1,       // ...or fixed seconds between consecutive items
  base: 0.2,          // delay added to every item
  from: "start",      // "start" | "end" | "center" | an index
  ease: Eases.power2.in // shapes the distribution of start times
})

tiles.forEach((tile, i) =>
  tl.add(tile, {channel: ch.alpha, from: 0}, {time: delayOf(i)})
)
```

Prefer `amount` for lists that can grow: it bounds the whole cascade regardless of item count.
`each` matches the spec's per-item formulas but is unbounded in N.

## Looping

`repeat` and `yoyo` live on a tween:

```ts
// Breathe forever: -1 repeats without limit, yoyo alternates direction.
Motion.to(icon, {channel: ch.scaleY, value: 1.08, duration: 0.8, repeat: -1, yoyo: true})

// Three extra cycles, always forward.
Motion.to(icon, {channel: ch.rotationZ, value: 360, duration: 1.2, repeat: 3})
```

Stop it with `tween.kill()`, `Motion.killTweensOf(target)`, or a scope `revert()`.

Two things to know:

- **`repeat`/`yoyo` are tween-only.** Timelines have no repeat — they own their children's
  scheduling. To loop a sequence, re-`play()` from its `onComplete`.
- **A looping tween never settles**, so it stays in the ticker every frame for as long as it runs.
  Fine for a short UI pulse. For continuous decoration — shimmer, a skeleton sweep, breathing
  across many instances — drive it from a time node in the material graph instead: no per-frame
  script, and one shared material covers N instances.

## Scopes, pooling, and cleanup

Everything can belong to a scope. Reverting a scope kills its tweens and restores the authored
values it captured:

```ts
import {MotionScope} from "Motion.lspkg/MotionScope"

const scope = MotionScope.for(myRow)          // or: new MotionScope()
Motion.from(myRow, {channel: ch.alpha, value: 0, scope})

// on recycle / teardown:
scope.revert()      // kill + restore authored values
scope.release()     // kill + forget, no writes
```

**If your targets are pooled or recycled, use a scope.** A recycled object that keeps a stale
animated value is the bug this exists to prevent.

## Tokens and intents

Numbers live in `MotionTokens.ts` (library defaults) and in registered profiles. A profile is
**pure data** — the shared scales (durations, eases, staggers) plus per-intent **recipes**
(the item fade times, the dialog pop scale, the drawer eases…), so a design system retunes
every stock motion, not just the global feel. Never inline motion numbers in a component.

```ts
import {getActiveMotionProfile, makeMotionProfile, registerMotionProfile} from ".../MotionTokens"
import {Intents} from ".../SpecIntents"

// Read tokens.
const p = getActiveMotionProfile()
p.durations.enter            // 0.667   p.eases.enter   // bezier(.6,0,.15,1)
p.durations.exit             // 0.5     p.eases.exit    // bezier(.6,0,.25,1)
p.durations.base             // 0.333   p.eases.linear
p.durations.quick            // 0.25    p.eases.precise
p.recipes.expand.itemFade    // [0.183, 0.333]
p.recipes.dialogEnter.popScale  // 0.96

// Play an intent: typed refs in, retained timeline out.
const tl = Intents.dialogEnter({target, authoredScale, fade})
tl.play(false)   // exit = the same timeline reversed

// A design system derives from the defaults and overrides only what differs.
registerMotionProfile(
  makeMotionProfile({
    name: "MyDS",
    durations: {enter: 0.5},
    recipes: {dialogEnter: {popScale: 0.9}}
  }),
  /* activate */ true
)
```

**Profile resolution is intent-construction-time.** An intent reads the active profile when it
builds its timeline; the retained timeline keeps those values on every replay. Switching the
active profile affects only motion created afterwards — live rebuild of existing timelines and
handles is deliberately not a v1 feature. Registered profiles are validated, frozen snapshots;
the default profile is always registered (`"MotionDefaults"`), so it can always be restored.

Every intent invocation consults the comfort / reduced-motion **policy** before building. The
policy sees `{intent, direction, profile}` and answers animate, animate-with-adjusted-profile,
or snap (jump to the end state; completion callbacks still fire):

```ts
import {setMotionPolicy} from ".../MotionTokens"

setMotionPolicy(({intent}) => (reduceMotion ? {action: "snap"} : {action: "animate"}))
```

The catalog today: `expand`, `panelFade`, `drawerSlide`, `highlight`, `dialogEnter`,
`horizonReveal`, `navCrossfade`, `lateralPage`, `cardMorph`, `breadcrumbEnter`,
`breadcrumbStep`, `carouselAdvance`, `carouselHover`, `notificationExpand`, `loaderSweep`,
`loaderFill`, `skeletonPulse`, `skeletonHandoff`. See `SpecIntents.ts` for their values and
return types; anything marked `PROVISIONAL` is still subject to change.

There is deliberately no custom-intent registry: apps compose the verbs directly (a timeline
factory function in your own code does everything a named intent did).

## Debugging

```ts
Motion.timeScale = 0.25   // slow everything down; 1 restores
```

One clock means one knob. Useful for design review — most of this motion is under a second, and
choreography is much easier to judge at quarter speed.

## Gotchas

- **Anything you plan to fade needs a blending blend mode.** `RoundedRectangleVisual` defaults to
  opaque, which ignores alpha outright. Use `visual.transparencyEnabled = true`, or set
  `RoundedRectBlendMode.Normal`.
- **Fades write factors, not final values.** If a component recomputes a final colour from a state
  machine (`ElementContent` composes `stateColor.a * opacityFactor`), write the *factor*. Writing
  the composed value means the next state change — a hover — recomputes over your fade.
- **Content can appear a frame late.** `ElementContent` builds its Text on `OnStartEvent`, so a
  fade started the same frame as creation has nothing to write to yet. Re-resolve targets and call
  `timeline.reapply()` so newcomers adopt the in-flight value instead of popping in.
- **Engine classes aren't runtime globals.** `instanceof SceneObject` compiles and then throws at
  runtime — duck-type instead (`typeof x.getTransform === "function"`). `vec3`/`quat` are fine.
- **The layout-size channel re-runs layout every frame.** Animating a layout *input* (a margin, a
  container size) is legitimate but expensive; prefer transform and alpha, which are outputs.
- **Rotation channels are degrees** (`ch.rotationX/Y/Z`), matching how the spec writes them.

## Files

Engine (`Assets/Motion.lspkg`): `Motion.ts` public API · `Tween.ts` drivers + registry ·
`Timeline.ts` · `Stagger.ts` · `Channels.ts` · `MotionTicker.ts` clock · `MotionScope.ts` ·
`Eases.ts` · `MotionTypes.ts` / `MotionValueMath.ts` internals.

UIKit layer (this directory): `MotionTokens.ts` token library + profiles + policy ·
`SpecIntents.ts` the typed intent catalog · `StateMotion.ts` the policy-aware entry point for
value-parameterized (component state) motion · `VisibilityGroupAlpha.ts` the composed alpha
provider (self-registering).

A scene that keeps its own clock alongside motion must accumulate
`motionDeltaTime()`, not `getDeltaTime()` — the ticker clamps a frame to 1/30s, so raw wall
time runs ahead of the animation during a hitch and probes fire early.
