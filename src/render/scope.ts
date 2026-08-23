import type { Camera } from '../core/camera'
import { formatClock, formatElapsed, formatSpeed, type Clock, type Speed } from '../core/loop'
import { advance, type Vec2NM } from '../core/geo'
import {
  centrelinePoint,
  holdRacetrack,
  runwayScaleAt,
  type Airport,
  type AirspaceVolume,
  type GeoPath,
  type GeographyFeature,
  type GeographyKind,
  type HoldPattern,
  type Navaid,
  type NeighbourAirport,
  type Runway,
} from '../data/airport'
import type { Aircraft } from '../sim/types'
import type { TerrainZone, ZoneShape } from '../sim/zones'
import { drawTargets, drawVectorDrag, type VectorDrag } from './layers/targets'
import { drawWeather } from './layers/weather'
import type { Weather } from '../sim/weather'
import { OVERLAY_ITEMS, countEnabled, densityOf, type Overlays } from './overlays'
import { airspaceColour, fonts, formatLevel, theme } from './theme'

/**
 * Draws the static parts of the radar picture: airspace boundaries, range
 * rings, surrounding aerodromes and navaids, the runways being worked, and
 * their extended centrelines.
 *
 * Day 1 splits this into render/layers/* as targets, data blocks and alerts
 * arrive. For now it exists to prove the coordinate converter and the
 * canvas scaler produce correct geometry on screen.
 */

const ORIGIN: Vec2NM = { x: 0, y: 0 }

/**
 * How far the map outside the area of responsibility is washed back towards
 * the ground colour. Enough that the boundary is unmistakable at a glance;
 * not so much that you cannot see a neighbouring field or traffic coming.
 */
const OUTSIDE_VEIL = 0.55

/**
 * The state of the session the display reflects.
 *
 * Started as what the status bar needed and has grown past it: who is on
 * position, whether the airspace rule is in force, what the weather is
 * doing. All of it is session state rather than airport data, which is the
 * line that matters -- the airport comes in as `airport`.
 */
export interface ScopeStatus {
  readonly clock: Clock
  /**
   * The runways arrivals are landing on, per the ATIS -- not the ones the
   * config was loaded with.
   *
   * The config records what the field was set to at load; the ATIS records
   * what it is set to now, and the two differ the moment anybody flips it.
   * Drawing a localiser for a runway nobody is landing on is how a
   * controller ends up vectoring to the wrong one.
   */
  readonly arrivalRunways: readonly Runway[]
  /**
   * Note what is NOT here: the information letter. It is on the ATIS ticker
   * in the toolbar, and this bar drops cells from the right when it runs out
   * of room -- so adding one costs a readout that was already earning its
   * place. The letter would have pushed the airspace provenance off.
   */
  readonly speed: Speed
  readonly paused: boolean
  readonly traffic: {
    readonly spawned: number
    /** Arrivals held back because no fix was clear, or the sector is full. */
    readonly held: number
    /** Landed this session -- the only number here that is a score. */
    readonly landed: number
    /** And lost off the boundary unlanded, which is the other half of it. */
    readonly left: number
    /** The score itself. */
    readonly points: number
  }
  /** Who is working the position, or null before anyone has logged on. */
  readonly controller: { readonly initials: string; readonly position: string } | null
  /**
   * Whether this session enforces the area of responsibility. Off, the map
   * is drawn whole: there is no boundary to be on the wrong side of.
   */
  readonly airspaceEnforced: boolean
  /**
   * The weather. Where the cells have drifted to is worked out from the
   * clock above, so this is the same object all session.
   */
  readonly weather: Weather
}

/** The traffic picture: everything on frequency, and which one is selected. */
export interface ScopeContacts {
  readonly aircraft: readonly Aircraft[]
  /**
   * History dots to draw behind each target.
   *
   * A display setting rather than a physical one: the simulation records
   * the same trail whatever this says, and the difficulty decides how much
   * of it you are allowed to see. Nought leaves the speed vector and
   * nothing else, which is how the hardest setting makes you work out where
   * an aircraft has been rather than reading it off.
   */
  readonly trailDots?: number
  /** Callsign of the target under the controller's hand, if any. */
  readonly selected: string | null
  /** A vector being dragged out with the mouse, while one is in progress. */
  readonly drag?: VectorDrag | null
  /**
   * Callsigns asking for a vector out of the weather. Marked on the block
   * because it is the aircraft that has the problem, and a controller reads
   * the scope before the strips.
   */
  readonly alerts?: ReadonlySet<string>
}

const NO_CONTACTS: ScopeContacts = { aircraft: [], selected: null }

export function drawScope(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
  status: ScopeStatus,
  contacts: ScopeContacts = NO_CONTACTS,
): void {
  g.fillStyle = theme.bg
  g.fillRect(0, 0, cam.width, cam.height)

  // Bottom to top: the map is underneath everything, airspace is a faint
  // wash over it, and the field being worked is the boldest thing on the
  // display.
  for (const feature of airport.geography) {
    if (!geographyShown(feature.kind, overlays)) continue
    drawGeography(g, cam, feature)
  }

  // Over the map and under everything else, the way a real scope underlays
  // it: weather you cannot see the traffic through has taken the display
  // away from you.
  if (overlays.weather) {
    drawWeather(g, cam, status.weather, status.clock.elapsedSeconds)
  }

  const volumes = airport.airspace.filter((v) =>
    v.airspaceClass === 'G' ? overlays.trafficZones : overlays.airspace,
  )
  for (const volume of volumes) {
    drawAirspaceBoundary(g, cam, volume)
  }
  if (overlays.airspaceLabels) drawAirspaceLabels(g, cam, volumes)

  if (overlays.rangeRings) drawRangeRings(g, cam, airport)

  if (overlays.aerodromes) {
    for (const neighbour of airport.airports) {
      drawNeighbour(g, cam, airport, neighbour)
    }
  }
  // Racetracks first, so the fix symbols sit on top of their own pattern.
  for (const fix of airport.holdingFixes) {
    if (holdShown(cam, airport, fix, overlays)) drawHoldPattern(g, cam, airport, fix)
  }
  for (const navaid of airport.navaids) {
    // Holds are operational rather than contextual, so they stay whatever
    // the overlay settings say.
    if (navaid.hold === null && !overlays.navaids) continue
    // The stub stands in for the racetrack when the racetrack is not drawn,
    // so the inbound direction is always readable somehow.
    drawNavaid(
      g,
      cam,
      navaid,
      overlays.navaidFreqs,
      !holdShown(cam, airport, navaid, overlays),
    )
  }
  if (overlays.centrelines) {
    for (const rwy of status.arrivalRunways) {
      drawExtendedCentreline(g, cam, rwy)
    }
  }
  for (const rwy of airport.runways) {
    drawRunway(g, cam, airport, rwy)
  }

  // Everything the controller does not own, dimmed -- drawn after the whole
  // map so that all of it is covered, and before the traffic so that none of
  // the traffic is. Nothing to dim in a session without a boundary.
  if (status.airspaceEnforced) drawOutside(g, cam, airport)

  // The edge of the area of responsibility is not optional: it is the
  // boundary of the job, not decoration. Drawn over the wash so that the
  // one line that matters most is also the crispest on the display.
  drawSectorBoundary(g, cam, airport)
  drawCardinals(g, cam, airport)

  // Above every overlay and below the chrome: traffic is the top layer of
  // the radar picture, but it is still inside the display.
  drawZones(g, cam, airport, overlays)
  drawTargets(
    g,
    cam,
    contacts.aircraft,
    contacts.selected,
    contacts.alerts,
    contacts.trailDots,
  )
  // Above the traffic: the line being dragged is the thing the controller
  // is looking at, and it has to be readable over a target it crosses.
  if (contacts.drag) drawVectorDrag(g, cam, contacts.drag)

  drawHud(g, cam, airport, overlays, status)
  drawScreenFrame(g, cam)
}

