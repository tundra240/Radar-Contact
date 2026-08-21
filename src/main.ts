import './style.css'
import { Camera } from './core/camera'
import { loadAirport } from './data/airport'
import egllConfig from './data/egll.json'
import { drawScope } from './render/scope'
import {
  DEFAULT_OVERLAYS,
  OVERLAY_ITEMS,
  OVERLAY_PRESETS,
  densityOf,
  nextDensity,
  type DensityName,
  type OverlayKey,
  type Overlays,
} from './render/overlays'
import {
  paletteName,
  setPalette,
  theme,
  type PaletteName,
} from './render/theme'

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
  // The zoom ceiling is twice the area of responsibility: far enough to see
  // what is coming, close enough that the sector still fills the scope.
  const cam = new Camera({ x: 0, y: 0 }, airport.sector.defaultRangeNM, {
    maxNM: airport.sector.radiusNM * 2,
  })

  let overlays: Overlays = DEFAULT_OVERLAYS

  let frame = 0
  const requestDraw = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      drawScope(ctx, cam, airport, overlays)
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

  // ---- overlay control -------------------------------------------------
  // How much context to draw is a controller preference, not a constant.

  const OVERLAY_STORAGE = 'radar-contact:overlays'

  const readOverlays = (): Overlays | null => {
    try {
      const raw = window.localStorage.getItem(OVERLAY_STORAGE)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const rec = parsed as Record<string, unknown>
      // Read key by key rather than trusting the blob: a stale or
      // hand-edited entry must not put a non-boolean into the render path.
      const next: Record<string, boolean> = { ...DEFAULT_OVERLAYS }
      for (const item of OVERLAY_ITEMS) {
        const v = rec[item.key]
        if (typeof v === 'boolean') next[item.key] = v
      }
      return next as unknown as Overlays
    } catch {
      return null
    }
  }

  const rememberOverlays = (value: Overlays): void => {
    try {
      window.localStorage.setItem(OVERLAY_STORAGE, JSON.stringify(value))
    } catch {
      /* preference simply will not persist */
    }
  }

  const panel = document.createElement('div')
  panel.className = 'overlay-panel'
  panel.hidden = true

  const panelTitle = document.createElement('div')
  panelTitle.className = 'overlay-title'
  panelTitle.textContent = 'Display overlays'
  panel.appendChild(panelTitle)

  const densityButton = document.createElement('button')
  densityButton.type = 'button'
  densityButton.className = 'overlay-density'
  panel.appendChild(densityButton)

  const boxes = new Map<OverlayKey, HTMLInputElement>()
  for (const item of OVERLAY_ITEMS) {
    const row = document.createElement('label')
    row.className = 'overlay-row'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.addEventListener('change', () => {
      setOverlays({ ...overlays, [item.key]: box.checked })
    })
    row.appendChild(box)
    row.appendChild(document.createTextNode(item.label))
    panel.appendChild(row)
    boxes.set(item.key, box)
  }

  const overlayButton = document.createElement('button')
  overlayButton.type = 'button'
  overlayButton.className = 'mode-toggle overlay-button'
  overlayButton.textContent = 'OVERLAYS'

  const setOverlays = (value: Overlays): void => {
    overlays = value
    rememberOverlays(value)
    for (const [key, box] of boxes) box.checked = value[key]
    densityButton.textContent = 'PRESET: ' + densityOf(value).toUpperCase()
    requestDraw()
  }

  densityButton.addEventListener('click', () => {
    const next: DensityName = nextDensity(densityOf(overlays))
    setOverlays(OVERLAY_PRESETS[next])
  })

  // Tracked explicitly rather than read back off the element: the DOM
  // hidden property is typed string | boolean because it also accepts
  // "until-found", which is not a state this panel wants to reason about.
  let panelOpen = false
  const showPanel = (visible: boolean): void => {
    panelOpen = visible
    panel.hidden = !visible
    overlayButton.setAttribute('aria-expanded', String(visible))
  }

  overlayButton.addEventListener('click', () => showPanel(!panelOpen))

  // ---- light / dark control -------------------------------------------
  // The palette is a live object shared by every render module, so
  // switching it and asking for a redraw is the whole implementation.

  const STORAGE_KEY = 'radar-contact:palette'

  const storedPalette = (): PaletteName | null => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY)
      return v === 'beige' || v === 'dark' ? v : null
    } catch {
      // Private browsing and blocked storage both throw; a missing
      // preference is not worth failing the whole display over.
      return null
    }
  }

  const remember = (name: PaletteName): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, name)
    } catch {
      /* preference simply will not persist */
    }
  }

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'mode-toggle theme-button'

  const controls = document.createElement('div')
  controls.className = 'controls'
  controls.appendChild(overlayButton)
  controls.appendChild(toggle)
  controls.appendChild(panel)
  document.body.appendChild(controls)

  const paintChrome = (): void => {
    const dark = paletteName() === 'dark'
    // Shows the current display rather than the destination, which is what
    // aria-pressed reports and what a state indicator of the era would do.
    toggle.textContent = dark ? 'Mode dark' : 'Mode beige'
    toggle.title = dark ? 'Switch to the beige display' : 'Switch to the dark display'
    toggle.setAttribute('aria-pressed', String(dark))
    // Colours live in TypeScript, so the chrome is styled from the palette
    // rather than duplicating hex values in the stylesheet.
    // Chrome colours travel as CSS custom properties, so the stylesheet
    // owns the bevel geometry and theme.ts stays the only place a hex
    // value is written down.
    const root = document.documentElement.style
    root.setProperty('--face', theme.chromeFace)
    root.setProperty('--well', theme.chromeWell)
    root.setProperty('--bevel-light', theme.chromeLight)
    root.setProperty('--bevel-shadow', theme.chromeShadow)
    root.setProperty('--chrome-text', theme.chromeText)
    root.setProperty('--chrome-dim', theme.chromeDim)
    root.setProperty('--accent', theme.accent)
    document.body.style.background = theme.bg
    document.body.style.color = theme.text
  }

  const applyPalette = (name: PaletteName): void => {
    setPalette(name)
    remember(name)
    paintChrome()
    requestDraw()
  }

  toggle.addEventListener('click', () => {
    applyPalette(paletteName() === 'dark' ? 'beige' : 'dark')
  })

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'd' || e.key === 'D') {
      applyPalette(paletteName() === 'dark' ? 'beige' : 'dark')
    }
    if (e.key === 'o' || e.key === 'O') showPanel(!panelOpen)
  })

  setOverlays(readOverlays() ?? DEFAULT_OVERLAYS)
  applyPalette(storedPalette() ?? paletteName())


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
