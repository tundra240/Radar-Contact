/**
 * High ground, drawn the way a chart draws it.
 *
 * A mountain is not a hazard area. An area has an edge and an inside, and
 * that is all it has; a mountain has a shape, a direction it rises in, and
 * a top. Drawn as one flat outline with one number in it, the Maritime Alps
 * behind Nice say "do not go here", which is true and nearly useless: the
 * question a controller actually asks is how far in they can take somebody
 * at six thousand feet, and a single shape cannot answer it.
 *
 * So terrain is contoured. Each band is the ground above a height, nested
 * inside the one below it, and three things carry the reading:
 *
 * - the wash gets denser as the ground gets higher, so the massif has a
 *   gradient and you can see where its bulk is without reading anything;
 * - the outlines are hachured -- short ticks on the uphill side, the
 *   cartographer's mark for a slope -- so which way is up is visible at a
 *   glance and does not depend on colour at all;
 * - the summit carries a spot height, because the number that makes a
 *   minimum believable is how high the hill actually is.
 *
 * The lettering stays in the warning ink throughout. The bands are shaded
 * on a ramp, but a label has to be read rather than sensed, and a contour
 * figure drawn in the faint tint of low ground would be a number you have
 * to lean in for.
 */

import type { Camera } from '../core/camera'
import type { Vec2NM } from '../core/geo'
import { inShape, type TerrainZone, type ZoneShape } from '../sim/zones'
import { fonts, theme } from './theme'

/** How many segments a circular zone is drawn with. */
const CIRCLE_STEPS = 64

/** Along-contour distance between hachures, and how long each one is. */
const HACHURE_SPACING_PX = 21
const HACHURE_LENGTH_PX = 5

/**
 * The band below which shading is at its faintest, and the one at which it
 * is fullest.
 *
 * Absolute rather than per-field, so the same wash means the same height
 * everywhere: a controller moving from Barcelona to Nice should not have to
 * relearn what dark means.
 */
const RAMP_FLOOR_FT = 3000
const RAMP_CEILING_FT = 11000

/** Keep labels this far inside the glass. */
const LABEL_MARGIN_PX = 26

/** A band too small to letter without covering itself. */
const MIN_LABEL_SPAN_PX = 46

interface Vec2Px {
  readonly x: number
  readonly y: number
}

/** One contour band, ready to draw. */
interface Band {
  readonly zone: TerrainZone
  readonly world: readonly Vec2NM[]
  readonly screen: readonly Vec2Px[]
  /** Bands of the same massif that stand above this one. */
  readonly above: readonly TerrainZone[]
  /** The next band up, as a hole to punch in this one's wash. */
  readonly hole: readonly Vec2Px[] | null
  /** Where the ground rises to, in screen space: which way a tick points. */
  readonly uphill: Vec2Px
}

/**
 * Draw every terrain band, lowest first.
 *
 * Order matters twice over. The washes stack, so drawing upwards makes the
 * summit the densest part of the massif for free; and the lettering all
 * happens after the shading, so no label ends up under a wash laid down by
 * a band drawn later.
 */
export function drawTerrain(
  g: CanvasRenderingContext2D,
  cam: Camera,
  terrain: readonly TerrainZone[],
): void {
  if (terrain.length === 0) return

  const bands = prepare(terrain, cam)
  if (bands.length === 0) return

  g.save()
  g.lineWidth = 1
  g.lineJoin = 'round'

  for (const band of bands) {
    const t = steepness(band.zone.minimumSafeFt)
    const ink = rampAt(t)

    // The ring of ground between this contour and the next one up, rather
    // than everything inside this contour. Filling the whole footprint
    // would stack three washes over the summit and one over the foothills,
    // which gives a gradient of sorts -- but an accidental one, where the
    // density depends on how many bands a hill happens to have been drawn
    // with instead of on how high the ground is. Punched out, each band
    // carries exactly the weight its own height earns.
    tracePath(g, band.hole === null ? [band.screen] : [band.screen, band.hole])
    g.globalAlpha = 0.085 + t * 0.115
    g.fillStyle = ink
    g.fill('evenodd')

    // The boundary itself, denser than the wash: high ground has an edge
    // you can be a mile the wrong side of.
    tracePath(g, [band.screen])
    g.globalAlpha = 0.5 + t * 0.3
    g.strokeStyle = ink
    g.stroke()

    hachure(g, band, cam)
  }

  labelAll(g, bands, cam)
  g.restore()
}

/* ----------------------------------------------------------- preparation */

