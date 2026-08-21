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
): void {
  g.fillStyle = theme.bg
  g.fillRect(0, 0, cam.width, cam.height)

  // Bottom to top: airspace is the faintest wash, the field being worked
  // is the boldest thing on the display.
  for (const volume of airport.airspace) {
    drawAirspace(g, cam, volume)
  }

  drawRangeRings(g, cam, airport)
  drawCardinals(g, cam, airport)

  for (const neighbour of airport.airports) {
    drawNeighbour(g, cam, airport, neighbour)
  }
  for (const navaid of airport.navaids) {
    drawNavaid(g, cam, navaid)
  }
  for (const rwy of airport.arrivalRunways) {
    drawExtendedCentreline(g, cam, rwy)
  }
  for (const rwy of airport.runways) {
    drawRunway(g, cam, airport, rwy)
  }

  drawHud(g, cam, airport)
}

/* ------------------------------------------------------------- airspace */

function drawAirspace(
  g: CanvasRenderingContext2D,
  cam: Camera,
  volume: AirspaceVolume,
): void {
  const colour = airspaceColour(volume.airspaceClass)

  g.save()
  g.strokeStyle = colour
  g.lineWidth = volume.airspaceClass === 'G' ? 1 : 1.4
  // A dashed edge means the boundary drawn is a stand-in for the real one.
  // Anything solid is either rule-derived or straight from the AIP.
  g.setLineDash(volume.approximate ? [3, 4] : [])
  g.globalAlpha = volume.airspaceClass === 'G' ? 0.55 : 0.8

  let labelAt: Vec2NM | null = null

  if (volume.shape.kind === 'circle') {
    const c = cam.worldToScreen(volume.shape.centreNM)
    const r = cam.nmToPx(volume.shape.radiusNM)
    if (r < 4) {
      g.restore()
      return
    }
    g.beginPath()
    g.arc(c.x, c.y, r, 0, Math.PI * 2)
    g.stroke()
    labelAt = {
      x: volume.shape.centreNM.x,
      y: volume.shape.centreNM.y + volume.shape.radiusNM,
    }
  } else {
    const verts = volume.shape.verticesNM
    g.beginPath()
    verts.forEach((v, i) => {
      const p = cam.worldToScreen(v)
      if (i === 0) g.moveTo(p.x, p.y)
      else g.lineTo(p.x, p.y)
    })
    g.closePath()
    g.stroke()
    labelAt = verts.reduce(
      (best, v) => (v.y > best.y ? v : best),
      verts[0] ?? ORIGIN,
    )
  }

  g.restore()

  // Only label when the volume is big enough on screen to carry text.
  const onScreenSize =
    volume.shape.kind === 'circle' ? cam.nmToPx(volume.shape.radiusNM) : 60
  if (!labelAt || onScreenSize < 34) return

  const p = cam.worldToScreen(labelAt)
  g.fillStyle = theme.airspaceLabel
  g.font = fonts.label(9)
  g.textAlign = 'center'
  g.textBaseline = 'bottom'
  g.fillText(volume.label, p.x, p.y - 3)
  g.fillStyle = colour
  g.fillText(
    `${formatLevel(volume.floorFt)}-${formatLevel(volume.ceilingFt)}`,
    p.x,
    p.y + 11,
  )
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

  // The edge of the area of responsibility.
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

function drawNavaid(g: CanvasRenderingContext2D, cam: Camera, n: Navaid): void {
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
  if (n.station && cam.pxPerNM > 12) {
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

function drawHud(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  g.font = fonts.bold(11)
  g.textAlign = 'left'
  g.textBaseline = 'top'

  g.fillStyle = theme.accent
  g.fillText(`${airport.icao} APPROACH`, 12, 12)

  g.font = fonts.label(10)
  g.fillStyle = theme.textDim
  const scale = runwayScaleAt(airport.render, cam.pxPerNM)
  g.fillText(
    `RANGE ${cam.rangeNM.toFixed(0)} NM   ARR ${airport.arrivalRunways
      .map((r) => r.id)
      .join(' / ')}   RWY x${scale.toFixed(1)}`,
    12,
    30,
  )
  g.fillText('drag pan / wheel zoom / R reset', 12, 44)

  // Airspace honesty, on the display rather than buried in a config file.
  const approx = airport.airspace.filter((v) => v.approximate).length
  if (approx > 0) {
    g.fillStyle = theme.airspaceLabel
    g.fillText(`dashed airspace approximate (${approx} of ${airport.airspace.length})`, 12, 58)
  }
}
