// @module System-3.0/Gradients/PrismPalette — DO NOT REMOVE: prevents Lens Studio module collision

/**
 * Per-state palette pushed into the prism shader's `master0..2` and
 * `accent0..3` uniforms. The vertex shader evaluates the master stops as a
 * directional corner-to-corner band (× a far-offset glow) for the face and
 * the accent stops as the rim / bevel / side highlight band, passing both to
 * the fragment as varyings. `master0.a` is repurposed as a per-state
 * "desaturate the flat Z face" amount (1 = grey the face, 0 = leave it
 * coloured). `master1.a` is repurposed as the "blue bevel highlight
 * sections" gate (1 = show, 0 = hide) — on for hover/pressed palettes,
 * off for idle AND selected-at-rest. `master2.a` is repurposed as the
 * per-state BEVEL GAIN level (0 = idle's dim ring, 1 = the high
 * hover/toggled ring; triggered sits at 0.5, between). All three lerp
 * through the palette tween so they fade with state. Accent alphas are
 * unused.
 */
export type PrismStateColors = {
  master0: vec4
  master1: vec4
  master2: vec4
  accent0: vec4
  accent1: vec4
  accent2: vec4
  accent3: vec4
}

/**
 * Reflection (matcap) intensity multiplier, pushed once in
 * BeveledPrism.configureMesh. The reference FloatingMain runs a hot 2.0
 * here, but its face form comes from fixed UV gradients — the matcap is
 * added only as a thin highlight streak on top. Ours was leaning on the
 * matcap for the entire face look (idle master stops were flat), so it
 * dominated and its per-vertex "swim" read as the whole face sliding
 * around as you moved. Now that the master gradient carries a real dome
 * (see PRISM_IDLE_COLORS), the matcap is demoted to a subtle highlight and
 * the swim stops reading. Tune to taste: raise for more shine, lower for a
 * flatter matte face. Static (not state-driven) — like the reference, the
 * reflection layer is constant across states; the body palette carries the
 * state changes.
 */
export const PRISM_REFLECTION_INTENSITY: number = 0.8

// VisDev: every non-idle state read too saturated and too bright. All
// hover/active/selected palettes (idle untouched) are toned down through
// tone() below: chroma pulled toward luma, brightness scaled down.
// 1.0 = authored values unchanged. Two and a half -25%/-15% rounds
// compounded: 0.75² × 0.875 / 0.85² × 0.925.
const STATE_SAT_SCALE = 0.492
const STATE_BRIGHT_SCALE = 0.668

// Pull a stop's chroma toward its Rec.601 luma by satScale, then scale
// brightness by brightScale. Alpha passes through untouched — master0.a /
// master1.a are shader gates, not color channels.
function toneWith(c: vec4, satScale: number, brightScale: number): vec4 {
  const luma = 0.299 * c.x + 0.587 * c.y + 0.114 * c.z
  return new vec4(
    (luma + (c.x - luma) * satScale) * brightScale,
    (luma + (c.y - luma) * satScale) * brightScale,
    (luma + (c.z - luma) * satScale) * brightScale,
    c.w
  )
}

function tone(c: vec4): vec4 {
  return toneWith(c, STATE_SAT_SCALE, STATE_BRIGHT_SCALE)
}

// VisDev: selected-at-rest ("toggled idle") reads under-saturated through
// the shared state toning — it keeps more chroma (same brightness scale).
const SELECTED_SAT_SCALE = 0.65

function toneSelected(c: vec4): vec4 {
  return toneWith(c, SELECTED_SAT_SCALE, STATE_BRIGHT_SCALE)
}

/**
 * Idle palette — only the flat Z FACE desaturates; the side walls and bevel
 * stay colourful (just below hover). The master stops are a muted violet→teal
 * (what the sides want), and master0.a = 1 tells the shader to grey the colour
 * *on the flat face only* — the bevel / side region keeps the full master
 * colour (see BeveledPrismShader). hover/active set master0.a = 0 so their
 * faces stay coloured. Accent (rim / bevel / side stripe highlights) is a
 * muted mint→cyan, the hover family dialled back.
 *
 * VisDev pass (colleague notes on the idle bevel edge): masters desaturated
 * (~25% chroma pull toward luma → "less intense"), the blue mid stop
 * replaced with a DARK NEUTRAL grey ("no blue in idle" + "mid part is
 * darker") so the ring reads violet → dark grey → teal. Pull the end stops
 * further toward their luma for even less colour; darken master1 for a
 * deeper mid.
 */
export const PRISM_IDLE_COLORS: PrismStateColors = {
  master0: new vec4(0.33, 0.21, 0.34, 1.0), // edge end A — deep violet, pulled toward magenta (+R −B, VisDev) (a=1: grey the flat face)
  master1: new vec4(0.18, 0.19, 0.19, 0.0), // mid — dark neutral grey (a=0: no blue bevel sections at idle)
  master2: new vec4(0.33, 0.47, 0.37, 0.0), // edge end B — muted teal, warmed toward yellow (a=0: idle's dim bevel gain)
  // Idle rim/bevel highlight = NEUTRAL GREY (no cyan at rest). These are the
  // hover mint→cyan stops desaturated to their luma, so the rim keeps the same
  // brightness ramp but zero hue; cyan returns on hover via PRISM_HOVER_COLORS.
  // accent0 sits at the VIOLET pole of the edge band (dirT=0). It is the
  // fresnel rim highlight there, layered un-dimmed over the master — a pure
  // neutral grey reads as a white wash on the violet arc, so it carries a
  // violet tint at the same luma instead. Pull toward (0.6,0.6,0.6) to
  // re-neutralize.
  accent0: new vec4(0.61, 0.55, 0.71, 1.0), // violet-tinted rim over the violet pole, ~30% final desat
  accent1: new vec4(0.73, 0.73, 0.73, 1.0), // was mint, desaturated
  accent2: new vec4(0.24, 0.24, 0.24, 1.0), // was cyan, desaturated
  accent3: new vec4(0.76, 0.76, 0.76, 1.0) // was light-cyan, desaturated
}