/**
 * A two-pixel sunken edge around the whole scope, so the display reads as
 * a viewport recessed into an application window rather than as a picture
 * that happens to fill the browser.
 */
function drawScreenFrame(g: CanvasRenderingContext2D, cam: Camera): void {
  const w = cam.width
  const h = cam.height

  if (theme.chromeStyle === 'flat') {
    // One hairline all the way round. A modern display is a rectangle of
    // glass in a bezel, not a window recessed into a desktop.
    g.fillStyle = theme.chromeLight
    g.fillRect(0, 0, w, 1)
    g.fillRect(0, h - 1, w, 1)
    g.fillRect(0, 0, 1, h)
    g.fillRect(w - 1, 0, 1, h)
    return
  }

  g.fillStyle = theme.chromeShadow
  g.fillRect(0, 0, w, 2)
  g.fillRect(0, 0, 2, h)
  g.fillStyle = theme.chromeLight
  g.fillRect(0, h - 2, w, 2)
  g.fillRect(w - 2, 0, 2, h)
}

/* ------------------------------------------------------------ geography */

/**
 * Which switch governs which feature.
 *
 * A switch over the union with no default, so adding a kind of map feature
 * is a compile error here rather than a layer that quietly cannot be turned
 * off.
 */
function geographyShown(kind: GeographyKind, overlays: Overlays): boolean {
  switch (kind) {
    case 'coastline':
      return overlays.coastline
    case 'river':
      return overlays.rivers
    case 'fir':
      return overlays.firBoundary
  }
}

/**
 * The coastline, the Thames and the FIR limit.
 *
 * All are stroked as open polylines and never closed -- the same rule the
 * airspace line work follows, and for the coastline it is not optional:
 * joining the ends of a clipped shoreline would draw a line straight across
 * the sea.
 *
 * Water is water: the river takes the coastline's colour and weight rather
 * than one of its own, because that is what it is, and giving it a third
 * colour would imply a distinction that does not exist. The FIR limit is a
 * different kind of thing and is drawn heavier.
 *
 * The kinds are told apart by colour and weight rather than by dash pattern,
 * because in this codebase dashes mean provenance (see `dashFor`) and all of
 * these come from an authoritative source. Reusing the dash vocabulary to
 * mean "different kind of thing" would break that.
 */
function drawGeography(
  g: CanvasRenderingContext2D,
  cam: Camera,
  feature: GeographyFeature,
): void {
  const isFir = feature.kind === 'fir'

  // Half-extents of the viewport in NM, grown by a margin so a path that
  // starts just off-screen still draws the segment that enters it.
  const halfW = cam.width / 2 / cam.pxPerNM + 1
  const halfH = cam.height / 2 / cam.pxPerNM + 1
  const c = cam.centre

  g.save()
  g.strokeStyle = isFir ? theme.fir : theme.coast
  g.lineWidth = isFir ? 1.6 : 1
  g.setLineDash([])
  g.lineJoin = 'round'

  for (const path of feature.paths) {
    // Two comparisons reject a whole path, which is most of them at any
    // useful zoom. Without this the coastline would project a few thousand
    // points per frame to draw nothing.
    if (path.minNM.x > c.x + halfW || path.maxNM.x < c.x - halfW) continue
    if (path.minNM.y > c.y + halfH || path.maxNM.y < c.y - halfH) continue

    if (path.widthsNM) {
      drawToWidth(g, cam, path)
      continue
    }

    g.beginPath()
    path.pointsNM.forEach((v, i) => {
      const p = cam.worldToScreen(v)
      if (i === 0) g.moveTo(p.x, p.y)
      else g.lineTo(p.x, p.y)
    })
    g.stroke()
  }

  g.restore()
}

/** Never thinner than this, or the upper river vanishes when zoomed out. */
const MIN_WATER_PX = 1

/**
 * Strokes a path at its real width, in pixels, so the Thames is a thread at
 * Windsor and visibly a mile across off Canvey.
 *
 * Consecutive segments of the same drawn width are batched into one stroke:
 * the width profile is smooth, so quantising to the half pixel turns 150
 * segments into a handful of runs. Round caps and joins hide the step where
 * one run meets the next.
 */
function drawToWidth(g: CanvasRenderingContext2D, cam: Camera, path: GeoPath): void {
  const widths = path.widthsNM
  if (!widths) return
  const pts = path.pointsNM
  const scale = cam.pxPerNM

  const widthAt = (i: number): number => {
    const a = widths[i] ?? 0
    const b = widths[i + 1] ?? a
    const px = ((a + b) / 2) * scale
    // Quantised to the half pixel, purely so neighbouring segments batch.
    return Math.max(MIN_WATER_PX, Math.round(px * 2) / 2)
  }

  g.lineCap = 'round'
  g.lineJoin = 'round'

  let i = 0
  while (i < pts.length - 1) {
    const w = widthAt(i)
    let j = i + 1
    while (j < pts.length - 1 && widthAt(j) === w) j += 1

    g.lineWidth = w
    g.beginPath()
    for (let k = i; k <= j; k += 1) {
      const v = pts[k]
      if (!v) continue
      const p = cam.worldToScreen(v)
      if (k === i) g.moveTo(p.x, p.y)
      else g.lineTo(p.x, p.y)
    }
    g.stroke()
    i = j
  }
}

/* ------------------------------------------------------------- airspace */

/**
 * Line style carries provenance, so the display never implies more
 * precision than the data has: solid straight from the published source,
 * dotted computed from a rule, dashed a stand-in.
 */
function dashFor(derivation: string): number[] {
  if (derivation === 'aip') return []
  if (derivation === 'rule') return [1, 3]
  return [4, 4]
}

