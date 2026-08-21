import './style.css'
import { Camera } from './core/camera'
import { loadAirport } from './data/airport'
import egllConfig from './data/egll.json'
import { Spawner } from './sim/spawner'
import type { Aircraft } from './sim/types'
import { describeCommand, type Command } from './commands/types'
import { StripBay } from './ui/stripbay'
import { Menu } from './ui/menu'
import clickUrl from './assets/click.wav'
import { Sfx, isClickable } from './audio/sfx'
import { GameLoop } from './core/loop'
import { drawScope } from './render/scope'
import {
  DEFAULT_OVERLAYS,
  OVERLAY_ITEMS,
  type Overlays,
} from './render/overlays'
import {
  isPaletteName,
  nextPaletteName,
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

// The scope gets its own box so the camera measures the drawing area and
// not the window: the strip bay takes width off the side of it.
const scopeEl = document.createElement('div')
scopeEl.className = 'scope'
host.appendChild(scopeEl)

const canvas = document.createElement('canvas')
scopeEl.appendChild(canvas)

const g = canvas.getContext('2d')
if (!g) throw new Error('2D canvas context unavailable')

start(host, scopeEl, canvas, g)

function start(
  shell: HTMLDivElement,
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

  // The loop owns the frame now. requestDraw only marks the picture as
  // needing a repaint, which matters when the simulation is paused: an idle
  // scope then draws nothing at all rather than sixty identical frames a
  // second.
  let dirty = true
  let simAdvanced = false
  const requestDraw = (): void => {
    dirty = true
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

  // ---- interface sound -------------------------------------------------
  // One delegated listener rather than a handler per control: the strip bay
  // creates and destroys buttons as traffic comes and goes, and they should
  // sound without anyone remembering to wire them up.

  const SOUND_STORAGE = 'radar-contact:muted'

  const storedMuted = (): boolean => {
    try {
      return window.localStorage.getItem(SOUND_STORAGE) === '1'
    } catch {
      return false
    }
  }

  const sfx = new Sfx({ url: clickUrl })
  sfx.setMuted(storedMuted())
  // Fetch and decode up front so the very first press is audible. The
  // context stays suspended until a gesture resumes it, which is allowed.
  void sfx.prime()

  shell.addEventListener('click', (e: MouseEvent) => {
    if (isClickable(e.target)) sfx.play()
  })

  const toggleSound = (): void => {
    const muted = sfx.toggleMuted()
    try {
      window.localStorage.setItem(SOUND_STORAGE, muted ? '1' : '0')
    } catch {
      /* preference simply will not persist */
    }
    paintMenu()
  }

  // ---- the options menu ------------------------------------------------
  // Everything that is a setting rather than an instruction lives behind
  // one button: the simulation rate, the interface sound, the display
  // scheme and the overlay layers. Three floating controls over the radar
  // picture became one.
  //
  // The menu keeps none of that state. It reports clicks through these
  // callbacks and is told what to show by paintMenu, so the menu and the
  // keyboard shortcuts cannot end up disagreeing about what is set.

  const menu = new Menu({
    // Mounted in the scope rather than on the body: the strip bay owns the
    // right-hand edge of the window, and fixed positioning put controls
    // straight on top of it.
    mount: container,
    onOverlays: (next) => setOverlays(next),
    onPalette: (next) => applyPalette(next),
    onSpeed: (speed) => {
      loop.setSpeed(speed)
      // Choosing a rate implies wanting it to run.
      loop.setPaused(false)
      paintMenu()
      requestDraw()
    },
    onTogglePause: () => {
      loop.togglePaused()
      paintMenu()
      requestDraw()
    },
    onToggleSound: toggleSound,
  })

  const paintMenu = (): void => {
    menu.paint({
      overlays,
      palette: paletteName(),
      speed: loop.speed,
      paused: loop.paused,
      muted: sfx.muted,
    })
  }

  // ---- flight progress strips -----------------------------------------
  // The bay is a view over the world, so it holds no aircraft state of its
  // own. Today the snapshot is a frozen roster; Day 1 swaps DEMO_ROSTER for
  // the live world and nothing else here changes.

  let selected: string | null = null

  const bay = new StripBay({
    mount: shell,
    demo: true,
    quickDescendFt: airport.sector.interceptAltMaxFt,
    quickSpeedKts: 160,
    defaultRunway: airport.arrivalRunways[0]?.id ?? '27R',
    onSelect: (callsign) => {
      // Clicking the same strip again clears the selection, which is how
      // you let go of a target without picking another.
      selected = selected === callsign ? null : callsign
      syncStrips()
      requestDraw()
    },
    onCommand: (command: Command) => {
      // Temporary sink. Day 2 points this at commands/apply.ts; until then
      // the readback proves the strip buttons produce real commands.
      console.info('command:', describeCommand(command), command)
    },
    onLayoutChange: () => resize(),
  })

  // The spawner owns the arrival flow; this list is the world until there
  // is a world module to own it.
  const spawner = new Spawner({ airport })
  let traffic: readonly Aircraft[] = []

  const syncStrips = (): void => {
    bay.update(traffic, selected)
  }

  // ---- the loop --------------------------------------------------------

  // Every fourth step, so five times a simulated second: past what anyone
  // can read, and far short of the twenty steps a second the simulation
  // runs at. Tying it to ticks rather than to the wall clock means it
  // follows the rate control and stops dead when paused.
  const SYNC_EVERY_TICKS = 4

  const loop = new GameLoop({
    tick: (dt, clock) => {
      simAdvanced = true
      // Day 1: world.tick goes here, between the spawner and the strips.
      // Until it exists the traffic the spawner releases stays where it is
      // put, which is why the flow stalls once every fix is occupied -- the
      // HELD counter on the status bar is the spacing rule doing its job.
      const arrivals = spawner.update(dt, clock, traffic)
      if (arrivals.length > 0) traffic = [...traffic, ...arrivals]
      if (clock.ticks % SYNC_EVERY_TICKS === 0) syncStrips()
    },
    render: () => {
      if (!dirty && !simAdvanced) return
      dirty = false
      simAdvanced = false
      drawScope(ctx, cam, airport, overlays, {
        clock: loop.clock,
        speed: loop.speed,
        paused: loop.paused,
        traffic: { spawned: spawner.spawned, held: spawner.deferred },
      })
    },
  })

  // Release an arrival on command, for when the scope is quiet or to line
  // up a particular situation without waiting for the cadence.
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'n' && e.key !== 'N') return
    const arrivals = spawner.spawnNow(loop.clock, traffic)
    if (arrivals.length === 0) return
    traffic = [...traffic, ...arrivals]
    syncStrips()
    requestDraw()
  })

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== ' ') return
    // A focused checkbox keeps the space bar, because it is the only way
    // to set one from the keyboard, and the menu is full of them. Anything
    // else focused means space is meant for the clock.
    if (e.target instanceof HTMLInputElement && e.target.type === 'checkbox') return
    // Otherwise space scrolls the page or re-triggers a focused button.
    e.preventDefault()
    loop.togglePaused()
    paintMenu()
    requestDraw()
  })

  syncStrips()
  paintMenu()
  resize()
  loop.start()

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

  const setOverlays = (value: Overlays): void => {
    overlays = value
    rememberOverlays(value)
    paintMenu()
    requestDraw()
  }

  // ---- display scheme --------------------------------------------------
  // The palette is a live object shared by every render module, so
  // switching it and asking for a redraw is the whole implementation.

  const STORAGE_KEY = 'radar-contact:palette'

  const storedPalette = (): PaletteName | null => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY)
      return isPaletteName(v) ? v : null
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

  const paintChrome = (): void => {
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
    root.setProperty('--title-bar', theme.chromeTitleBar)
    root.setProperty('--title-text', theme.chromeTitleText)
    // Strip status colours, so the phase of flight reads at a glance.
    root.setProperty('--hold', theme.hold)
    root.setProperty('--established', theme.fafTick)
    root.setProperty('--warn', theme.warn)
    document.body.style.background = theme.bg
    document.body.style.color = theme.text
  }

  const applyPalette = (name: PaletteName): void => {
    setPalette(name)
    remember(name)
    paintChrome()
    paintMenu()
    requestDraw()
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // D still cycles the schemes without opening anything, because trying
    // them against live traffic is a by-eye decision.
    if (e.key === 'd' || e.key === 'D') applyPalette(nextPaletteName())
    // O kept as well as M: the overlays are what the menu is most often
    // opened for, and that shortcut is already documented.
    if (e.key === 'm' || e.key === 'M' || e.key === 'o' || e.key === 'O') menu.toggle()
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