/**
 * Hover palette — multi-colour band running corner-to-corner (violet at the
 * bottom-right corner → teal/mint at the top-left), the "multiple colours
 * corner to corner" hover look from the reference. Brighter than the old
 * compressed values since the matcap is demoted now and the gradient carries
 * the colour itself. master1 is a distinct blue mid for a richer three-colour
 * sweep (mild per-vertex banding at the knee is acceptable at our density).
 */
export const PRISM_HOVER_COLORS: PrismStateColors = {
  master0: tone(new vec4(0.39, 0.21, 0.44, 0.0)), // bottom-right — violet toward magenta (a=0: face stays coloured)
  master1: tone(new vec4(0.26, 0.36, 0.5, 1.0)), // mid — blue (a=1: blue bevel sections ON while hovered)
  master2: tone(new vec4(0.26, 0.6, 0.45, 1.0)), // top-left — teal/mint, warmed toward yellow (a=1: full hover bevel gain)
  // V12 at authored brightness — 6-stop reduced to c0/c1/c2/c4 (drops c3
  // deep blue and c5 light gray bookend identical to c0). Captures the
  // mint→cyan→light-cyan arc that gives hover its glow at the rim.
  accent0: tone(new vec4(0.7, 0.7, 0.7, 1.0)), // V12 c0 (light gray)
  accent1: tone(new vec4(0.493, 1.0, 0.916, 1.0)), // V12 c1 (mint)
  accent2: tone(new vec4(0.0, 0.333, 0.5, 1.0)), // V12 c2 (cyan)
  accent3: tone(new vec4(0.725, 0.954, 1.0, 1.0)) // V12 c4 (light cyan)
}

// Selected ("toggledDefault") is the hover palette with ONE difference:
// master1.a = 0, so the blue bevel highlight sections stay off while a
// toggle rests in its on state (they're a hover/press affordance, not a
// selection affordance). No longer an alias for that reason — RGB stops
// are identical to PRISM_HOVER_COLORS.
export const PRISM_SELECTED_COLORS: PrismStateColors = {
  master0: toneSelected(new vec4(0.39, 0.21, 0.44, 0.0)),
  master1: toneSelected(new vec4(0.26, 0.36, 0.5, 0.0)), // a=0: no blue bevel sections at selected-rest
  // a=1.45: selected-at-rest bevel gain extrapolates ABOVE the hover level
  // (the mix in the shader is linear, so >1 keeps working) — the style's
  // 0.65 opacity otherwise leaves the toggled-idle ring dimmer.
  master2: toneSelected(new vec4(0.26, 0.6, 0.45, 1.45)),
  accent0: toneSelected(new vec4(0.7, 0.7, 0.7, 1.0)),
  accent1: toneSelected(new vec4(0.493, 1.0, 0.916, 1.0)),
  accent2: toneSelected(new vec4(0.0, 0.333, 0.5, 1.0)),
  accent3: toneSelected(new vec4(0.725, 0.954, 1.0, 1.0))
}

export const PRISM_ON_HOVERED_COLORS: PrismStateColors = {
  master0: tone(new vec4(0.46, 0.25, 0.52, 0.0)),
  master1: tone(new vec4(0.307, 0.425, 0.59, 1.0)),
  master2: tone(new vec4(0.3, 0.7, 0.53, 1.0)),
  accent0: tone(new vec4(0.826, 0.826, 0.826, 1.0)),
  accent1: tone(new vec4(0.582, 1.0, 1.0, 1.0)),
  accent2: tone(new vec4(0.0, 0.393, 0.59, 1.0)),
  accent3: tone(new vec4(0.856, 1.0, 1.0, 1.0))
}

/**
 * Active (triggered) palette — the hover RGB stops (a press rotates the
 * colour band, it doesn't recolour), with ONE difference: master2.a = 0.5
 * puts the triggered bevel gain halfway between idle's dim ring and the
 * high hover/toggled level. No longer a hover alias for that reason.
 */
export const PRISM_ACTIVE_COLORS: PrismStateColors = {
  master0: tone(new vec4(0.39, 0.21, 0.44, 0.0)),
  master1: tone(new vec4(0.26, 0.36, 0.5, 1.0)), // a=1: blue bevel sections stay on through the press
  master2: tone(new vec4(0.26, 0.6, 0.45, 0.5)), // a=0.5: triggered bevel gain sits between idle and hover
  accent0: tone(new vec4(0.7, 0.7, 0.7, 1.0)),
  accent1: tone(new vec4(0.493, 1.0, 0.916, 1.0)),
  accent2: tone(new vec4(0.0, 0.333, 0.5, 1.0)),
  accent3: tone(new vec4(0.725, 0.954, 1.0, 1.0))
}