function drawAirspaceBoundary(
  g: CanvasRenderingContext2D,
  cam: Camera,
  volume: AirspaceVolume,
): void {
  g.save()
  g.strokeStyle = airspaceColour(volume.airspaceClass)
  g.lineWidth = volume.airspaceClass === 'G' ? 1 : 1.3
  g.setLineDash(dashFor(volume.derivation))
  g.globalAlpha = volume.airspaceClass === 'G' ? 0.5 : 0.75

  const shape = volume.shape
  if (shape.kind === 'circle') {
    const c = cam.worldToScreen(shape.centreNM)
    const r = cam.nmToPx(shape.radiusNM)
    if (r >= 3) {
      g.beginPath()
      g.arc(c.x, c.y, r, 0, Math.PI * 2)
      g.stroke()
    }
  } else if (shape.kind === 'polygon') {
    g.beginPath()
    shape.verticesNM.forEach((v, i) => {
      const p = cam.worldToScreen(v)
      if (i === 0) g.moveTo(p.x, p.y)
      else g.lineTo(p.x, p.y)
    })
    g.closePath()
    g.stroke()
  } else {
    // Open polylines: never closed, or the display would invent edges the
    // source does not contain.
    for (const line of shape.pathsNM) {
      g.beginPath()
      line.forEach((v, i) => {
        const p = cam.worldToScreen(v)
        if (i === 0) g.moveTo(p.x, p.y)
        else g.lineTo(p.x, p.y)
      })
      g.stroke()
    }
  }

  g.restore()
}

interface AirspaceLabel {
  key: string
  at: Vec2NM
  text: string
  limits: string
  colour: string
  assumed: boolean
  /**
   * Width of the volume in nautical miles. Deliberately not in pixels:
   * every input to a label's position has to be independent of the camera,
   * or the position moves when the scope is zoomed.
   */
  widthNM: number
  /**
   * Claim on the space, lowest first. Ranked by usefulness rather than
   * size, or the enormous upper-area bands would squeeze out every control
   * zone around them.
   */
  tier: number
  /** Base of the volume, so the lowest band of an airspace is named first. */
  floorFt: number
}

/**
 * One label per name and altitude band, placed at the centre of the
 * volume's boundary.
 *
 * The centre rather than the northernmost point, for two reasons. It is
 * where a chart puts a name, inside the thing being named; and a northern
 * extremity is frequently off the top of the screen while the airspace
 * itself is in plain view -- Luton's CTR sat seven pixels above the edge at
 * the default range, so its label vanished for want of an anchor rather
 * than for want of room.
 */
function airspaceLabel(volume: AirspaceVolume): AirspaceLabel | null {
  const shape = volume.shape
  let at: Vec2NM | null = null
  let widthNM = 0

  if (shape.kind === 'circle') {
    at = shape.centreNM
    widthNM = shape.radiusNM * 2
  } else {
    const all: readonly Vec2NM[] =
      shape.kind === 'polygon' ? shape.verticesNM : shape.pathsNM.flat()
    if (all.length === 0) return null

    let sumX = 0
    let sumY = 0
    let minX = Infinity
    let maxX = -Infinity
    for (const v of all) {
      sumX += v.x
      sumY += v.y
      if (v.x < minX) minX = v.x
      if (v.x > maxX) maxX = v.x
    }
    at = { x: sumX / all.length, y: sumY / all.length }
    widthNM = maxX - minX
  }

  if (!at) return null

  const limits = `${formatLevel(volume.floorFt)}-${formatLevel(volume.ceilingFt)}`

  // Surface-based zones name a specific field and are what you are working
  // next to, so they get first claim. Upper-area bands go last: they are
  // the biggest thing on the scope and there are a great many of them.
  const tier = volume.floorFt === 0 ? 0 : volume.airspaceClass === 'A' ? 2 : 1

  return {
    key: `${volume.label}|${limits}`,
    at,
    text: volume.label,
    limits,
    colour: airspaceColour(volume.airspaceClass),
    assumed: volume.verticalSource === 'assumed',
    widthNM,
    tier,
    floorFt: volume.floorFt,
  }
}

interface LabelBox {
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: LabelBox, b: LabelBox, pad = 2): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  )
}

/**
 * Places airspace labels, largest volume first, and drops any that would
 * collide with one already placed.
 *
 * Deduplicating by name and band is not enough on its own: adjacent bands
 * of the same airspace are built from the same boundary lines, so they
 * share vertices and their labels land on the identical pixel. Stansted had
 * two volumes with the same northernmost point and different limits, which
 * drew one label directly on top of the other. The London TMA has nine
 * distinct bands and Farnborough nine, so the problem is structural rather
 * than one bad record.
 *
 * Dropping a colliding label loses information, which is the right trade:
 * two labels in the same place convey nothing at all.
 */
