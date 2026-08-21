import './style.css'
import { Camera } from './core/camera'
import { loadAirport } from './data/airport'
import egllConfig from './data/egll.json'
import { drawScope } from './render/scope'

/**
 * Day 0 wiring: load and project the airport, hand it to the camera, and
 * draw the static scope. Pan and zoom exist so the coordinate converter and
 * the canvas scaler can be checked by eye as well as by unit test.
 *
 * There is deliberately no game loop yet -- redraws are event-driven. The
 * fixed-timestep simulation arrives with the aircraft model in Day 1.
 */

const airport = loadAirport(egllConfig)

const host = document.querySelector<HTMLDivElement>('#app')
if (!host) throw new Error('#app not found in index.html')

const canvas = document.createElement('canvas')
host.appendChild(canvas)

const g = canvas.getContext('2d')
if (!g) throw new Error('2D canvas context unavailable')

start(host, canvas, g)

function start(
  container: HTMLDivElement,
  surface: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): void {
  // World space is anchored on the airport reference point, so centring the
  // camera on the origin centres it on the field.
  const cam = new Camera({ x: 0, y: 0 }, airport.sector.defaultRangeNM)

  let frame = 0
  const requestDraw = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      drawScope(ctx, cam, airport)
    })
  }

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth
    const h = container.clientHeight

    surface.style.width = `${w}px`
    surface.style.height = `${h}px`
    surface.width = Math.round(w * dpr)
    surface.height = Math.round(h * dpr)

    // The single place device pixels are accounted for. Everything past
    // here, the camera included, works in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cam.setViewport(w, h)
    requestDraw()
  }

  const reset = (): void => {
    cam.setCentre({ x: 0, y: 0 })
    cam.setRangeNM(airport.sector.defaultRangeNM)
    requestDraw()
  }

  window.addEventListener('resize', resize)

  surface.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    const rect = surface.getBoundingClientRect()
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    // One notch is a 10 percent range change, in the direction of scroll.
    cam.zoomAt(anchor, e.deltaY < 0 ? 1.1 : 1 / 1.1)
    requestDraw()
  }, { passive: false })

  let dragging = false
  let lastX = 0
  let lastY = 0

  surface.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    surface.setPointerCapture(e.pointerId)
  })

  surface.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return
    cam.panByPx(e.clientX - lastX, e.clientY - lastY)
    lastX = e.clientX
    lastY = e.clientY
    requestDraw()
  })

  const endDrag = (): void => {
    dragging = false
  }
  surface.addEventListener('pointerup', endDrag)
  surface.addEventListener('pointercancel', endDrag)

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'r' || e.key === 'R') reset()
  })

  resize()

  // Sanity line in the console: if the projection were wrong, these
  // distances and bearings would be visibly nonsense.
  console.info(
    `${airport.icao}: ${airport.runways.length} runways, ` +
      `${airport.navaids.length} navaids (${airport.holdingFixes.length} holds), ` +
      `${airport.airports.length} nearby aerodromes, ` +
      `${airport.airspace.length} airspace volumes`,
  )
  console.info(
    'holds: ' +
      airport.holdingFixes
        .map(
          (f) =>
            `${f.name} ${f.distanceFromArpNM.toFixed(1)}NM/${f.bearingFromArpTrue.toFixed(0)}deg`,
        )
        .join(', '),
  )
}