/** Every band, in drawing order, with what each one needs to know. */
function prepare(terrain: readonly TerrainZone[], cam: Camera): Band[] {
  const ordered = [...terrain].sort((a, b) => a.minimumSafeFt - b.minimumSafeFt)
  const out: Band[] = []

  for (const zone of ordered) {
    const world = ringOf(zone.shape)
    const screen = world.map((p) => cam.worldToScreen(p))
    if (!onGlass(screen, cam)) continue

    const above = ordered.filter(
      (o) => massifOf(o) === massifOf(zone) && o.minimumSafeFt > zone.minimumSafeFt,
    )
    // Uphill is the next band up, or -- at the top -- the summit of this
    // one. A tick on the seaward edge of a coastal band then points inland,
    // which is where the ground actually goes.
    const target = above[0] ?? zone
    out.push({
      zone,
      world,
      screen,
      above,
      // The next band up only. It contains every band above it in turn, so
      // one hole takes all of them out.
      hole: above[0] === undefined ? null : ringOf(above[0].shape).map((p) => cam.worldToScreen(p)),
      uphill: cam.worldToScreen(highPointOf(target)),
    })
  }
  return out
}

/**
 * Which massif a band belongs to.
 *
 * Bands of one hill are lettered once between them; a zone that names no
 * massif is a hill on its own and is its own group.
 */
function massifOf(zone: TerrainZone): string {
  return zone.massif ?? zone.id
}

/** A zone's outline as a ring of points, whichever shape it is. */
function ringOf(shape: ZoneShape): Vec2NM[] {
  if (shape.kind === 'polygon') return [...shape.verticesNM]
  const out: Vec2NM[] = []
  for (let i = 0; i < CIRCLE_STEPS; i += 1) {
    const a = (i / CIRCLE_STEPS) * Math.PI * 2
    out.push({
      x: shape.centreNM.x + Math.cos(a) * shape.radiusNM,
      y: shape.centreNM.y + Math.sin(a) * shape.radiusNM,
    })
  }
  return out
}

/**
 * The top of a band: its summit where one is recorded, else its middle.
 *
 * A contour band drawn from a coastline runs off the edge of the world to
 * close itself, so its centroid is somewhere out in the next country. The
 * summit is the only honest place to hang a label on one.
 */
function highPointOf(zone: TerrainZone): Vec2NM {
  if (zone.summitNM !== undefined) return zone.summitNM
  const ring = ringOf(zone.shape)
  return {
    x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
    y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
  }
}

/** Whether any of a ring is near enough the viewport to bother with. */
function onGlass(ring: readonly Vec2Px[], cam: Camera): boolean {
  const pad = 40
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return maxX > -pad && minX < cam.width + pad && maxY > -pad && minY < cam.height + pad
}

/* --------------------------------------------------------------- shading */

/** Where a band sits on the ramp, from bottom to top. */
function steepness(minimumSafeFt: number): number {
  const span = RAMP_CEILING_FT - RAMP_FLOOR_FT
  return Math.max(0, Math.min(1, (minimumSafeFt - RAMP_FLOOR_FT) / span))
}

/** The tint for a point on the ramp. */
function rampAt(t: number): string {
  return mix(theme.terrainLow, theme.terrainHigh, t)
}