function drawAirspaceLabels(
  g: CanvasRenderingContext2D,
  cam: Camera,
  volumes: readonly AirspaceVolume[],
): void {
  // Built from every volume, with no reference to the camera. An earlier
  // version discarded volumes too small to label BEFORE assigning them
  // positions, which made a name's group -- and so the slot each band sat
  // in -- depend on the zoom level. Labels then moved as the scope was
  // zoomed, which is the fault this ordering exists to prevent. Size is now
  // considered only when deciding whether to draw, further down.
  const unique = new Map<string, AirspaceLabel>()
  for (const v of volumes) {
    const l = airspaceLabel(v)
    if (!l) continue
    const existing = unique.get(l.key)
    // Keep the largest instance of a repeated band, so the label lands on
    // the most prominent piece of that airspace.
    if (!existing || l.widthNM > existing.widthNM) unique.set(l.key, l)
  }

  const size = 9
  const lineH = 11
  const h = lineH * 2 + 6
  const all = [...unique.values()]

  /**
   * Each label gets ONE possible screen position, fixed relative to its own
   * anchor: the offset comes from where its band sits in its airspace, not
   * from what it happens to collide with.
   *
   * That distinction is the whole point. Choosing an offset by trying
   * alternatives until one is free makes the choice depend on the zoom
   * level, so a label jumps between positions as the scope is zoomed --
   * which is what Farnborough's CTA was doing across its nine bands.
   * Deriving the offset from the data instead means the position is a pure
   * function of the airspace and the camera, so a label can appear or
   * disappear but can never move.
   */
  const slotOf = new Map<string, number>()
  const byName = new Map<string, AirspaceLabel[]>()
  for (const l of all) {
    const group = byName.get(l.text) ?? []
    group.push(l)
    byName.set(l.text, group)
  }
  for (const group of byName.values()) {
    group.sort((a, b) => a.floorFt - b.floorFt || a.limits.localeCompare(b.limits))
    group.forEach((l, i) => slotOf.set(l.key, i))
  }

  /**
   * Which bands of an airspace are eligible is decided here, from the data,
   * and not by which ones happen to survive collision testing.
   *
   * That matters for stability. If the limit were a count of labels
   * actually drawn, a band dropped for want of room would let a completely
   * different band take its place -- and since what collides changes with
   * the zoom level, the label would appear somewhere else as the scope was
   * zoomed. Farnborough has nine bands and was doing exactly that. Fixing
   * the eligible set means a band can appear or disappear, but nothing ever
   * moves.
   *
   * The TMA alone has nine bands too. Naming the same airspace more than
   * twice tells you nothing further and crowds out zones not yet named.
   */
  const MAX_PER_NAME = 2
  const eligible = all.filter((l) => (slotOf.get(l.key) ?? 0) < MAX_PER_NAME)

  /**
   * The lowest band sits on the centre point and further bands stack
   * downwards from it. A constant per volume, so the offset never varies
   * with the camera.
   */
  const slotOffset = (slot: number): number => slot * h

  // Within a tier the lowest base wins: of the TMA's nine bands the one
  // with the lowest floor is the one that matters, since it is the first
  // thing an aircraft would climb into.
  const candidates = eligible.sort(
    (a, b) => a.tier - b.tier || a.floorFt - b.floorFt || b.widthNM - a.widthNM,
  )
  const placed: LabelBox[] = []

  g.font = fonts.label(size)
  g.textAlign = 'center'

  for (const l of candidates) {
    // Too small on screen to carry text. This is the one camera-dependent
    // decision, and it only ever hides a label -- it cannot move one.
    if (cam.nmToPx(l.widthNM) < 40) continue

    const anchor = cam.worldToScreen(l.at)
    const limits = l.assumed ? `(${l.limits})` : l.limits
    const w = charW(size) * Math.max(l.text.length, limits.length) + 8

    const dy = slotOffset(slotOf.get(l.key) ?? 0)
    const at = { x: anchor.x, y: anchor.y + dy }
    const box: LabelBox = { x: at.x - w / 2, y: at.y - lineH - 4, w, h }

    // Must fit entirely on screen, and is never moved to make it fit.
    // Clamping a label into the viewport makes it slide along the edge as
    // the scope is panned, so it appears to follow the view rather than
    // stay with its airspace. Dropping it is the honest behaviour: the
    // label belongs to a place, and that place is off screen.
    if (box.x < 0 || box.x + w > cam.width) continue
    if (box.y < 0 || box.y + h > cam.height) continue
    if (placed.some((q) => overlaps(box, q))) continue

    placed.push(box)

    g.fillStyle = theme.airspaceLabel
    g.textBaseline = 'bottom'
    g.fillText(l.text, at.x, at.y - 3)
    g.fillStyle = l.colour
    g.textBaseline = 'top'
    // Parentheses mark limits the source did not state.
    g.fillText(limits, at.x, at.y + 2)
  }
}

/* ---------------------------------------------------------------- rings */

function drawRangeRings(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  const c = cam.worldToScreen(ORIGIN)
  g.lineWidth = 1

  for (const nm of airport.sector.rangeRingsNM) {
    const r = cam.nmToPx(nm)
    if (r < 8) continue

    g.strokeStyle = theme.ring
    g.beginPath()
    g.arc(c.x, c.y, r, 0, Math.PI * 2)
    g.stroke()

    g.fillStyle = theme.ringLabel
    g.font = fonts.label(10)
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillText(`${nm}`, c.x + r + 4, c.y)
  }
}

/**
 * Dims the map outside the area of responsibility.
 *
 * The map does not stop at the boundary -- there is a country out there,
 * and the airspace of four other airfields -- but only one part of it is
 * the controller's. Washing the rest back towards the ground colour says
 * which is which without hiding anything: a neighbouring field is still
 * there to be seen, and so is traffic on its way in.
 */
function drawOutside(g: CanvasRenderingContext2D, cam: Camera, airport: Airport): void {
  g.globalAlpha = OUTSIDE_VEIL
  g.fillStyle = theme.bg
  g.beginPath()
  // The whole display with the airspace punched out of it: one path, filled
  // odd-even, which needs no clipping and no second pass.
  g.rect(0, 0, cam.width, cam.height)
  for (const ring of airport.controlFootprint) tracePath(g, cam, ring)
  g.fill('evenodd')
  // Set back rather than saved and restored: everything after this is drawn
  // at full strength, and a leaked alpha would dim the traffic too.
  g.globalAlpha = 1
}

/** One closed ring, in screen space. */
function tracePath(
  g: CanvasRenderingContext2D,
  cam: Camera,
  ring: readonly Vec2NM[],
): void {
  for (let i = 0; i < ring.length; i += 1) {
    const p = cam.worldToScreen(ring[i] as Vec2NM)
    if (i === 0) g.moveTo(p.x, p.y)
    else g.lineTo(p.x, p.y)
  }
  g.closePath()
}

/**
 * The edge of the area of responsibility: the published outline of the
 * airspace, not a circle around the field.
 */
function drawSectorBoundary(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  g.lineWidth = 1.4
  g.strokeStyle = theme.sector
  for (const ring of airport.controlFootprint) {
    g.beginPath()
    tracePath(g, cam, ring)
    g.stroke()
  }
}

function drawCardinals(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  const outerNM = airport.sector.radiusNM
  g.strokeStyle = theme.cardinal
  g.lineWidth = 1
  g.fillStyle = theme.ringLabel
  g.font = fonts.label(10)
  g.textAlign = 'center'
  g.textBaseline = 'middle'

  for (let brg = 0; brg < 360; brg += 30) {
    const inner = cam.worldToScreen(advance(ORIGIN, brg, outerNM * 0.97))
    const outer = cam.worldToScreen(advance(ORIGIN, brg, outerNM))
    g.beginPath()
    g.moveTo(inner.x, inner.y)
    g.lineTo(outer.x, outer.y)
    g.stroke()

    if (brg % 90 === 0) {
      const at = cam.worldToScreen(advance(ORIGIN, brg, outerNM * 0.92))
      g.fillText(String(brg / 10).padStart(2, '0'), at.x, at.y)
    }
  }
}

/* ----------------------------------------------------- other aerodromes */

