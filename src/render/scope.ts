import type { Camera } from '../core/camera'
import { advance, type Vec2NM } from '../core/geo'
import { centrelinePoint, type Airport, type Runway } from '../data/airport'
import { fonts, theme } from './theme'

/**
 * Draws the static parts of the radar picture: range rings, runways,
 * extended centrelines and feeder fixes.
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

  drawRangeRings(g, cam, airport)
  drawCardinals(g, cam, airport)

  for (const rwy of airport.arrivalRunways) {
    drawExtendedCentreline(g, cam, rwy)
  }
  for (const rwy of airport.runways) {
    drawRunway(g, cam, rwy)
  }
  for (const fix of airport.fixes) {
    drawFix(g, cam, fix)
  }

  drawHud(g, cam, airport)
}

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

  // Sector boundary.
  const outer = cam.nmToPx(airport.sector.radiusNM)
  g.strokeStyle = theme.ringStrong
  g.beginPath()
  g.arc(c.x, c.y, outer, 0, Math.PI * 2)
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

function drawRunway(g: CanvasRenderingContext2D, cam: Camera, rwy: Runway): void {
  const a = cam.worldToScreen(rwy.thresholdNM)
  const b = cam.worldToScreen(rwy.farEndNM)

  g.strokeStyle = theme.runway
  // Runways are physically about 50 m wide; keep them visible when zoomed
  // out rather than vanishing to a hairline.
  g.lineWidth = Math.max(2, cam.nmToPx(0.03))
  g.lineCap = 'butt'
  g.beginPath()
  g.moveTo(a.x, a.y)
  g.lineTo(b.x, b.y)
  g.stroke()

  if (cam.nmToPx(1) > 6) {
    g.fillStyle = theme.runwayLabel
    g.font = fonts.label(10)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    // Offset perpendicular to the runway so the label clears the surface.
    const off = cam.worldToScreen(advance(rwy.thresholdNM, rwy.bearingTrue + 90, 0.35))
    g.fillText(rwy.id, off.x, off.y)
  }
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

  // One tick per NM, with the final approach fix called out.
  if (cam.nmToPx(1) < 5) return
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

    if (isFaf && cam.nmToPx(1) > 9) {
      g.fillStyle = theme.fafTick
      g.font = fonts.label(9)
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(`FAF ${rwy.id}`, p1.x, p1.y - 3)
    }
  }
}

function drawFix(
  g: CanvasRenderingContext2D,
  cam: Camera,
  fix: Airport['fixes'][number],
): void {
  const p = cam.worldToScreen(fix.posNM)
  const s = 5

  // Hold racetrack hint: a short stub along the inbound leg.
  if (fix.hold) {
    const tail = cam.worldToScreen(advance(fix.posNM, fix.hold.inboundTrue + 180, 2.5))
    g.strokeStyle = theme.fixHold
    g.lineWidth = 3
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(p.x, p.y)
    g.lineTo(tail.x, tail.y)
    g.stroke()
  }

  g.strokeStyle = theme.fix
  g.lineWidth = 1.5
  g.beginPath()
  g.moveTo(p.x, p.y - s)
  g.lineTo(p.x + s, p.y)
  g.lineTo(p.x, p.y + s)
  g.lineTo(p.x - s, p.y)
  g.closePath()
  g.stroke()

  g.fillStyle = theme.fixLabel
  g.font = fonts.label(11)
  g.textAlign = 'left'
  g.textBaseline = 'bottom'
  g.fillText(fix.name, p.x + s + 4, p.y - 2)
}

function drawHud(
  g: CanvasRenderingContext2D,
  cam: Camera,
  airport: Airport,
): void {
  g.font = fonts.label(11)
  g.textAlign = 'left'
  g.textBaseline = 'top'

  g.fillStyle = theme.accent
  g.fillText(`${airport.icao} APPROACH`, 12, 12)

  g.fillStyle = theme.textDim
  g.fillText(
    `RANGE ${cam.rangeNM.toFixed(0)} NM   ARR ${airport.arrivalRunways
      .map((r) => r.id)
      .join(' / ')}`,
    12,
    28,
  )
  g.fillText('drag to pan / wheel to zoom / R to reset', 12, 44)
}
