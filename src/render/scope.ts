import type { Camera } from '../core/camera'
import { advance, type Vec2NM } from '../core/geo'
import {
  centrelinePoint,
  runwayScaleAt,
  type Airport,
  type AirspaceVolume,
  type Navaid,
  type NeighbourAirport,
  type Runway,
} from '../data/airport'
import { countEnabled, densityOf, type Overlays } from './overlays'
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

export function drawScope(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
): void {
  g.fillStyle = theme.bg
  g.fillRect(0, 0, cam.width, cam.height)

  // Bottom to top: airspace is the faintest wash, the field being worked
  // is the boldest thing on the display.
  const volumes = airport.airspace.filter((v) =>
    v.airspaceClass === 'G' ? overlays.trafficZones : overlays.airspace,
  )
  for (const volume of volumes) {
    drawAirspaceBoundary(g, cam, volume)
  }
  if (overlays.airspaceLabels) drawAirspaceLabels(g, cam, volumes)

  if (overlays.rangeRings) drawRangeRings(g, cam, airport)
  // The edge of the area of responsibility is not optional: it is the
  // boundary of the job, not decoration.
  drawSectorBoundary(g, cam, airport)
  drawCardinals(g, cam, airport)

  if (overlays.aerodromes) {
    for (const neighbour of airport.airports) {
      drawNeighbour(g, cam, airport, neighbour)
    }
  }
  for (const navaid of airport.navaids) {
    // Holds are operational rather than contextual, so they stay whatever
    // the overlay settings say.
    if (navaid.hold === null && !overlays.navaids) continue
    drawNavaid(g, cam, navaid, overlays.navaidFreqs)
  }
  if (overlays.centrelines) {
    for (const rwy of airport.arrivalRunways) {
      drawExtendedCentreline(g, cam, rwy)
    }
  }
  for (const rwy of airport.runways) {
    drawRunway(g, cam, airport, rwy)
  }

  drawHud(g, cam, airport, overlays)
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
  g.fillStyle = theme.chromeShadow
  g.fillRect(0, 0, w, 2)
  g.fillRect(0, 0, 2, h)
  g.fillStyle = theme.chromeLight
  g.fillRect(0, h - 2, w, 2)
  g.fillRect(w - 2, 0, 2, h)
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
}

/**
 * One label per name and altitude band, placed at the northernmost point
 * of the volume. The London TMA alone is twenty volumes across six bands,
 * so labelling each one individually would bury the display.
 */
function airspaceLabel(cam: Camera, volume: AirspaceVolume): AirspaceLabel | null {
  const shape = volume.shape
  let at: Vec2NM | null = null
  let size = 0

  if (shape.kind === 'circle') {
    at = { x: shape.centreNM.x, y: shape.centreNM.y + shape.radiusNM }
    size = cam.nmToPx(shape.radiusNM) * 2
  } else {
    const all: readonly Vec2NM[] =
      shape.kind === 'polygon' ? shape.verticesNM : shape.pathsNM.flat()
    if (all.length === 0) return null
    let top = all[0] as Vec2NM
    let minX = top.x
    let maxX = top.x
    for (const v of all) {
      if (v.y > top.y) top = v
      if (v.x < minX) minX = v.x
      if (v.x > maxX) maxX = v.x
    }
    at = top
    size = cam.nmToPx(maxX - minX)
  }

  if (!at || size < 40) return null

  const limits = `${formatLevel(volume.floorFt)}-${formatLevel(volume.ceilingFt)}`
  return {
    key: `${volume.label}|${limits}`,
    at,
    text: volume.label,
    limits,
    colour: airspaceColour(volume.airspaceClass),
    assumed: volume.verticalSource === 'assumed',
  }
}