function drawNeighbour(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  n: NeighbourAirport,
): void {
  const p = cam.worldToScreen(n.posNM)

  g.strokeStyle = theme.neighbour
  g.lineWidth = 1.2

  if (n.primaryRunway) {
    // Draw the strip on its real bearing, but never shorter than a few
    // pixels -- a 900 m grass strip is a third of a pixel at 40 NM range.
    const truePx = cam.nmToPx(n.primaryRunway.lengthNM)
    const halfPx = Math.max(airport.render.neighbourRunwayMinPx, truePx) / 2
    const halfNM = cam.pxToNM(halfPx)
    const a = cam.worldToScreen(advance(n.posNM, n.primaryRunway.bearingTrue, halfNM))
    const b = cam.worldToScreen(advance(n.posNM, n.primaryRunway.bearingTrue + 180, halfNM))

    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
  } else {
    g.beginPath()
    g.arc(p.x, p.y, 3, 0, Math.PI * 2)
    g.stroke()
  }

  // Label the majors early and the small fields only once zoomed in, so
  // the picture does not turn into a wall of four-letter codes.
  const major = n.kind === 'large' || n.kind === 'medium'
  const threshold = major ? 4 : 14
  if (cam.pxPerNM < threshold) return

  g.fillStyle = theme.neighbourLabel
  g.font = fonts.label(major ? 10 : 9)
  g.textAlign = 'center'
  g.textBaseline = 'top'
  g.fillText(n.icao, p.x, p.y + 6)
}

/* -------------------------------------------------------------- navaids */

/**
 * Whether the full racetrack is worth drawing at this zoom.
 *
 * A one-minute leg at 220 kt is 3.7 NM, which is sixteen pixels at the
 * default range and a smudge well before the zoom ceiling. Below the
 * threshold the stub reads better than a squashed oval.
 */
const HOLD_MIN_LEG_PX = 16

function holdShown(
  cam: Camera,
  airport: Airport,
  n: Navaid,
  overlays: Overlays,
): boolean {
  if (!overlays.holdPatterns || n.hold === null) return false
  return cam.nmToPx(holdLegNM(airport, n.hold)) >= HOLD_MIN_LEG_PX
}

const holdLegNM = (airport: Airport, hold: HoldPattern): number =>
  (airport.render.holdSpeedKts * hold.legMins) / 60

/**
 * The racetrack at a holding fix.
 *
 * The ring is closed here rather than in the geometry, and the inbound leg
 * is then re-stroked heavier: with two parallel legs a mile apart, which one
 * is flown towards the fix is the only thing that says which way round the
 * pattern goes, and the fix symbol alone does not say it.
 */
function drawHoldPattern(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  n: Navaid,
): void {
  const hold = n.hold
  if (hold === null) return

  const ring = holdRacetrack(n.posNM, hold, {
    speedKts: airport.render.holdSpeedKts,
  })

  g.save()
  g.strokeStyle = theme.hold
  g.setLineDash([])
  g.lineJoin = 'round'
  g.lineWidth = 1.1

  g.beginPath()
  ring.forEach((v, i) => {
    const p = cam.worldToScreen(v)
    if (i === 0) g.moveTo(p.x, p.y)
    else g.lineTo(p.x, p.y)
  })
  g.closePath()
  g.stroke()

  const from = cam.worldToScreen(
    advance(n.posNM, hold.inboundTrue + 180, holdLegNM(airport, hold)),
  )
  const at = cam.worldToScreen(n.posNM)
  g.lineWidth = 2.4
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(from.x, from.y)
  g.lineTo(at.x, at.y)
  g.stroke()

  g.restore()
}

function drawNavaid(
  g: CanvasRenderingContext2D,
  cam: Camera,
  n: Navaid,
  showFreq: boolean,
  showStub: boolean,
): void {
  const p = cam.worldToScreen(n.posNM)
  const r = 6

  // Holding fixes get a stub along the inbound leg, which is the low-clutter
  // stand-in for the full racetrack: enough to read the inbound direction
  // from, and a couple of miles of line work cheaper.
  if (n.hold && showStub) {
    const tail = cam.worldToScreen(advance(n.posNM, n.hold.inboundTrue + 180, 2.5))
    g.strokeStyle = theme.hold
    g.lineWidth = 3
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(p.x, p.y)
    g.lineTo(tail.x, tail.y)
    g.stroke()
  }

  // Charted VOR symbol: a hexagon with a centre dot.
  g.strokeStyle = theme.navaid
  g.lineWidth = 1.3
  g.beginPath()
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i - Math.PI / 2
    const x = p.x + r * Math.cos(a)
    const y = p.y + r * Math.sin(a)
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.stroke()

  g.fillStyle = theme.navaid
  g.beginPath()
  g.arc(p.x, p.y, 1.4, 0, Math.PI * 2)
  g.fill()

  g.font = fonts.label(11)
  g.textAlign = 'left'
  g.textBaseline = 'bottom'
  g.fillStyle = n.hold ? theme.hold : theme.navaidLabel
  g.fillText(n.name, p.x + r + 4, p.y - 1)

  // Frequency only once there is room for it.
  if (showFreq && n.station && cam.pxPerNM > 12) {
    g.fillStyle = theme.navaidFreq
    g.font = fonts.label(9)
    g.textBaseline = 'top'
    g.fillText(n.station.freqMHz.toFixed(2), p.x + r + 4, p.y + 1)
  }
}

/* -------------------------------------------------- the field being worked */

function drawRunway(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  rwy: Runway,
): void {
  // Display magnification, applied from the threshold so that the
  // threshold -- and therefore the centreline, the FAF and every approach
  // calculation -- stays exactly where it really is.
  const scale = runwayScaleAt(airport.render, cam.pxPerNM)
  const painted = advance(rwy.thresholdNM, rwy.bearingTrue, rwy.lengthNM * scale)

  const a = cam.worldToScreen(rwy.thresholdNM)
  const b = cam.worldToScreen(painted)

  g.strokeStyle = theme.runway
  g.lineWidth = Math.max(2.5, cam.nmToPx(0.05 * scale))
  g.lineCap = 'butt'
  g.beginPath()
  g.moveTo(a.x, a.y)
  g.lineTo(b.x, b.y)
  g.stroke()

  if (cam.pxPerNM < 6) return

  g.fillStyle = theme.runwayLabel
  g.font = fonts.bold(10)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  // Offset perpendicular to the strip so the label clears the surface.
  const off = cam.worldToScreen(advance(rwy.thresholdNM, rwy.bearingTrue + 90, 0.4))
  g.fillText(rwy.id, off.x, off.y)
}

function drawExtendedCentreline(
  g: CanvasRenderingContext2D,
  cam: Camera,
  rwy: Runway,
): void {
  const faf = rwy.ils.fafDistNM
  const outNM = Math.max(faf + 5, 16)

  const thr = cam.worldToScreen(rwy.thresholdNM)
  const end = cam.worldToScreen(centrelinePoint(rwy, outNM))

  g.save()
  g.strokeStyle = theme.centreline
  g.lineWidth = 1
  g.setLineDash([6, 5])
  g.beginPath()
  g.moveTo(thr.x, thr.y)
  g.lineTo(end.x, end.y)
  g.stroke()
  g.restore()

  if (cam.pxPerNM < 5) return

  for (let d = 1; d <= outNM; d += 1) {
    const isFaf = d === faf
    const half = isFaf ? 0.55 : 0.28
    const on = centrelinePoint(rwy, d)
    const p1 = cam.worldToScreen(advance(on, rwy.bearingTrue + 90, half))
    const p2 = cam.worldToScreen(advance(on, rwy.bearingTrue - 90, half))

    g.strokeStyle = isFaf ? theme.fafTick : theme.centrelineTick
    g.lineWidth = isFaf ? 1.5 : 1
    g.beginPath()
    g.moveTo(p1.x, p1.y)
    g.lineTo(p2.x, p2.y)
    g.stroke()

    if (isFaf && cam.pxPerNM > 9) {
      g.fillStyle = theme.fafTick
      g.font = fonts.label(9)
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(`FAF ${rwy.id}`, p1.x, p1.y - 3)
    }
  }
}

