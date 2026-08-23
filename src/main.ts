import './style.css'
import { Camera } from './core/camera'
import { loadAirport, outerLimitNM, type Runway } from './data/airport'
import egllConfig from './data/egll.json'
import { departureOf, enterSector, isInSector, stepAircraft } from './sim/aircraft'
import { NO_SCORE, pointsFor, scoreDeparture, type Score } from './sim/score'
import type { Vec2NM } from './core/geo'
import { intensityAt, isAvoidable, makeWeather, windVector } from './sim/weather'
import {
  amend,
  feedPlan,
  letterOf,
  makeAtis,
  windString,
  type Atis,
  type RunwayFace,
} from './sim/atis'
import { AtisBar } from './ui/atisbar'
import { setToolLabel } from './ui/icons'
import { makeRng } from './core/rng'
import type { ControlZone } from './sim/airspace'
import {
  SAVE_VERSION,
  parseSavedGame,
  serialise,
  type SavedGame,
} from './sim/savegame'
import { Overflights } from './sim/overflight'
import { BASICS } from './tutorial/lessons/basics'
import { TutorialSession } from './tutorial/session'
import { Spawner } from './sim/spawner'
import { withScriptedCells, type WeatherCell } from './sim/weather'
import type { Aircraft } from './sim/types'
import type { Command } from './commands/types'
import { applyAll, type ApplyContext } from './commands/apply'
import { TagMenu } from './ui/tagmenu'
import { dragHeading, pickTarget, type VectorDrag } from './render/layers/targets'
import { StripBay } from './ui/stripbay'
import { Menu } from './ui/menu'
import { Logon, type LogonDetails } from './ui/logon'
import { isTypingTarget, ownsSpace } from './ui/keys'
import { Guide } from './ui/guide'
// The guide's text is the repository's own how-to-play document, imported
// as raw text rather than restated here. Editing TUTORIAL.md edits the
// panel: immediately with the dev server running, at build time otherwise.
import guideSource from '../TUTORIAL.md?raw'
import clickUrl from './assets/click.wav'
import { Sfx, isClickable } from './audio/sfx'
import { formatClock, formatSpeed, GameLoop, SPEEDS } from './core/loop'
import { drawScope } from './render/scope'
import {
  DEFAULT_OVERLAYS,
  OVERLAY_ITEMS,
  type Overlays,
} from './render/overlays'
import {
  formatLevel,
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

// The picture and the command line share the left column. The canvas is
// measured against the view rather than the column, so the status bar it
// draws along its own bottom edge is never hidden behind the console.
const viewEl = document.createElement('div')
viewEl.className = 'scope-view'
scopeEl.appendChild(viewEl)

const canvas = document.createElement('canvas')
viewEl.appendChild(canvas)

const g = canvas.getContext('2d')
if (!g) throw new Error('2D canvas context unavailable')

start(host, viewEl, canvas, g)

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

  // Fenced into the drawn map. Past the edge of the coastline data there is
  // nothing but empty ground, and being able to drag out there reads as a
  // broken display rather than as freedom. Derived from the data, so a
  // config with no map is simply not fenced.
  cam.setBounds(airport.mapBoundsNM)

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

  /** A mouse event in the canvas's own pixels, which is what picking wants. */
  const pointIn = (e: MouseEvent): { readonly x: number; readonly y: number } => {
    const rect = surface.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  surface.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    // An open menu is anchored to a point on the screen, and zooming moves
    // the aircraft out from under it.
    tagMenu.close()
    // One notch is a 10 percent range change, in the direction of scroll.
    cam.zoomAt(pointIn(e), e.deltaY < 0 ? 1.1 : 1 / 1.1)
    requestDraw()
  }, { passive: false })

  /**
   * What the left button is doing.
   *
   * Pressing on a target drags a vector out of it; pressing on empty scope
   * pans the picture. Deciding at the moment of the press, rather than
   * after the fact, is what makes both feel deliberate -- dragging the map
   * out from under the aircraft you were aiming would be the opposite of
   * useful.
   */
  let mode: 'idle' | 'pan' | 'vector' = 'idle'
  let lastX = 0
  let lastY = 0
  /** Where the press landed, in canvas pixels. */
  let pressAt = { x: 0, y: 0 }
  /** The aircraft a vector is being dragged out of, by callsign. */
  let dragCallsign: string | null = null
  /** Where the cursor is, while a vector is being dragged. */
  let dragToPx = { x: 0, y: 0 }
  /** What was selected before the press, so a click can still toggle it. */
  let selectedBeforePress: string | null = null

  /**
   * How far the pointer has to travel before a press counts as a drag
   * rather than a click. Below it, a heading taken from the cursor would be
   * decided by two or three pixels of hand tremor.
   */
  const DRAG_MIN_PX = 10

  const movedFrom = (at: { readonly x: number; readonly y: number }): number =>
    Math.hypot(at.x - pressAt.x, at.y - pressAt.y)

  /** The drag resolved against the world, so the line follows the target. */
  const currentDrag = (): VectorDrag | null => {
    if (dragCallsign === null) return null
    const aircraft = traffic.find((a) => a.callsign === dragCallsign)
    return aircraft === undefined ? null : { aircraft, toPx: dragToPx }
  }

  const endDrag = (): void => {
    mode = 'idle'
    dragCallsign = null
  }

  surface.addEventListener('pointerdown', (e: PointerEvent) => {
    // The left button only. The right button belongs to the tag menu, and
    // a right-drag that also panned would slide the picture out from under
    // the menu it had just opened.
    if (e.button !== 0) return
    const at = pointIn(e)
    pressAt = at
    lastX = e.clientX
    lastY = e.clientY
    surface.setPointerCapture(e.pointerId)

    // The selected aircraft wins a tie, so pulling one out of a stack from
    // its strip and then dragging on the scope turns the one you meant.
    const target = pickTarget(cam, mine(), at, undefined, selected)
    if (target === null) {
      mode = 'pan'
      dragCallsign = null
      return
    }

    mode = 'vector'
    dragCallsign = target.callsign
    dragToPx = at
    // Highlighted for the duration, so there is no doubt which aircraft the
    // line is coming out of. What was selected before is remembered, so a
    // press that turns out to be a click can still toggle it.
    selectedBeforePress = selected
    setSelected(target.callsign)
    syncStrips()
    requestDraw()
  })

  surface.addEventListener('pointermove', (e: PointerEvent) => {
    if (mode === 'idle') return

    if (mode === 'vector') {
      dragToPx = pointIn(e)
      requestDraw()
      return
    }

    cam.panByPx(e.clientX - lastX, e.clientY - lastY)
    lastX = e.clientX
    lastY = e.clientY
    requestDraw()
  })

  surface.addEventListener('pointerup', (e: PointerEvent) => {
    const was = mode
    const callsign = dragCallsign
    endDrag()
    if (e.button !== 0) {
      requestDraw()
      return
    }

    const at = pointIn(e)
    const far = movedFrom(at) > DRAG_MIN_PX

    if (was === 'vector' && callsign !== null) {
      if (far) {
        // Straight through the same gate as a typed clearance and a menu
        // one: one validation path, one readback, one log.
        const target = traffic.find((a) => a.callsign === callsign)
        if (target !== undefined) {
          issue([
            {
              kind: 'heading',
              callsign,
              deg: dragHeading(target, cam.screenToWorld(at)),
            },
          ])
        }
      } else {
        // It did not really move: that is a click, and a click on the
        // target that was already selected lets go of it.
        setSelected(selectedBeforePress === callsign ? null : callsign)
        syncStrips()
      }
      requestDraw()
      return
    }

    // A press on empty scope that did not pan is how you let go of a
    // target without picking another.
    if (was === 'pan' && !far) {
      setSelected(null)
      syncStrips()
    }
    requestDraw()
  })

  surface.addEventListener('pointercancel', (): void => {
    endDrag()
    requestDraw()
  })

  // Right-click a target: its clearances, at the cursor. On empty scope
  // there is nothing to instruct, so the menu just closes.
  /**
   * The other button abandons whatever the left one was doing, and opens
   * nothing.
   *
   * Changing your mind halfway through a drag is the commonest thing to
   * want, and this is where every drawing tool puts it. Without it the only
   * way out was Escape -- and letting go of the button afterwards issued the
   * clearance anyway, which is the part that actually bit.
   *
   * On the window and in the capture phase, for two reasons: the pointer is
   * captured during a drag, so the cursor may well be out over the strip bay
   * by the time you change your mind and the event would never reach the
   * canvas; and running first lets it call off the menu handler below rather
   * than racing it.
   */
  window.addEventListener(
    'contextmenu',
    (e: MouseEvent) => {
      if (mode === 'idle') return
      e.preventDefault()
      e.stopPropagation()
      // Cancelling a pan by the same rule is deliberate: it also stops a
      // menu opening over a picture that is still sliding underneath it.
      endDrag()
      requestDraw()
    },
    true,
  )

  surface.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault()
    const target = pickTarget(cam, mine(), pointIn(e), undefined, selected)
    if (target === null) {
      tagMenu.close()
      return
    }
    // Opening the menu picks the target up too: the aircraft being given
    // an instruction should be the one highlighted on the scope.
    setSelected(target.callsign)
    syncStrips()
    requestDraw()
    tagMenu.openFor(target, { x: e.clientX, y: e.clientY })
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

  // Both corner controls share a row. Mounted in the scope rather than on
  // the body: the strip bay owns the right-hand edge of the window, and
  // fixed positioning put controls straight on top of it.
  const controls = document.createElement('div')
  controls.className = 'controls'
  container.appendChild(controls)

  /**
   * WX: the weather layer, on the scope rather than buried in the menu.
   *
   * It is the one overlay a controller reaches for mid-vector -- to see what
   * is underneath a cell, or to check whether the gap they are aiming for is
   * really a gap -- so it gets a button of its own. It toggles the same
   * overlay key the menu checkbox does, so there is one piece of state and
   * the two can never disagree.
   */
  /**
   * Every tool is its own button.
   *
   * Under the flat idiom these become a column of small squares down the
   * left of the glass, labelled with a glyph, the way a modern position
   * labels its tools -- there is no room in one for a word. The period
   * schemes keep the words, because a Windows-2000 toolbar of wordless
   * buttons would be the wrong decade. Both are always present in the
   * markup; the stylesheet shows whichever the scheme calls for.
   *
   * Several of these duplicate something in the options menu. That is the
   * point: a rate change or a scheme change mid-vector should not need a
   * panel opened, and both routes call the same handler, so the two cannot
   * disagree about what is set.
   */
  const tool = (
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `mode-toggle ${className}`
    b.addEventListener('click', onClick)
    controls.appendChild(b)
    return b
  }

  const wxButton = tool('wx-button', () => {
    setOverlays({ ...overlays, weather: !overlays.weather })
  })
  setToolLabel(wxButton, 'wx', 'Weather')

  /** Run and stop, without opening anything. */
  const pauseButton = tool('pause-button', () => {
    loop.togglePaused()
    paintMenu()
    paintTools()
    requestDraw()
  })

  /** Steps through the rates and wraps, which is quicker than a panel. */
  const rateButton = tool('rate-button', () => {
    const i = SPEEDS.indexOf(loop.speed)
    loop.setSpeed(SPEEDS[(i + 1) % SPEEDS.length] ?? SPEEDS[0]!)
    loop.setPaused(false)
    tutorial?.observeSpeed(loop.speed)
    paintMenu()
    paintTools()
    requestDraw()
  })


  /**
   * Sun or moon: the lighting, not the whole scheme list.
   *
   * It moves between the two modern schemes only. Somebody on a period tube
   * has chosen a period tube, so the sensible thing for this button to do
   * there is take them to the modern position rather than guess which era
   * they meant.
   */
  const themeButton = tool('theme-button', () => {
    applyPalette(paletteName() === 'traconDark' ? 'traconLight' : 'traconDark')
    paintMenu()
    paintTools()
  })

  /**
   * The ATIS board: a button beside WX, and a small board under it showing
   * what the field is doing and offering the runway selection.
   *
   * Whether it is up is remembered, because it is a preference about how you
   * like the position laid out rather than anything about the session --
   * the same reasoning as the display scheme.
   *
   * `setAtis` is declared further down; the closure resolves at click time,
   * by which point it exists.
   */
  const ATIS_STORAGE = 'radar-contact:atis-board'

  const storedAtisOpen = (): boolean => {
    try {
      // Absent means shown: a board nobody has an opinion about yet is more
      // use up than hidden.
      return window.localStorage.getItem(ATIS_STORAGE) !== 'off'
    } catch {
      return true
    }
  }

  const atisBar = new AtisBar({
    mount: controls,
    open: storedAtisOpen(),
    onChange: (next) => setAtis(next),
    onToggle: (open) => {
      if (open) soleOpen('atis')
      try {
        window.localStorage.setItem(ATIS_STORAGE, open ? 'on' : 'off')
      } catch {
        // Blocked storage is not worth failing a toggle over.
      }
    },
  })

  /**
   * Put away every panel but the one just opened.
   *
   * They all open into the same strip of glass beside the rail, so two at
   * once is two stacked on each other -- which reads as a panel appearing
   * unprompted rather than as the one you asked for. Closed silently, or
   * each would report its own closing and call this again.
   */
  const soleOpen = (keep: 'menu' | 'atis' | 'guide'): void => {
    if (keep !== 'menu') menu.setOpen(false, true)
    if (keep !== 'atis') atisBar.setOpen(false, true)
    if (keep !== 'guide') guide.setOpen(false, true)

    // Lift the whole tool, not just its panel.
    //
    // A z-index on the panel alone should be enough, and reasoning about the
    // stacking says it is: the rail makes a stacking context, the wrappers
    // sit in it with no layer of their own, and a panel with a positive
    // z-index paints above all of them. It was not enough in practice --
    // the book stayed over the open options panel -- so the wrapper is
    // raised instead, which is one rule about whole tools rather than an
    // argument about where each panel lands inside one.
    for (const name of ['menu', 'atis', 'guide'] as const) {
      controls.querySelector(`.${name}`)?.classList.toggle('has-panel', name === keep)
    }
  }

  const menu = new Menu({
    mount: controls,
    onToggle: (open) => {
      if (open) soleOpen('menu')
    },
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
    // Wrapped rather than passed, because both are declared further down:
    // the menu is built before there is a loop or a spawner to snapshot.
    onSave: () => saveSession(),
    onLoad: () => loadSession(),
  })

  // ---- the guide -------------------------------------------------------
  // A book button next to the menu, opening the project's own how-to-play
  // document. Nothing about the text lives in the code: it is read from
  // TUTORIAL.md, so that file is both the document a person edits and the
  // one the game shows.

  const guide = new Guide({
    onToggle: (open) => {
      if (open) soleOpen('guide')
    },
    mount: controls,
    source: guideSource,
    title: `${airport.icao} approach -- how to play`,
    note: 'This guide is TUTORIAL.md, rendered as it stands. Edit that file to change it.',
  })

  /** The ticker, and the runway buttons behind it. */
  const paintAtis = (): void => {
    atisBar.paint({ atis, runways: runwayFaces })
  }

  /** The tools that relabel themselves as the thing they control changes. */
  const paintTools = (): void => {
    setToolLabel(
      pauseButton,
      loop.paused ? 'play' : 'pause',
      loop.paused ? 'Start the clock' : 'Stop the clock',
    )
    setToolLabel(rateButton, 'rate', `Clock rate ${formatSpeed(loop.speed)} -- press to step`)

    const lit = paletteName() === 'traconLight'
    setToolLabel(
      themeButton,
      lit ? 'moon' : 'sun',
      lit ? 'Switch to the dark position' : 'Switch to the light position',
    )
  }

  /** The button reads as pressed in while the layer is on. */
  const paintWx = (): void => {
    wxButton.classList.toggle('is-on', overlays.weather)
    wxButton.setAttribute('aria-pressed', String(overlays.weather))
  }

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

  /**
   * The lesson, when one is running.
   *
   * Declared here and built after the loop, because it needs the clock and
   * the camera and they do not exist yet -- while the things that report to
   * it, the selection and the clearance path, are defined above.
   */
  let tutorial: TutorialSession | null = null

  const bay = new StripBay({
    mount: shell,
    onContextMenu: (callsign, at) => {
      const target = traffic.find((a) => a.callsign === callsign)
      if (target === undefined) return
      setSelected(callsign)
      syncStrips()
      requestDraw()
      tagMenu.openFor(target, at)
    },
    onSelect: (callsign) => {
      // Clicking the same strip again clears the selection, which is how
      // you let go of a target without picking another.
      setSelected(selected === callsign ? null : callsign)
      syncStrips()
      requestDraw()
    },
    // Quick-buttons go through exactly the same gate as a typed line, so
    // there is one validation path and one readback format however the
    // clearance was issued.
    onLayoutChange: () => resize(),
  })

  /**
   * The strip bay's width, dragged from a grip on its inner edge.
   *
   * How many strips you want beside the picture, against how much picture
   * you want, is a preference rather than a constant -- and it changes with
   * the traffic: a quiet sector wants the glass and a busy one wants the
   * strips. Remembered, because having to set it every session would make
   * it not worth setting.
   *
   * Bounded at both ends. Narrow enough and a strip is unreadable; wide
   * enough and there is no radar left, and neither is a state worth being
   * able to drag yourself into.
   */
  const BAY_STORAGE = 'radar-contact:bay-width'
  const BAY_MIN_PX = 180
  const BAY_MAX_PX = 560

  const bayEl = document.querySelector<HTMLElement>('.strip-bay')
  if (bayEl !== null) {
    const clampBay = (px: number): number =>
      Math.max(BAY_MIN_PX, Math.min(BAY_MAX_PX, Math.round(px)))

    const setBayWidth = (px: number): void => {
      const width = clampBay(px)
      bayEl.style.setProperty('--bay-width', `${width}px`)
      try {
        window.localStorage.setItem(BAY_STORAGE, String(width))
      } catch {
        // Blocked storage is not worth failing a drag over.
      }
      // The canvas is sized from what is left, so it has to be told.
      resize()
    }

    try {
      const saved = Number(window.localStorage.getItem(BAY_STORAGE))
      if (Number.isFinite(saved) && saved > 0) {
        bayEl.style.setProperty('--bay-width', `${clampBay(saved)}px`)
      }
    } catch {
      // No preference: the stylesheet's default stands.
    }

    const grip = document.createElement('button')
    grip.type = 'button'
    grip.className = 'strip-resize'
    grip.setAttribute('aria-label', 'Resize the strip bay')
    grip.title = 'Drag to resize the strip bay'

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startW = bayEl.getBoundingClientRect().width

      const move = (ev: PointerEvent): void => {
        // The bay is docked right, so dragging left widens it.
        setBayWidth(startW + (startX - ev.clientX))
      }
      const up = (ev: PointerEvent): void => {
        grip.releasePointerCapture(ev.pointerId)
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.removeEventListener('pointercancel', up)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
      grip.addEventListener('pointercancel', up)
    })

    // Keyboard, because a drag handle that only works with a mouse is a
    // control half the people cannot use.
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowLeft') setBayWidth(bayEl.getBoundingClientRect().width + step)
      else if (e.key === 'ArrowRight') setBayWidth(bayEl.getBoundingClientRect().width - step)
      else return
      e.preventDefault()
    })

    bayEl.appendChild(grip)
  }

  /**
   * The traffic seed.
   *
   * The one in the airport config is fixed, which made every session deal
   * the same aircraft, in the same order, off the same fixes -- the whole
   * point of a seeded generator is that it CAN be pinned, not that it
   * always is. So the clock picks one, and the console says which, because
   * a session you cannot reproduce is a bug you cannot reproduce.
   *
   * ?seed=12345 in the URL pins it, which is how a session is flown again.
   */
  const seedFromUrl = (): number | null => {
    try {
      const asked = new URLSearchParams(window.location.search).get('seed')
      if (asked === null) return null
      const n = Number.parseInt(asked, 10)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch {
      return null
    }
  }

  // The spawner owns the arrival flow; this list is the world until there
  // is a world module to own it.
  const spawner = new Spawner({ airport, seed: seedFromUrl() ?? Date.now() })
  // Traffic that is not this field's: neighbours' inbounds crossing a
  // corner of the airspace, and continental flights over the top of it.
  // Sharing the spawner's flight generator, so no transit can be issued a
  // callsign an arrival is already using.
  const overflights = new Overflights({
    airport,
    flights: spawner.flights,
    seed: seedFromUrl() ?? Date.now(),
  })
  let traffic: readonly Aircraft[] = []

  // Landing and handoff are Day 2 and 3 work. Until then, crossing the area
  // of responsibility is how an arrival finishes -- and letting go of them
  // is what stops the concurrency cap filling permanently.

  const syncStrips = (): void => {
    bay.update(traffic, selected, asking)
    tagMenu.sync(traffic)
  }

  /**
   * Picking a target, wherever the pick came from.
   *
   * There are five ways to select an aircraft -- the scope, its data block,
   * a strip, a strip's menu button, and a load -- and the lesson has to see
   * all of them. Routing them through one function is cheaper than five
   * observations that can be added four times.
   */
  const setSelected = (callsign: string | null): void => {
    if (selected === callsign) return
    selected = callsign
    tutorial?.observeSelect(callsign)
  }

  // ---- clearances ------------------------------------------------------
  // Every input path -- the typed console, the strip quick-buttons, and the
  // mouse rubber-band when it arrives -- builds the same Command objects and
  // passes them through the same gate in commands/apply.ts. One place a
  // clearance can be refused, one readback format, one thing to test.

  const applyContext: ApplyContext = {
    // A getter, because the answer changes with the session: the context is
    // built once and the boundary is a choice made at logon.
    get controlZone(): ControlZone | null {
      return activeZone()
    },
    floorFt: airport.sector.floorFt,
    ceilingFt: airport.sector.ceilingFt,
    speedLimitKts: airport.sector.speedLimitKts,
    speedLimitBelowFt: airport.sector.speedLimitBelowFt,
    envelopeFor: (type) => {
      const t = airport.aircraftTypes.find((x) => x.type === type)
      return t === undefined
        ? null
        : { minSpeedKts: t.approachKts, maxSpeedKts: t.cruiseKts }
    },
    approachFor: (runway) => {
      const wanted = runway.trim().toUpperCase()
      // The runways in use, not the ones the config opened with: clearing
      // an approach for a runway the field has stopped landing on has to be
      // refused, exactly as it would be on frequency.
      const rwy = landingRunways().find((r) => r.id.toUpperCase() === wanted)
      if (rwy === undefined || !rwy.ils.available) return null
      // The whole geometry travels with the clearance, so the flight model
      // never has to reach back into the airport for it.
      return {
        runway: rwy.id,
        thresholdNM: rwy.thresholdNM,
        courseTrue: rwy.bearingTrue,
        thresholdElevationFt: rwy.thresholdElevationFt,
        glideslopeDeg: rwy.ils.glideslopeDeg,
        fafDistNM: rwy.ils.fafDistNM,
        // Published as a minimum in the config, used as what it is: the
        // widest angle the localiser will capture from.
        maxInterceptDeg: rwy.ils.minInterceptDeg,
        interceptAltMaxFt: airport.sector.interceptAltMaxFt,
      }
    },
    holdFor: (fix) => {
      const wanted = fix.trim().toUpperCase()
      const navaid = airport.navaids.find((n) => n.name.toUpperCase() === wanted)
      if (navaid === undefined || navaid.hold === null) return null
      // The whole pattern travels with the clearance, so the flight model
      // never has to reach back into the airport for it.
      return {
        fix: navaid.name,
        posNM: navaid.posNM,
        inboundTrue: navaid.hold.inboundTrue,
        turns: navaid.hold.turns,
        legMins: navaid.hold.legMins,
      }
    },
  }

  /**
   * Where a message to the controller goes now that there is no command
   * line to print it on.
   *
   * The line at the bottom of the glass has gone: a modern position does
   * not have one, and every message it carried is also shown where it
   * matters -- an aircraft asking to leave the weather is flagged on its
   * strip and its data block, a landing moves the score, and the ATIS
   * letter is on the board. What is left is the running commentary, which
   * is genuinely useful while debugging and merely noise on screen, so it
   * goes to the browser console rather than nowhere.
   *
   * Kept as one function rather than twenty scattered calls to console.info
   * so there is a single place to put the messages back on screen if they
   * are ever wanted there again.
   */
  const announce = (text: string, kind: 'note' | 'reject' | 'command' | 'readback' = 'note'): void => {
    if (kind === 'reject') console.warn(text)
    else console.info(text)
  }

  /**
   * Issues a line's worth of commands to one aircraft.
   *
   * All or nothing, so a refused speed does not leave the aircraft already
   * turned and descending -- the controller would then have to work out
   * which half of what they typed had taken effect.
   */
  function issue(commands: readonly Command[]): void {
    const first = commands[0]
    if (first === undefined) return

    const target = traffic.find((a) => a.callsign === first.callsign)
    if (target === undefined) {
      announce(`no aircraft ${first.callsign} on frequency`, 'reject')
      return
    }

    const outcome = applyAll(commands, target, applyContext)
    if (!outcome.ok) {
      announce(outcome.reason, 'reject')
      return
    }

    traffic = traffic.map((a) => (a.callsign === first.callsign ? outcome.aircraft : a))
    for (const readback of outcome.readbacks) announce(readback, 'readback')
    // Accepted ones only. A refused clearance is not progress through a
    // lesson, and counting it would teach that saying the wrong thing works.
    for (const command of commands) tutorial?.observeCommand(command)
    syncStrips()
    requestDraw()
  }

  /**
   * The tag menu, fed by the same sink as the console so a clearance
   * issued by pointing and a clearance issued by typing are the same
   * event as far as everything downstream is concerned.
   */
  const tagMenu = new TagMenu({
    mount: shell,
    onCommand: (command) => issue([command]),
    limits: {
      floorFt: airport.sector.floorFt,
      ceilingFt: airport.sector.ceilingFt,
      speedLimitKts: airport.sector.speedLimitKts,
      speedLimitBelowFt: airport.sector.speedLimitBelowFt,
    },
    runways: () => atis.arrivals,
    holdFixes: airport.navaids.filter((n) => n.hold !== null).map((n) => n.name),
    envelopeFor: applyContext.envelopeFor,
  })

  // ---- saving and loading ----------------------------------------------

  /**
   * Where a session lives between visits.
   *
   * One slot, deliberately. A list of saves wants naming, listing, deleting
   * and a dialog to do it in; one slot wants a button. If several are ever
   * wanted, the format already carries a timestamp to tell them apart.
   */
  const SAVE_STORAGE = 'radar-contact:session'

  const saveSession = (): void => {
    const game: SavedGame = {
      version: SAVE_VERSION,
      airport: airport.icao,
      savedAt: new Date().toISOString(),
      clock: loop.clock,
      score,
      atis,
      controller,
      selected,
      traffic: [...traffic],
      spawner: spawner.snapshot(),
      overflights: overflights.snapshot(),
    }

    try {
      window.localStorage.setItem(SAVE_STORAGE, serialise(game))
    } catch {
      // Storage full, or blocked. Saying so beats a button that silently
      // does nothing.
      announce('could not save the session', 'reject')
      return
    }

    announce(
      `session saved at ${formatClock(loop.clock.timeOfDaySeconds)} -- ` +
        `${traffic.length} on frequency, ${score.landed} landed, ${score.points} points`,
      'note',
    )
  }

  const loadSession = (): void => {
    let text: string | null = null
    try {
      text = window.localStorage.getItem(SAVE_STORAGE)
    } catch {
      text = null
    }
    if (text === null) {
      announce('there is no saved session', 'reject')
      return
    }

    const read = parseSavedGame(text, { airport: airport.icao })
    if (!read.ok) {
      announce(`could not load: ${read.reason}`, 'reject')
      return
    }

    const game = read.game
    traffic = game.traffic
    score = game.score
    // Restored wholesale rather than amended: this is not a new broadcast,
    // it is the one that was in force, letter included.
    atis = game.atis
    selected = game.selected
    controller = game.controller
    spawner.restore(game.spawner)
    if (game.overflights !== null) overflights.restore(game.overflights)
    loop.setTicks(game.clock.ticks)

    // Loaded paused, always. Dropping a controller into moving traffic they
    // have not looked at yet is how a saved session gets lost twice.
    loop.setPaused(true)

    if (controller === null) {
      logon.show()
      logon.focus()
    } else {
      logon.hide()
    }

    tagMenu.close()
    menu.setOpen(false)
    syncStrips()
    paintAtis()
    paintMenu()
    requestDraw()

    announce(
      `session loaded from ${game.savedAt.slice(0, 16).replace('T', ' ')} -- ` +
        `${traffic.length} on frequency, ${score.points} points. Paused.`,
      'note',
    )
  }

  // ---- the session -----------------------------------------------------
  // Who is working the position. Null until someone logs on, which is also
  // what keeps the clock stopped: the simulation is not running while the
  // main menu is up.
  let controller: LogonDetails | null = null

  /**
   * The score, and the two counts behind it. One value rather than three
   * loose counters, so what a session came to is a single thing.
   */
  /**
   * The ATIS: what the field is doing now.
   *
   * The config's active runways are only the opening position. From here on
   * this value is the authority -- the localisers drawn, the approaches that
   * can be cleared, the runway each entry fix feeds and the wind the
   * aircraft fly in all read off it, so there is one answer to "which way is
   * the field landing" rather than four that can drift apart.
   */
  let atis: Atis = makeAtis({
    arrivals: airport.arrivalRunways.map((r) => r.id),
    // A different runway from the arrivals, because that is how the field
    // is run: an arrival and a departure off the same strip have to be
    // separated in time, and splitting them is most of where the capacity
    // comes from. Nothing departs in the simulation yet, but the runway is
    // real, it is broadcast, and it is kept clear of the landing traffic.
    departures: airport.departureRunways.map((r) => r.id),
    wind: airport.weather.wind,
  })

  /** Every runway the field has, in the shape the ATIS reasons about. */
  const runwayFaces: readonly RunwayFace[] = airport.runways.map((r) => ({
    id: r.id,
    bearingTrue: r.bearingTrue,
    thresholdNM: r.thresholdNM,
  }))

  /** The full runway records for the ones currently landing. */
  const landingRunways = (): Runway[] =>
    airport.runways.filter((r) => atis.arrivals.includes(r.id))

  /** Which runway each entry fix is feeding, under the current ATIS. */
  const feeds = (): Map<string, string> =>
    feedPlan(
      airport.holdingFixes.map((n) => ({ name: n.name, posNM: n.posNM })),
      runwayFaces.filter((r) => atis.arrivals.includes(r.id)),
    )

  /**
   * The weather, from the session seed.
   *
   * A separate stream from the traffic, so the two are not correlated -- a
   * seed that happens to put a storm over Bovingdon should not also decide
   * what arrives there. Nothing about it goes into a save: the cells are a
   * function of the seed and where they have drifted to is a function of
   * the clock, so a loaded session regenerates exactly the weather it was
   * saved with.
   */
  let weather = makeWeather(makeRng(spawner.seed ^ 0x7715), airport.weather)

  /**
   * Cells put on the schedule by hand, for a lesson.
   *
   * The session's own weather is a function of its seed and stays exactly
   * as it was; these sit alongside it and are cleared when the lesson ends.
   */
  const setScriptedWeather = (cells: readonly WeatherCell[]): void => {
    weather = withScriptedCells(weather, cells)
    requestDraw()
  }

  /**
   * The wind the aircraft feel: a fraction of the reported wind. See
   * windEffect in data/airport.ts for why it is not all of it.
   *
   * Read off the ATIS rather than the config, so that amending the
   * broadcast is the one way the wind ever changes.
   */
  const windKts = (): Vec2NM => windVector(atis.wind, airport.weather.windEffect)

  /**
   * Amend the ATIS, and deal with what that means for traffic already
   * flying.
   *
   * An approach clearance carries its own geometry, so an aircraft cleared
   * for 27R would happily keep flying 27R after the field turned round --
   * straight at everything now departing the other way. So a clearance for
   * a runway that is no longer in use is withdrawn, and the aircraft holds
   * the heading it had. That is what would happen on frequency, and it is
   * the controller's problem to re-sequence, which is the point.
   */
  const setAtis = (next: {
    readonly arrivals: readonly string[]
    readonly departures: readonly string[]
  }): void => {
    const before = atis
    atis = amend(atis, next)
    // Reference equality: `amend` returns the same value when nothing
    // changed, and an ATIS that did not change should not be announced.
    if (atis === before) return

    const stale = traffic.filter(
      (a) => a.clearedApproach !== null && !atis.arrivals.includes(a.clearedApproach.runway),
    )
    if (stale.length > 0) {
      traffic = traffic.map((a) =>
        a.clearedApproach !== null && !atis.arrivals.includes(a.clearedApproach.runway)
          ? { ...a, clearedApproach: null, navMode: 'VECTOR' as const, clearedHdg: a.hdg }
          : a,
      )
      for (const a of stale) {
        announce(
          `${a.callsign} approach cancelled, runway change, maintain heading`,
          'reject',
        )
      }
    }

    announce(
      `ATIS Information ${letterOf(atis)}. Landing ${atis.arrivals.join(' and ') || 'nothing'}` +
        `, wind ${windString(atis.wind)}.`,
    )
    const plan = feeds()
    if (plan.size > 0) {
      announce(
        'Feeds: ' +
          [...plan.entries()].map(([fix, runway]) => `${fix} to ${runway}`).join(', '),
      )
    }

    paintAtis()
    requestDraw()
  }

  /** Callsigns in weather bad enough that the crew would ask to leave it. */
  const inWeather = (): ReadonlySet<string> => {
    const out = new Set<string>()
    const at = loop.clock.elapsedSeconds
    for (const a of traffic) {
      if (isAvoidable(intensityAt(weather, a.pos, at))) out.add(a.callsign)
    }
    return out
  }

  /** Who was already asking, so each request is made once and not per tick. */
  let asking: ReadonlySet<string> = new Set()

  let score: Score = NO_SCORE

  /** Nothing exists beyond this: see data/airport.ts. */
  const outerLimit = outerLimitNM(airport)

  /**
   * The area of responsibility in force, or null when this session is being
   * flown without one.
   *
   * Derived from the controller rather than kept as a second flag, so there
   * is one answer and a saved session carries it without being asked to.
   * Before anyone logs on it reads as enforced, which is the default the
   * logon window offers.
   */
  const activeZone = (): ControlZone | null =>
    controller === null || controller.enforceAirspace ? airport.controlZone : null

  /** Traffic the controller may actually touch. */
  const mine = (): readonly Aircraft[] => traffic.filter((a) => isInSector(a, activeZone()))

  const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

  // ---- the loop --------------------------------------------------------

  // Every fourth step, so five times a simulated second: past what anyone
  // can read, and far short of the twenty steps a second the simulation
  // runs at. Tying it to ticks rather than to the wall clock means it
  // follows the rate control and stops dead when paused.
  const SYNC_EVERY_TICKS = 4

  const loop = new GameLoop({
    tick: (dt, clock) => {
      simAdvanced = true

      // Fly everything, then take off the scope whatever is finished with
      // it. Both reasons are announced: a target that simply vanishes is
      // indistinguishable from a bug, and one of them used to happen five
      // miles outside the only boundary the scope draws.
      const flown: Aircraft[] = []
      for (const stepped of traffic.map((x) =>
        stepAircraft(x, dt, clock.elapsedSeconds, windKts()),
      )) {
        // Crossing in is what makes an aircraft the controller's, and it is
        // the only moment at which that changes.
        const zone = activeZone()
        const a = enterSector(stepped, zone)
        const departure = departureOf(a, zone, outerLimit)
        if (departure === null) {
          flown.push(a)
          continue
        }

        score = scoreDeparture(score, departure)
        const worth = signed(pointsFor(departure))
        if (departure === 'landed') {
          announce(
            `${a.callsign} landed ${a.clearedApproach?.runway ?? ''} ${worth}`.replace('  ', ' '),
            'readback',
          )
        } else if (departure === 'transited') {
          // Noted, not refused. A transit leaving is the whole of what a
          // transit does, and a log that scolded the controller for it
          // would be teaching them the wrong lesson.
          announce(
            `${a.callsign} cleared the sector${a.destination === null ? '' : ` for ${a.destination}`}`,
            'readback',
          )
        } else {
          // Refused rather than noted: an arrival that leaves the sector
          // unlanded is one you lost, and the log should read like it.
          announce(`${a.callsign} left the sector unlanded ${worth}`, 'reject')
        }
      }

      // A lesson puts a known situation in front of the player. An
      // automatic release into the middle of it would break the
      // instruction, and on the checkride it would break the separation
      // rule the step is marked against.
      if (tutorial?.suppressesTraffic === true) {
        traffic = flown
      } else {
        // The spawner sees the world as it is after the step, so a fix that
        // has just been vacated is available again on the same tick.
        const arrivals = spawner.update(dt, clock, flown)
        // And the transits see the arrivals, so their own cap counts what
        // is really on the display.
        const withArrivals = arrivals.length > 0 ? [...flown, ...arrivals] : flown
        const crossing = overflights.update(dt, clock, withArrivals)
        traffic = crossing.length > 0 ? [...withArrivals, ...crossing] : withArrivals
      }

      // Do not keep pointing at an aircraft that has left.
      if (selected !== null && !traffic.some((a) => a.callsign === selected)) {
        selected = null
      }

      if (clock.ticks % SYNC_EVERY_TICKS === 0) {
        // Once each, as they run into it. A request repeated twenty times a
        // second is not a request, it is a fault.
        const now = inWeather()
        for (const callsign of now) {
          if (asking.has(callsign)) continue
          announce(`${callsign} requesting vector due to severe weather`, 'reject')
        }
        asking = now
        // Once a sweep rather than once a tick: no goal here can change
        // faster than that, and the conflict scan would otherwise run
        // twenty times a second for nothing.
        tutorial?.observeTick()
        syncStrips()
      }
    },
    render: () => {
      if (!dirty && !simAdvanced) return
      dirty = false
      // Recomputed every frame: two of the four kinds of spotlight follow
      // something that moves, and either an aeroplane flying or the camera
      // panning puts the hole in the wrong place the instant it is not.
      tutorial?.layout()
      simAdvanced = false
      drawScope(
        ctx,
        cam,
        airport,
        overlays,
        {
          clock: loop.clock,
          arrivalRunways: landingRunways(),
          speed: loop.speed,
          paused: loop.paused,
          traffic: {
          spawned: spawner.spawned,
          held: spawner.deferred,
          landed: score.landed,
          left: score.lost,
          points: score.points,
        },
        airspaceEnforced: activeZone() !== null,
        weather,
          controller,
        },
        { aircraft: traffic, selected, drag: currentDrag(), alerts: asking },
      )
    },
  })

  /**
   * The lesson.
   *
   * Built here because it needs the clock and the camera. Everything it can
   * do to the world goes through this one object, so what a lesson is
   * capable of is a list you can read in one place rather than a set of
   * reaches into the session from somewhere else.
   */
  tutorial = new TutorialSession({
    module: BASICS,
    mount: shell,
    onRunning: () => {
      paintTools()
      requestDraw()
    },
    world: {
      airport,
      traffic: () => traffic,
      setTraffic: (next) => {
        traffic = next
        // A step that clears the scope must not leave the interface
        // pointing at an aeroplane that is no longer on it.
        if (selected !== null && !next.some((a) => a.callsign === selected)) {
          selected = null
        }
        tagMenu.close()
      },
      setWeather: setScriptedWeather,
      setPaused: (paused) => {
        loop.setPaused(paused)
        paintMenu()
        paintTools()
      },
      setSpeed: (speed) => {
        loop.setSpeed(speed)
        paintMenu()
        paintTools()
      },
      elapsedSeconds: () => loop.clock.elapsedSeconds,
      // Through the same gate as the console, the menu and the drag: a step
      // carried out on the player's behalf is refused for the same reasons
      // and read back the same way as one they issued themselves.
      issue: (command) => issue([command]),
      select: (callsign) => {
        setSelected(callsign)
        syncStrips()
      },
      screenOf: (at) => cam.worldToScreen(at),
      changed: () => {
        syncStrips()
        requestDraw()
      },
      announce,
    },
  })

  /**
   * Coming on position: the part that is the same whether the session is a
   * free one or a lesson.
   *
   * Split out because it was written once inside the logon handler and then
   * wanted twice. The two ways in differ in what happens after -- one starts
   * the clock, the other starts the lesson -- and in nothing before.
   */
  const takePosition = (details: LogonDetails): void => {
    controller = details
    try {
      window.localStorage.setItem(LOGON_STORAGE, details.initials)
      window.localStorage.setItem(AIRSPACE_STORAGE, details.enforceAirspace ? '1' : '0')
    } catch {
      /* preference simply will not persist */
    }
    logon.hide()
    menu.setOpen(false)
    announce(`${details.initials} on position ${details.position}`, 'note')
  }

  /**
   * Start the lesson, or end the one running.
   *
   * Reachable from the keyboard only. Which sort of sitting this is gets
   * decided on the logon screen, and a control on the rail would be asking
   * that question again in the middle of the traffic -- but a lesson ended
   * by mistake should not need the page reloaded to take again, and there is
   * no way back to the logon screen once you are on position.
   */
  const startLesson = (): void => {
    if (tutorial === null) return
    if (tutorial.running) {
      tutorial.stop()
      return
    }
    if (controller === null) {
      announce('log on before starting a lesson', 'reject')
      return
    }
    tutorial.start()
  }

  // Release an arrival on command, for when the scope is quiet or to line
  // up a particular situation without waiting for the cadence.
  const spawnNow = (): void => {
    const arrivals = spawner.spawnNow(loop.clock, traffic)
    if (arrivals.length === 0) return
    traffic = [...traffic, ...arrivals]
    syncStrips()
    requestDraw()
  }

  /**
   * And a transit, the same way.
   *
   * Worth having for the same reason the arrival one is -- setting up a
   * particular situation without waiting for it -- and worth saying out
   * loud when it does nothing, because a key that silently declines is
   * indistinguishable from a key that is not wired up.
   */
  const spawnTransitNow = (): void => {
    const crossing = overflights.spawnNow(loop.clock, traffic)
    if (crossing.length === 0) {
      announce('no transit available -- the sector is at its limit', 'reject')
      return
    }
    for (const a of crossing) {
      announce(
        `${a.callsign} crossing${a.destination === null ? '' : ` for ${a.destination}`} at ${a.altFt} ft`,
        'readback',
      )
    }
    traffic = [...traffic, ...crossing]
    syncStrips()
    requestDraw()
  }

  // ---- the main menu ---------------------------------------------------
  // The session begins at a logon screen rather than mid-shift. The clock
  // is held stopped behind it, so no traffic accumulates while the display
  // is being set up -- and the scope is drawn underneath, dimmed, so the
  // radar is visibly already running before anyone logs on.

  const LOGON_STORAGE = 'radar-contact:initials'
  const AIRSPACE_STORAGE = 'radar-contact:airspace'

  const storedInitials = (): string => {
    try {
      return window.localStorage.getItem(LOGON_STORAGE) ?? ''
    } catch {
      return ''
    }
  }

  /** Enforced unless the last session said otherwise: realism is the default. */
  const storedAirspace = (): boolean => {
    try {
      return window.localStorage.getItem(AIRSPACE_STORAGE) !== '0'
    } catch {
      return true
    }
  }

  const position = `${airport.icao}_APP`

  const logon = new Logon({
    mount: shell,
    title: `${airport.icao} APPROACH`,
    subtitle: airport.name,
    position,
    // Read off what actually loaded, so a data failure shows up here
    // rather than as a quietly empty scope.
    facts: [
      `Sector ${airport.sector.radiusNM} NM -- ${formatLevel(airport.sector.floorFt)} to ${formatLevel(airport.sector.ceilingFt)}`,
      `${airport.runways.length} runways -- arrivals ${airport.arrivalRunways
        .map((r) => r.id)
        .join(' and ')}`,
      `${airport.holdingFixes.length} holds -- ${airport.holdingFixes
        .map((f) => f.name)
        .join(' ')}`,
      `${airport.airports.length} aerodromes -- ${airport.airspace.length} airspace volumes`,
      `Map: ${airport.geography.map((f) => f.label.toLowerCase()).join(', ')}`,
    ],
    initials: storedInitials(),
    enforceAirspace: storedAirspace(),
    onSettings: () => menu.setOpen(true),
    onLogon: (details) => {
      takePosition(details)
      loop.setPaused(false)
      announce(
        `Traffic seed ${spawner.seed}. Add ?seed=${spawner.seed} to the address to fly it again.`,
        'note',
      )
      announce(
        'Clearances: right-click a target for its menu, or drag from one to vector it.',
        'note',
      )
      paintMenu()
      requestDraw()
    },
    onTutorial: (details) => {
      // On position first, then the lesson. It stops the clock, replaces the
      // traffic and expects clearances to be accepted, none of which works
      // behind the logon screen -- so this is a way into a session rather
      // than an alternative to one.
      takePosition(details)
      tutorial?.start()
      paintMenu()
      requestDraw()
    },
  })

  syncStrips()
  paintWx()
  paintAtis()
  paintTools()
  paintMenu()
  resize()
  // Stopped until someone logs on, so the shift starts when the controller
  // says it does.
  loop.setPaused(true)
  loop.start()
  logon.focus()

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
    paintWx()
    paintMenu()
    requestDraw()
  }

  // ---- display scheme --------------------------------------------------
  // The palette is a live object shared by every render module, so
  // switching it and asking for a redraw is the whole implementation.

  const STORAGE_KEY = 'radar-contact:palette'

  /**
   * Schemes that have been renamed, so a preference set before the rename
   * survives it.
   *
   * Without this the stored name simply fails validation and the display
   * silently reverts to the default -- which is the same symptom as the
   * setting not being saved at all, and is the sort of thing nobody reports
   * because it looks like they imagined it.
   */
  const RENAMED: Record<string, PaletteName> = { tracon: 'traconDark' }

  const storedPalette = (): PaletteName | null => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY)
      if (isPaletteName(v)) return v
      return v !== null && v in RENAMED ? (RENAMED[v] ?? null) : null
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
    root.setProperty('--edge', theme.chromeEdge)
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
    // Whether panels are bevelled or flat is geometry rather than colour, so
    // it travels as an attribute and the stylesheet switches on it. One
    // source of truth: the canvas chrome reads the same field.
    document.documentElement.dataset['chrome'] = theme.chromeStyle
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

  // ---- keyboard --------------------------------------------------------
  // One handler for every shortcut rather than one per feature. The
  // shortcuts are bare letters, so the guard at the top is not a detail:
  // without it, typing initials into the logon window released aircraft and
  // changed the display scheme. Having a single place to ask means the next
  // shortcut cannot be added without it.

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return

    // Abandons a vector being dragged, whatever has focus: a half-drawn
    // clearance you have changed your mind about should not need the mouse
    // brought back to somewhere safe to let go of it.
    if (e.key === 'Escape' && mode === 'vector') {
      endDrag()
      requestDraw()
      return
    }

    if (isTypingTarget(e.target)) return

    if (e.key === ' ') {
      if (ownsSpace(e.target)) return
      // Otherwise space scrolls the page or re-triggers a focused button.
      e.preventDefault()
      // Nothing to pause or resume until the shift has started.
      if (controller === null) return
      loop.togglePaused()
      paintMenu()
      requestDraw()
      return
    }

    switch (e.key.toLowerCase()) {
      case 'r':
        reset()
        return
      case 'd':
        // D still cycles the schemes without opening anything, because
        // trying them against live traffic is a by-eye decision.
        applyPalette(nextPaletteName())
        return
      // O as well as M: the overlays are what the menu is most often opened
      // for, and that shortcut is already documented.
      case 'm':
      case 'o':
        menu.toggle()
        return
      case 'n':
        // A dev shortcut, so it waits until someone is working the sector.
        if (controller !== null) spawnNow()
        return
      case 'l':
        // The lesson, from the keyboard as well as the rail.
        startLesson()
        return
      case 't':
        // The same, for traffic that is only passing through. T rather than
        // a second press of N: which kind you wanted is the whole question,
        // and a shortcut that cycled would make it a guess.
        if (controller !== null) spawnTransitNow()
        return
      default:
        return
    }
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