/** Two hex colours, blended. */
function mix(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1), 16)
  const b = parseInt(to.slice(1), 16)
  const chan = (shift: number): number => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    return Math.round(x + (y - x) * t)
  }
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hex(chan(16))}${hex(chan(8))}${hex(chan(0))}`
}

/**
 * One or more rings as a single closed path.
 *
 * More than one so a band can be filled with the next one up cut out of it,
 * under the even-odd rule. Circles are in here too: they were sampled to
 * points on the way in, which is what lets a hachure walk them.
 */
function tracePath(
  g: CanvasRenderingContext2D,
  rings: readonly (readonly Vec2Px[])[],
): void {
  g.beginPath()
  for (const ring of rings) {
    ring.forEach((p, i) => {
      if (i === 0) g.moveTo(p.x, p.y)
      else g.lineTo(p.x, p.y)
    })
    g.closePath()
  }
}

/* -------------------------------------------------------------- hachures */

/**
 * Ticks along the uphill side of a contour.
 *
 * Walked at a fixed spacing in pixels rather than one per vertex, so the
 * marks stay evenly spread however coarse or fine the outline is and
 * however far the scope is zoomed in.
 *
 * Sections buried under a higher band are skipped. A contour still runs
 * through there -- it is nested, that is what nested means -- but the slope
 * it marks is not the outer face of the massif, and ticking it would draw
 * a cliff in the middle of a mountain.
 */
function hachure(g: CanvasRenderingContext2D, band: Band, cam: Camera): void {
  const t = steepness(band.zone.minimumSafeFt)
  g.beginPath()
  let carried = 0

  for (let i = 0; i < band.screen.length; i += 1) {
    const a = band.screen[i]
    const b = band.screen[(i + 1) % band.screen.length]
    const aw = band.world[i]
    const bw = band.world[(i + 1) % band.world.length]
    if (a === undefined || b === undefined || aw === undefined || bw === undefined) continue

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue

    // The uphill perpendicular: whichever of the two normals points at the
    // ground above.
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2
    let nx = -dy / len
    let ny = dx / len
    if (nx * (band.uphill.x - midX) + ny * (band.uphill.y - midY) < 0) {
      nx = -nx
      ny = -ny
    }

    for (let d = carried; d < len; d += HACHURE_SPACING_PX) {
      const f = d / len
      const px = a.x + dx * f
      const py = a.y + dy * f
      if (px < -8 || py < -8 || px > cam.width + 8 || py > cam.height + 8) continue
      const at = { x: aw.x + (bw.x - aw.x) * f, y: aw.y + (bw.y - aw.y) * f }
      if (band.above.some((o) => inShape(o.shape, at))) continue
      g.moveTo(px, py)
      g.lineTo(px + nx * HACHURE_LENGTH_PX, py + ny * HACHURE_LENGTH_PX)
    }
    carried = (carried - len) % HACHURE_SPACING_PX
    if (carried < 0) carried += HACHURE_SPACING_PX
  }

  g.globalAlpha = 0.45 + t * 0.3
  g.strokeStyle = rampAt(t)
  g.stroke()
}

/* ---------------------------------------------------------------- labels */

/**
 * Name each massif once and number every other contour.
 *
 * A two-line label on all seven bands at Barcelona would be a paragraph
 * spread over the scope. One name per hill, at its summit, and a bare
 * minimum on each of the other contours -- put on the side of the ring
 * facing the field, because that is the side traffic arrives from and the
 * number is a question about how low you can bring somebody in.
 */
function labelAll(g: CanvasRenderingContext2D, bands: readonly Band[], cam: Camera): void {
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = theme.warn

  const summits = new Map<string, Band>()
  for (const band of bands) summits.set(massifOf(band.zone), band)

  // Names first and highest first, so that where two hills are close enough
  // to argue over the same patch of glass, the one that would kill you
  // wins.
  // How big the hill is, not how big its top is. A massif is named off
  // its widest contour: zoomed out, the summit band shrinks below the
  // threshold long before the mountain does, and culling on that alone
  // wiped the name off a range still covering a third of the display.
  const widest = new Map<string, number>()
  for (const band of bands) {
    const key = massifOf(band.zone)
    widest.set(key, Math.max(widest.get(key) ?? 0, spanOf(band.screen)))
  }

  const taken: Rect[] = []
  const named = bands.filter((b) => summits.get(massifOf(b.zone)) === b).reverse()
  for (const band of named) {
    if ((widest.get(massifOf(band.zone)) ?? 0) < MIN_LABEL_SPAN_PX) continue
    nameMassif(g, band, cam, taken)
  }
  for (const band of bands) {
    // A hill a few pixels across, zoomed right out. Anything written on it
    // would be bigger than the ground it describes.
    if (spanOf(band.screen) < MIN_LABEL_SPAN_PX) continue
    if (summits.get(massifOf(band.zone)) !== band) contourNumber(g, band, cam, taken)
  }
}

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The box a piece of lettering will occupy.
 *
 * Estimated from the character count rather than measured. The scope is set
 * in a monospaced face, so an estimate is very nearly exact, and measuring
 * would mean a canvas call per label per frame to place text that only has
 * to not overlap.
 */
function boxOf(text: string, sizePx: number, x: number, y: number): Rect {
  const w = text.length * sizePx * 0.62
  return { x: x - w / 2, y: y - sizePx / 2, w, h: sizePx }
}

function clashes(box: Rect, taken: readonly Rect[]): boolean {
  return taken.some(
    (o) =>
      box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y,
  )
}

/** The larger of a ring's two screen extents. */
function spanOf(ring: readonly Vec2Px[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return Math.max(maxX - minX, maxY - minY)
}

/** A band's minimum, on the edge of it nearest the field. */
function contourNumber(
  g: CanvasRenderingContext2D,
  band: Band,
  cam: Camera,
  taken: Rect[],
): void {
  const field = cam.worldToScreen({ x: 0, y: 0 })
  let at: Vec2Px | null = null
  let bestDist = Infinity
  for (const p of band.screen) {
    // Only somewhere it can actually be seen. Zoomed in on the foothills
    // the field is off the bottom of the display and so is the seaward edge
    // of every band, and a number placed there is a number nobody reads.
    if (!within(p, cam)) continue
    const d = Math.hypot(p.x - field.x, p.y - field.y)
    if (d < bestDist) {
      bestDist = d
      at = p
    }
  }
  if (at === null) return

  // Nudged onto the terrain side of its own line, so it reads as belonging
  // to the ground above rather than to the ground below.
  const ux = band.uphill.x - at.x
  const uy = band.uphill.y - at.y
  const mag = Math.hypot(ux, uy) || 1
  const text = String(band.zone.minimumSafeFt)
  const x = at.x + (ux / mag) * 11
  const y = at.y + (uy / mag) * 11
  const box = boxOf(text, 8, x, y)
  // Dropped rather than shuffled. A contour figure that has been moved to
  // fit is a figure on the wrong contour, which is worse than no figure.
  if (clashes(box, taken)) return
  taken.push(box)
  g.globalAlpha = 0.75
  g.font = fonts.label(8)
  g.fillText(text, x, y)
}

/** A massif's name, the height that clears it, and its summit. */
function nameMassif(
  g: CanvasRenderingContext2D,
  band: Band,
  cam: Camera,
  taken: Rect[],
): void {
  const spot = labelSpot(band, cam)
  if (spot === null) return

  const name = `${band.zone.label} ${band.zone.minimumSafeFt} MSA`
  const caption = `terrain to ${band.zone.peakFt} ft`
  const at = clearOf(band, spot, name, caption, taken, cam)
  if (at === null) return
  taken.push(boxOf(name, 9, at.x, at.y - 14))
  taken.push(boxOf(caption, 8, at.x, at.y + 14))

  // The chart mark for a summit, and the one symbol here that is not a
  // line: a spot height is a point, not an area.
  g.globalAlpha = 0.85
  g.beginPath()
  g.moveTo(at.x, at.y - 4)
  g.lineTo(at.x + 4, at.y + 3)
  g.lineTo(at.x - 4, at.y + 3)
  g.closePath()
  g.fill()

  g.globalAlpha = 0.95
  g.font = fonts.bold(9)
  g.fillText(name, at.x, at.y - 14)
  g.font = fonts.label(8)
  g.globalAlpha = 0.65
  g.fillText(caption, at.x, at.y + 14)
}

/**
 * The nearest spot to the summit where a name will not land on another.
 *
 * Nudged along the hill rather than anywhere: a name shifted off its own
 * ground is labelling the wrong ground. Where nothing on the hill is free
 * -- two summits within a few dozen pixels of each other, zoomed out -- the
 * lower one goes unnamed, which is the right one to lose.
 */
function clearOf(
  band: Band,
  spot: Vec2Px,
  name: string,
  caption: string,
  taken: readonly Rect[],
  cam: Camera,
): Vec2Px | null {
  for (const dy of [0, -26, 26, -46, 46]) {
    for (const dx of [0, -60, 60]) {
      const at = { x: spot.x + dx, y: spot.y + dy }
      if (!within(at, cam)) continue
      // Both lines of it. Testing only the name let a summit height land
      // squarely on the next hill's name -- the same collision, one line
      // further down, and the one that actually happened.
      if (clashes(boxOf(name, 9, at.x, at.y - 14), taken)) continue
      if (clashes(boxOf(caption, 8, at.x, at.y + 14), taken)) continue
      if (dx === 0 && dy === 0) return at
      if (inShape(band.zone.shape, cam.screenToWorld(at))) return at
    }
  }
  return null
}

/**
 * Where to put a massif's name.
 *
 * Its summit, if the summit is on the glass. If it is not -- zoomed in on
 * the approach with the tops of the hills off the top of the display -- the
 * point is pulled back to the edge, but only as far as ground that is still
 * part of the same band. A name dragged onto open sky would be labelling
 * somewhere the aeroplane can safely be.
 */
function labelSpot(band: Band, cam: Camera): Vec2Px | null {
  const summit = cam.worldToScreen(highPointOf(band.zone))
  if (within(summit, cam)) return summit

  const pulled = {
    x: clamp(summit.x, LABEL_MARGIN_PX, cam.width - LABEL_MARGIN_PX),
    y: clamp(summit.y, LABEL_MARGIN_PX, cam.height - LABEL_MARGIN_PX),
  }
  return inShape(band.zone.shape, cam.screenToWorld(pulled)) ? pulled : null
}

function within(p: Vec2Px, cam: Camera): boolean {
  return (
    p.x > LABEL_MARGIN_PX &&
    p.y > LABEL_MARGIN_PX &&
    p.x < cam.width - LABEL_MARGIN_PX &&
    p.y < cam.height - LABEL_MARGIN_PX
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