/* ------------------------------------------------------------------- hud */

/**
 * Monospace advance width. Measured arithmetically rather than through
 * measureText so layout is deterministic and testable without a real
 * canvas -- the font is fixed-pitch, so this is exact enough to lay out
 * panels against.
 */
const charW = (px: number): number => px * 0.6

/**
 * A panel face, drawn in whichever idiom the active scheme declares.
 *
 * Under `bevel` it is the turn-of-the-century control: a one-pixel light
 * edge along the top and left, a shadow edge along the bottom and right,
 * the two swapped to read as sunken.
 *
 * Under `flat` it is a fill and a single hairline border, which is what
 * every screen in a modern control room does -- there is no raised and no
 * sunken, only a panel and a well, told apart by how dark the fill is.
 * Drawing a bevel there would be the one detail that gave the whole thing
 * away.
 */
function bevel(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  sunken = false,
): void {
  g.fillStyle = sunken ? theme.chromeWell : theme.chromeFace
  g.fillRect(x, y, w, h)

  if (theme.chromeStyle === 'flat') {
    g.fillStyle = theme.chromeLight
    g.fillRect(x, y, w, 1)
    g.fillRect(x, y + h - 1, w, 1)
    g.fillRect(x, y, 1, h)
    g.fillRect(x + w - 1, y, 1, h)
    return
  }

  const topLeft = sunken ? theme.chromeShadow : theme.chromeLight
  const bottomRight = sunken ? theme.chromeLight : theme.chromeShadow

  g.fillStyle = topLeft
  g.fillRect(x, y, w, 1)
  g.fillRect(x, y, 1, h)
  g.fillStyle = bottomRight
  g.fillRect(x, y + h - 1, w, 1)
  g.fillRect(x + w - 1, y, 1, h)
}

interface Cell {
  readonly label: string
  readonly value: string
}

/** A rectangle on the display, in canvas pixels. */
export interface ReadoutBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Where each readout column was last drawn.
 *
 * The readouts are painted on the canvas, so there is no element to measure
 * and nothing outside this file knows how wide RATE came out this frame --
 * the width depends on the value, which changes. Anything that needs to
 * point at one, and the tutorial's spotlight does, has to be told.
 *
 * Recorded on the way past rather than computed a second time somewhere
 * else: a copy of the layout maths would be a copy to keep in step, and the
 * one thing worse than a spotlight in the wrong place is one that is right
 * until somebody changes a padding.
 */
const readoutAt = new Map<string, ReadoutBox>()

/** The rectangle a named readout occupies, or null if it is not drawn. */
export function readoutBox(label: string): ReadoutBox | null {
  return readoutAt.get(label) ?? null
}

/**
 * High ground and noise abatement areas.
 *
 * Under the traffic and over the map: they are constraints on where you may
 * put an aeroplane, so they have to be visible while you are deciding, and
 * they must never be the brightest thing on the glass. Terrain is drawn in
 * the warning colour because flying into it is the worst thing that can
 * happen; a noise zone is drawn in the furniture colour because breaking it
 * costs money.
 */
function drawZones(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
): void {
  const terrain = overlays.terrain ? airport.terrain : []
  const noise = overlays.noiseZones ? airport.noise : []
  if (terrain.length === 0 && noise.length === 0) return

  g.save()
  g.lineWidth = 1

  for (const zone of terrain) {
    // Filled, faintly, as well as outlined. An outline alone reads as one
    // more boundary on a display that already has a dozen of them, and the
    // thing that matters about terrain is which SIDE of the line you are
    // on. A wash says "this area", where a line only says "this edge".
    traceZone(g, cam, zone.shape)
    g.globalAlpha = 0.08
    g.fillStyle = theme.warn
    g.fill()

    // A second, denser pass along the boundary itself: high ground has an
    // edge you can be a mile the wrong side of, and it should be the
    // sharpest part of the shading.
    g.globalAlpha = 0.55
    g.strokeStyle = theme.warn
    g.stroke()

    g.globalAlpha = 0.9
    // The minimum, not the summit: the number a controller uses. Both,
    // where there is room, because the summit is what makes the minimum
    // believable.
    labelTerrain(g, cam, zone)
  }

  for (const zone of noise) {
    g.strokeStyle = theme.ringStrong
    g.globalAlpha = 0.05
    g.fillStyle = theme.ringStrong
    traceZone(g, cam, zone.shape)
    g.fill()
    g.globalAlpha = 0.55
    g.setLineDash([5, 4])
    g.stroke()
    g.setLineDash([])
    g.globalAlpha = 0.8
    labelZone(g, cam, zone.shape, `${zone.label} ${zone.floorFt}+`, theme.ringLabel)
  }

  g.restore()
}

/**
 * A terrain area's name, its minimum and its summit.
 *
 * Two lines rather than one: the minimum is the number that gets used and
 * the summit is what explains it, and a controller reading "11500 MSA" over
 * a blank shape has to take it on trust.
 */
function labelTerrain(g: CanvasRenderingContext2D, cam: Camera, zone: TerrainZone): void {
  const at = centreOf(zone.shape)
  const p = cam.worldToScreen(at)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = theme.warn
  g.font = fonts.bold(9)
  g.fillText(`${zone.label} ${zone.minimumSafeFt} MSA`, p.x, p.y - 6)
  g.font = fonts.label(8)
  g.globalAlpha = 0.65
  g.fillText(`terrain to ${zone.peakFt} ft`, p.x, p.y + 6)
}

/** The outline of a zone, whichever shape it is. */
function traceZone(g: CanvasRenderingContext2D, cam: Camera, shape: ZoneShape): void {
  g.beginPath()
  if (shape.kind === 'circle') {
    const centre = cam.worldToScreen(shape.centreNM)
    g.arc(centre.x, centre.y, shape.radiusNM * cam.pxPerNM, 0, Math.PI * 2)
    return
  }
  shape.verticesNM.forEach((v, i) => {
    const p = cam.worldToScreen(v)
    if (i === 0) g.moveTo(p.x, p.y)
    else g.lineTo(p.x, p.y)
  })
  g.closePath()
}