function drawAirspaceLabels(
  g: CanvasRenderingContext2D,
  cam: Camera,
  volumes: readonly AirspaceVolume[],
): void {
  const seen = new Map<string, AirspaceLabel>()
  for (const v of volumes) {
    const l = airspaceLabel(cam, v)
    if (l && !seen.has(l.key)) seen.set(l.key, l)
  }

  g.font = fonts.label(9)
  g.textAlign = 'center'
  for (const l of seen.values()) {
    const p = cam.worldToScreen(l.at)
    g.fillStyle = theme.airspaceLabel
    g.textBaseline = 'bottom'
    g.fillText(l.text, p.x, p.y - 3)
    g.fillStyle = l.colour
    g.textBaseline = 'top'
    // Parentheses mark limits the source did not state.
    g.fillText(l.assumed ? `(${l.limits})` : l.limits, p.x, p.y + 2)
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

function drawSectorBoundary(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  const c = cam.worldToScreen(ORIGIN)
  g.lineWidth = 1
  g.strokeStyle = theme.ringStrong
  g.beginPath()
  g.arc(c.x, c.y, cam.nmToPx(airport.sector.radiusNM), 0, Math.PI * 2)
  g.stroke()
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

function drawNavaid(
  g: CanvasRenderingContext2D,
  cam: Camera,
  n: Navaid,
  showFreq: boolean,
): void {
  const p = cam.worldToScreen(n.posNM)
  const r = 6

  // Holding fixes get a stub along the inbound leg so the pattern reads at
  // a glance without drawing a full racetrack.
  if (n.hold) {
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
 * A raised or sunken panel face, the way interfaces of this era drew
 * every control: a one-pixel light edge along the top and left, a shadow
 * edge along the bottom and right, and the two swapped to read as sunken.
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

function drawHud(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
): void {
  drawTitleBlock(g, airport)
  drawStatusBar(g, cam, airport, overlays)
}

function drawTitleBlock(g: CanvasRenderingContext2D, airport: Airport): void {
  const size = 11
  const title = `${airport.icao} APPROACH`
  const sub = airport.name.toUpperCase()
  const w = Math.ceil(charW(size) * Math.max(title.length, sub.length)) + 18
  const h = 40

  bevel(g, 10, 10, w, h)

  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.font = fonts.bold(size)
  g.fillStyle = theme.accent
  g.fillText(title, 19, 17)
  g.font = fonts.label(9)
  g.fillStyle = theme.chromeDim
  g.fillText(sub, 19, 31)
}

function drawStatusBar(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
  overlays: Overlays,
): void {
  const shown = airport.airspace.filter((v) =>
    v.airspaceClass === 'G' ? overlays.trafficZones : overlays.airspace,
  )
  const published = shown.filter((v) => v.derivation === 'aip').length
  const ruled = shown.filter((v) => v.derivation === 'rule').length
  const scale = runwayScaleAt(airport.render, cam.pxPerNM)

  const cells: Cell[] = [
    { label: 'RANGE', value: `${cam.rangeNM.toFixed(0)} NM` },
    { label: 'ARR', value: airport.arrivalRunways.map((r) => r.id).join('/') },
    { label: 'RWY', value: `x${scale.toFixed(1)}` },
    {
      label: 'OVERLAYS',
      value: `${densityOf(overlays).toUpperCase()} ${countEnabled(overlays)}/8`,
    },
    { label: 'AIRSPACE', value: `${published} PUBLISHED / ${ruled} RULE-DERIVED` },
  ]

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

    x += cellW + 4
  }

  // Key hints sit at the right end, and are the first thing to go when the
  // window is too narrow to hold them.
  const hint = 'DRAG PAN  WHEEL ZOOM  R RESET  D THEME  O OVERLAYS'
  const hintW = Math.ceil(cw * hint.length)
  if (right - 8 - hintW > x) {
    g.font = fonts.label(size)
    g.fillStyle = theme.chromeDim
    g.textAlign = 'right'
    g.fillText(hint, right - 8, cellY + cellH / 2)
  }
}