/** The middle of a zone, for putting a name in. */
function centreOf(shape: ZoneShape): { readonly x: number; readonly y: number } {
  if (shape.kind === 'circle') return shape.centreNM
  return {
    x: shape.verticesNM.reduce((sum, v) => sum + v.x, 0) / shape.verticesNM.length,
    y: shape.verticesNM.reduce((sum, v) => sum + v.y, 0) / shape.verticesNM.length,
  }
}

/** A name in the middle of a zone, so it can be told from a range ring. */
function labelZone(
  g: CanvasRenderingContext2D,
  cam: Camera,
  shape: ZoneShape,
  text: string,
  colour: string,
): void {
  const p = cam.worldToScreen(centreOf(shape))
  g.font = fonts.label(9)
  g.fillStyle = colour
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, p.x, p.y)
}

function drawHud(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
  status: ScopeStatus,
): void {
  // Cleared each frame: the readouts are re-laid out every time, and a
  // column that no longer fits should report no position rather than the
  // one it had when it did.
  readoutAt.clear()
  if (theme.chromeStyle === 'flat') {
    drawPositionStrip(g, airport, status)
    // Started where the position block ends and stopped where the clock
    // begins, so the three share the top edge without overlapping.
    drawDataTable(
      g,
      statusCells(cam, airport, overlays, status),
      positionStripWidth(airport, status) + 2,
      cam.width - 1 - clockWidth(),
    )
    drawClock(g, cam, status)
    return
  }
  drawTitleBlock(g, airport, status)
  drawClock(g, cam, status)
  drawStatusBar(g, cam, airport, overlays, status)
}

/* ----------------------------------------------------- the flat idiom

   A modern position does not float bevelled panels over the picture with a
   margin round them. Its furniture is flush to the edges of the glass, in
   as little height as the type will allow, and its readouts are a ruled
   table with a header row -- which is the single most recognisable thing
   about the photographs this is modelled on.                            */

/**
 * Who is working, top left, hard against the frame.
 *
 * Two lines and no margin. The period version is a raised panel inset ten
 * pixels from the corner; this is flush, because a modern display gives its
 * whole area to the picture and lets the furniture sit on the edge of it.
 */
/**
 * How wide the position block is.
 *
 * Wanted in two places now that the readouts share the top edge with it:
 * the block draws itself this wide, and the table starts where it ends.
 * Measured rather than fixed, because the width comes from the text.
 */
function positionStripWidth(airport: Airport, status: ScopeStatus): number {
  const title = `${airport.icao} APPROACH`
  const under = status.controller
    ? `${status.controller.position}  ${status.controller.initials}`
    : airport.name.toUpperCase()
  return (
    Math.ceil(Math.max(charW(11) * title.length, charW(9) * under.length)) + 16
  )
}

function drawPositionStrip(
  g: CanvasRenderingContext2D,
  airport: Airport,
  status: ScopeStatus,
): void {
  const title = `${airport.icao} APPROACH`
  const under = status.controller
    ? `${status.controller.position}  ${status.controller.initials}`
    : airport.name.toUpperCase()

  const titleSize = 11
  const underSize = 9
  const w = positionStripWidth(airport, status)
  const h = 28

  g.fillStyle = theme.chromeFace
  g.fillRect(1, 1, w, h)
  g.fillStyle = theme.chromeLight
  g.fillRect(1, 1 + h, w + 1, 1)
  g.fillRect(1 + w, 1, 1, h)

  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.font = fonts.bold(titleSize)
  g.fillStyle = theme.accent
  g.fillText(title, 8, 4)
  g.font = fonts.label(underSize)
  g.fillStyle = theme.chromeDim
  g.fillText(under, 8, 17)
}

/**
 * The readouts as a ruled table: a row of column headings over a row of
 * values, running along the top of the glass from the position block to the
 * right-hand edge.
 *
 * The period version puts each readout in its own sunken cell with a gap
 * between them. This is one continuous table with hairline dividers, which
 * is both denser and what the real thing does -- and it means a value can
 * be read straight down from the word that names it rather than sideways
 * from a label beside it.
 */
function drawDataTable(
  g: CanvasRenderingContext2D,
  cells: readonly Cell[],
  startX: number,
  endX: number,
): void {
  const headSize = 8
  const valueSize = 10
  const padX = 7
  const headTop = 4
  const valueTop = 15
  const h = 29

  // Along the top, beside the position block rather than under the picture.
  // A controller reads these against the traffic, and a readout at the far
  // bottom of the glass is a readout you look away from the traffic to see.
  const left = startX
  const right = endX
  const top = 1
  // On a window too narrow to hold the position block and the clock there
  // is no table, rather than a table drawn backwards.
  if (right <= left) return

  g.fillStyle = theme.chromeFace
  g.fillRect(left, top, right - left, h)
  // The rule goes under it now: it is the edge between the readouts and the
  // picture, and that edge is below rather than above.
  g.fillStyle = theme.chromeLight
  g.fillRect(left, top + h, right - left, 1)

  g.textAlign = 'left'
  g.textBaseline = 'top'

  let x = left
  for (const cell of cells) {
    const w =
      Math.ceil(
        Math.max(charW(headSize) * cell.label.length, charW(valueSize) * cell.value.length),
      ) +
      padX * 2
    // Columns are dropped from the right rather than allowed to spill, so
    // the ones that matter most survive a narrow window.
    if (x + w > right) break

    if (x > left) {
      g.fillStyle = theme.chromeLight
      g.fillRect(x, top + 1, 1, h - 1)
    }

    g.font = fonts.label(headSize)
    g.fillStyle = theme.chromeDim
    g.fillText(cell.label, x + padX, top + headTop)
    g.font = fonts.label(valueSize)
    g.fillStyle = theme.accent
    g.fillText(cell.value, x + padX, top + valueTop)

    readoutAt.set(cell.label, { x, y: top, w, h })
    x += w
  }
}

/* --------------------------------------------------------------- the clock

   The time was a column in the readout table: ten pixels, ninth in a row of
   ten, and the first thing to go when the window narrowed. That is the
   wrong treatment for the readout glanced at most and written on every
   strip, so it has the opposite corner from the position block, at a size
   meant to be read rather than looked up, and nothing can drop it.

   Two lines, because "the time" means two things here. The large one is the
   simulated time of day -- what a controller reads, and what an estimate or
   a strip is written against. The small one is how long the session has
   been running, which is what a player means by the same word. Showing one
   and not the other would answer half the question and look like it had
   answered all of it.

   Both are simulated. They run at whatever rate the loop is set to and they
   stop when it is paused, so a session at x4 gains four minutes of the day
   in one of yours. Neither is the wall clock and neither should be.      */

const CLOCK_TIME_SIZE = 15
const CLOCK_UNDER_SIZE = 8
const CLOCK_UNDER_PREFIX = 'ELAPSED '

/**
 * How wide the block is: whichever of its two lines is longer, plus the
 * padding either side. Measured from the widest text each line can hold
 * rather than from the text it happens to hold now, or the block would
 * breathe every time a digit changed.
 */
function clockWidth(): number {
  const time = charW(CLOCK_TIME_SIZE) * '00:00:00'.length
  const under = charW(CLOCK_UNDER_SIZE) * (CLOCK_UNDER_PREFIX.length + '00:00:00'.length)
  return Math.ceil(Math.max(time, under)) + 16
}

function drawClock(g: CanvasRenderingContext2D, cam: Camera, status: ScopeStatus): void {
  const flat = theme.chromeStyle === 'flat'
  const w = clockWidth()
  const h = flat ? 29 : 28
  // Flush to the frame under the flat idiom and inset ten under the period
  // one, matching what each does with the block in the other corner.
  const x = flat ? cam.width - 1 - w : cam.width - 10 - w
  const y = flat ? 1 : 10

  if (flat) {
    g.fillStyle = theme.chromeFace
    g.fillRect(x, y, w, h)
    g.fillStyle = theme.chromeLight
    g.fillRect(x, y + h, w, 1)
    g.fillRect(x, y, 1, h)
  } else {
    bevel(g, x, y, w, h)
  }

  // Right-aligned, so the digits sit in the same place as they tick over
  // instead of the whole readout shifting under a widening hour.
  const edge = x + w - 8
  g.textAlign = 'right'
  g.textBaseline = 'top'

  g.font = fonts.bold(CLOCK_TIME_SIZE)
  g.fillStyle = theme.accent
  g.fillText(formatClock(status.clock.timeOfDaySeconds), edge, y + 2)

  g.font = fonts.label(CLOCK_UNDER_SIZE)
  g.fillStyle = theme.chromeDim
  g.fillText(
    CLOCK_UNDER_PREFIX + formatElapsed(status.clock.elapsedSeconds),
    edge,
    y + 18,
  )
}

function drawTitleBlock(
  g: CanvasRenderingContext2D,
  airport: Airport,
  status: ScopeStatus,
): void {
  const size = 11
  const title = `${airport.icao} APPROACH`
  const sub = airport.name.toUpperCase()
  // Who is working the position, once someone has logged on. Third line
  // rather than a status bar cell, because it belongs with the identity of
  // the display rather than with the readouts that change.
  const who = status.controller
    ? `${status.controller.position}  ${status.controller.initials}`
    : null

  const widest = Math.max(title.length, sub.length, who?.length ?? 0)
  const w = Math.ceil(charW(size) * widest) + 18
  const h = who === null ? 40 : 54

  bevel(g, 10, 10, w, h)

  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.font = fonts.bold(size)
  g.fillStyle = theme.accent
  g.fillText(title, 19, 17)
  g.font = fonts.label(9)
  g.fillStyle = theme.chromeDim
  g.fillText(sub, 19, 31)
  if (who !== null) {
    g.fillStyle = theme.accent
    g.fillText(who, 19, 43)
  }
}

/**
 * What the readouts say. Shared by both idioms, so the period bar and the
 * modern table can never end up showing different things.
 */
function statusCells(
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
  status: ScopeStatus,
): readonly Cell[] {
  const shown = airport.airspace.filter((v) =>
    v.airspaceClass === 'G' ? overlays.trafficZones : overlays.airspace,
  )
  const published = shown.filter((v) => v.derivation === 'aip').length
  const ruled = shown.filter((v) => v.derivation === 'rule').length
  const scale = runwayScaleAt(airport.render, cam.pxPerNM)

  // Ordered by what a controller needs when the window is too narrow to
  // hold them all: cells are dropped from the right, so the ones that
  // matter most come first.
  return [
    // The clock is not here. It has a block of its own in the corner, where
    // it can be set large enough to read at a glance and cannot be dropped
    // when the window narrows -- see drawClock.
    //
    // First, because it is the only number here that is a verdict on how
    // the session is going.
    { label: 'SCORE', value: String(status.traffic.points) },
    {
      label: 'RATE',
      value: status.paused ? 'PAUSED' : formatSpeed(status.speed),
    },
    { label: 'RANGE', value: `${cam.rangeNM.toFixed(0)} NM` },
    { label: 'ARR', value: status.arrivalRunways.map((r) => r.id).join('/') || '--' },
    { label: 'RWY', value: `x${scale.toFixed(1)}` },
    {
      label: 'TRAFFIC',
      value: `${status.traffic.spawned} HELD ${status.traffic.held}`,
    },
    {
      label: 'LANDED',
      // With the ones that got away, because a landing rate means nothing
      // without knowing how many left unlanded to achieve it.
      value: `${status.traffic.landed} LOST ${status.traffic.left}`,
    },
    {
      label: 'OVERLAYS',
      // Counted from the list rather than written down, so adding a layer
      // cannot leave the readout claiming a total that is no longer true.
      value: `${densityOf(overlays).toUpperCase()} ${countEnabled(overlays)}/${OVERLAY_ITEMS.length}`,
    },
    { label: 'AIRSPACE', value: `${published} PUBLISHED / ${ruled} RULE-DERIVED` },
  ]
}

function drawStatusBar(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
  status: ScopeStatus,
): void {
  const cells = statusCells(cam, airport, overlays, status)

  const barH = 24
  const top = cam.height - barH - 8
  const left = 10
  const right = cam.width - 10
  bevel(g, left, top, Math.max(40, right - left), barH)

  const size = 9
  const cw = charW(size)
  let x = left + 5
  const cellY = top + 4
  const cellH = barH - 8

  g.textAlign = 'left'
  g.textBaseline = 'middle'

  for (const cell of cells) {
    const text = `${cell.label} ${cell.value}`
    const cellW = Math.ceil(cw * text.length) + 12
    // Stop rather than spill past the end of the bar on a narrow window.
    if (x + cellW > right - 5) break

    bevel(g, x, cellY, cellW, cellH, true)
    const mid = cellY + cellH / 2

    g.font = fonts.label(size)
    g.fillStyle = theme.chromeDim
    g.fillText(cell.label, x + 6, mid)
    g.fillStyle = theme.accent
    g.fillText(cell.value, x + 6 + Math.ceil(cw * (cell.label.length + 1)), mid)

    readoutAt.set(cell.label, { x, y: cellY, w: cellW, h: cellH })
    x += cellW + 4
  }

  // Key hints sit at the right end, and are the first thing to go when the
  // window is too narrow to hold them.
  const hint = 'DRAG PAN  WHEEL ZOOM  R RESET  D THEME  M MENU'
  const hintW = Math.ceil(cw * hint.length)
  if (right - 8 - hintW > x) {
    g.font = fonts.label(size)
    g.fillStyle = theme.chromeDim
    g.textAlign = 'right'
    g.fillText(hint, right - 8, cellY + cellH / 2)
  }
}
