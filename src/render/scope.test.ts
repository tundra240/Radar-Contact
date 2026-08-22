import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Camera } from '../core/camera'
import { makeRng } from '../core/rng'
import { makeWeather } from '../sim/weather'
import { loadAirport, runwayScaleAt } from '../data/airport'
import raw from '../data/egll.json'
import { drawScope } from './scope'
import { OVERLAY_ITEMS, OVERLAY_PRESETS, type Overlays } from './overlays'
import type { ScopeContacts, ScopeStatus } from './scope'
import type { Aircraft } from '../sim/types'
import { PALETTE_ORDER, palettes, setPalette } from './theme'

/**
 * End-to-end check on the coordinate pipeline: published lat/lon -> world
 * space -> camera -> screen pixels. A recording stub stands in for the
 * canvas, so this runs headless while still proving the geometry lands
 * where it should.
 */

interface Text {
  s: string
  x: number
  y: number
}
interface Arc {
  x: number
  y: number
  r: number
}
/** One stroked polyline, with the state it was stroked under. */
interface Stroke {
  style: string
  width: number
  points: { x: number; y: number }[]
}

/** The canvas state that save() stacks and restore() puts back. */
const STATEFUL = [
  'fillStyle',
  'strokeStyle',
  'lineWidth',
  'lineCap',
  'globalAlpha',
  'font',
  'textAlign',
  'textBaseline',
] as const

function recorder(): {
  ctx: CanvasRenderingContext2D
  texts: Text[]
  arcs: Arc[]
  dashes: number[][]
  fills: string[]
  washes: { style: string; alpha: number }[]
  strokes: Stroke[]
  alphaAtEnd: () => number
} {
  const texts: Text[] = []
  const arcs: Arc[] = []
  const dashes: number[][] = []
  const fills: string[] = []
  const washes: { style: string; alpha: number }[] = []
  const saved: unknown[][] = []
  const strokes: Stroke[] = []
  let path: { x: number; y: number }[] = []
  const noop = (): void => {}
  const stub: Record<string, unknown> = {
    fillRect: () => {
      fills.push(String(stub["fillStyle"]))
    },
    beginPath: () => {
      path = []
    },
    closePath: noop,
    rect: noop,
    moveTo: (x: number, y: number) => {
      path.push({ x, y })
    },
    lineTo: (x: number, y: number) => {
      path.push({ x, y })
    },
    stroke: () => {
      // Copied, because the next beginPath replaces the array.
      strokes.push({
        style: String(stub['strokeStyle']),
        width: Number(stub['lineWidth']),
        points: [...path],
      })
    },
    fill: () => {
      washes.push({ style: String(stub['fillStyle']), alpha: Number(stub['globalAlpha']) })
    },
    // Modelled rather than ignored. A no-op save/restore hides a leaked
    // globalAlpha or stroke style, which is precisely the class of bug that
    // makes everything drawn afterwards quietly wrong.
    save: () => {
      saved.push(STATEFUL.map((k) => stub[k]))
    },
    restore: () => {
      const was = saved.pop()
      if (was === undefined) return
      STATEFUL.forEach((k, i) => {
        stub[k] = was[i]
      })
    },
    setLineDash: (d: number[]) => {
      dashes.push(d)
    },
    arc: (x: number, y: number, r: number) => {
      arcs.push({ x, y, r })
    },
    fillText: (s: string, x: number, y: number) => {
      texts.push({ s, x, y })
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  }
  return {
    ctx: stub as unknown as CanvasRenderingContext2D,
    texts,
    arcs,
    dashes,
    fills,
    washes,
    strokes,
    alphaAtEnd: () => Number(stub['globalAlpha']),
  }
}

const airport = loadAirport(raw)

// Every test in this file states the scheme it draws in rather than
// inheriting whatever the shipped default happens to be. Beige is a
// bevelled scheme, which is what most of the chrome assertions below are
// about; the flat idiom has its own describe at the end.
beforeEach(() => {
  setPalette('beige')
})

// A settled clock, so the status bar has something to show without the
// tests needing a running loop.
/** No weather, so a test that is not about weather sees none. */
const CALM = makeWeather(makeRng(1), {
  wind: { fromDeg: 250, speedKts: 0 },
  cellsPerHour: 0,
  minLifeMinutes: 5,
  maxLifeMinutes: 10,
  heavyChance: 0,
  minRadiusNM: 4,
  maxRadiusNM: 8,
  driftFactor: 0,
  driftSpreadDeg: 30,
  driftSpeedSpread: 0.35,
  shapeDriftDegPerMin: 6,
  spreadNM: 20,
})

const STATUS: ScopeStatus = {
  clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 12 * 3600 },
  arrivalRunways: airport.arrivalRunways,
  speed: 1,
  paused: false,
  traffic: { spawned: 0, held: 0, landed: 0, left: 0, points: 0 },
  controller: null,
  airspaceEnforced: true,
  weather: CALM,
}

// Most tests assert that a feature draws, so they render everything; the
// overlay tests pass a narrower set explicitly.
function render(
  w = 1000,
  h = 600,
  rangeNM = 30,
  overlays: Overlays = OVERLAY_PRESETS.full,
) {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
  cam.setViewport(w, h)
  const rec = recorder()
  drawScope(rec.ctx, cam, airport, overlays, STATUS)
  return { ...rec, cam, labels: rec.texts.map((t) => t.s) }
}

/**
 * The strokes that are the airspace boundary.
 *
 * Matched on the geometry rather than on a colour: it is the only thing
 * drawn as a closed ring with exactly as many points as one of the
 * published outlines.
 */
function boundaryStrokes(strokes: Stroke[]): Stroke[] {
  const sizes = new Set(airport.controlFootprint.map((ring) => ring.length))
  return strokes.filter((s) => sizes.has(s.points.length))
}

function at(texts: Text[], s: string): Text {
  const t = texts.find((x) => x.s === s)
  if (!t) throw new Error(`no label ${s}`)
  return t
}

describe('drawScope', () => {
  it('draws without throwing and labels the sector', () => {
    expect(render().labels).toContain('EGLL APPROACH')
  })

  it('centres the range rings on the airport reference point', () => {
    // 600 / 2 / 30 = 10 px per NM, so the 5/10/15/20 NM rings are at
    // 50/100/150/200 px. Airspace circles also use arc() but are centred on
    // their own aerodromes, so filter to the ring radii specifically.
    const { arcs, cam } = render()
    expect(cam.pxPerNM).toBeCloseTo(10, 9)
    // Some control zones happen to share a radius with a range ring, so
    // require a ring at each radius that is centred on the field itself.
    for (const r of [50, 100, 150, 200]) {
      const onField = arcs.filter(
        (a) => Math.round(a.r) === r && Math.abs(a.x - 500) < 1e-6 && Math.abs(a.y - 300) < 1e-6,
      )
      expect(onField.length, `ring at ${r}px centred on the ARP`).toBeGreaterThanOrEqual(1)
    }
  })

  it('draws 27R north of 27L on screen', () => {
    // The whole point of the y-flip living in the camera: north must be up.
    const { texts } = render()
    expect(at(texts, '27R').y).toBeLessThan(at(texts, '27L').y)
  })
})

describe('holds and navaids', () => {
  it('labels all four holds plus the surrounding VORs', () => {
    const { labels } = render()
    for (const n of ['LAM', 'BIG', 'BNN', 'OCK']) expect(labels, n).toContain(n)
    for (const n of ['LON', 'BPK', 'MID', 'CPT', 'MAY']) expect(labels, n).toContain(n)
  })

  it('places the holds on the correct sides of the field', () => {
    const { texts } = render()
    // LAM north-east, BIG south-east, BNN north, OCK south.
    expect(at(texts, 'LAM').x).toBeGreaterThan(500)
    expect(at(texts, 'LAM').y).toBeLessThan(300)
    expect(at(texts, 'BIG').x).toBeGreaterThan(500)
    expect(at(texts, 'BIG').y).toBeGreaterThan(300)
    expect(at(texts, 'BNN').y).toBeLessThan(300)
    expect(at(texts, 'OCK').y).toBeGreaterThan(300)
  })

  it('shows navaid frequencies only once zoomed in', () => {
    expect(render(1000, 600, 30).labels).not.toContain('113.60')
    expect(render(1000, 600, 15).labels).toContain('113.60')
  })
})

describe('surrounding aerodromes', () => {
  it('labels the major neighbours', () => {
    const { labels } = render()
    for (const icao of ['EGKK', 'EGGW', 'EGLC', 'EGKB', 'EGWU', 'EGLF']) {
      expect(labels, icao).toContain(icao)
    }
  })

  it('holds back the small fields until zoomed in', () => {
    // Otherwise the picture is a wall of four-letter codes.
    expect(render(1000, 600, 30).labels).not.toContain('EGTF')
    expect(render(1000, 600, 8).labels).toContain('EGTF')
  })

  it('positions neighbours on their real bearings', () => {
    const { texts } = render()
    // Gatwick is south of the field, Luton north, London City east.
    expect(at(texts, 'EGKK').y).toBeGreaterThan(300)
    expect(at(texts, 'EGGW').y).toBeLessThan(300)
    expect(at(texts, 'EGLC').x).toBeGreaterThan(500)
  })
})

describe('airspace overlay', () => {
  it('labels the control zones and the TMA', () => {
    const { labels } = render()
    for (const id of ['LONDON TMA', 'LONDON CTR', 'GATWICK CTR', 'LUTON CTR']) {
      expect(labels, id).toContain(id)
    }
  })

  it('annotates vertical limits in chart form', () => {
    const { labels } = render()
    expect(labels).toContain('SFC-2500')
    expect(labels).toContain('2500-FL195')
  })

  it('anchors a rule-derived traffic zone on its aerodrome', () => {
    // Published zones are line work now; the circles left are the ATZs the
    // sector file does not cover, and those must sit on their field.
    const { arcs, texts } = render(1000, 600, 8)
    const northolt = at(texts, 'EGWU')
    const atz = arcs.find((a) => Math.abs(a.x - northolt.x) < 2 && Math.round(a.r) > 20)
    expect(atz, 'an ATZ circle near EGWU').toBeDefined()
  })

  it('dashes approximate boundaries and leaves rule-derived ones solid', () => {
    const { dashes } = render(1000, 600, 8)
    expect(dashes.some((d) => d.length > 0)).toBe(true)
    expect(dashes.some((d) => d.length === 0)).toBe(true)
  })

  it('states airspace provenance and overlay density in the status bar', () => {
    const { labels } = render()
    // Readouts are label/value pairs in bevelled cells, so the label and
    // its value are separate draws.
    expect(labels).toContain('AIRSPACE')
    expect(labels).toContain('OVERLAYS')
    expect(labels.some((s) => s.includes('PUBLISHED'))).toBe(true)
    expect(labels.some((s) => s.includes('RULE-DERIVED'))).toBe(true)
    expect(labels.some((s) => s.includes('FULL'))).toBe(true)
  })

  it('shows the rule-derived traffic zones when zoomed in', () => {
    expect(render(1000, 600, 8).labels).toContain('EGWU ATZ')
  })
})

describe('runway display scale', () => {
  it('magnifies the painted strip when zoomed out', () => {
    expect(runwayScaleAt(airport.render, 10)).toBeGreaterThan(2)
  })

  it('falls back to true scale when zoomed in', () => {
    expect(runwayScaleAt(airport.render, 100)).toBe(1)
    expect(runwayScaleAt(airport.render, airport.render.exaggerationCutoffPxPerNM)).toBe(1)
  })

  it('fades smoothly rather than snapping', () => {
    const mid = runwayScaleAt(airport.render, airport.render.exaggerationCutoffPxPerNM / 2)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(airport.render.runwayExaggeration)
  })

  it('reports the current magnification in the status bar', () => {
    const { labels } = render()
    expect(labels).toContain('RWY')
    expect(labels.some((s) => s.startsWith('x') && s.length <= 5)).toBe(true)
  })
})

describe('published airspace rendering', () => {
  it('collapses the TMA to one label per altitude band', () => {
    // The London TMA is twenty separate volumes. Labelling each would bury
    // the display, so labels are deduplicated by name and band.
    const { labels } = render()
    const tma = labels.filter((s) => s === 'LONDON TMA')
    expect(tma.length).toBeGreaterThanOrEqual(1)
    expect(tma.length).toBeLessThanOrEqual(8)
    expect(airport.airspace.filter((v) => v.label === 'LONDON TMA').length)
      .toBeGreaterThan(tma.length)
  })

  it('distinguishes published from rule-derived by line style', () => {
    const { dashes } = render(1000, 600, 8)
    // Solid for published, dotted for rule-derived.
    expect(dashes.some((d) => d.length === 0)).toBe(true)
    expect(dashes.some((d) => d.length === 2 && d[0] === 1)).toBe(true)
  })

  it('brackets vertical limits the source did not state', () => {
    // Gatwick's header carries no limits, so its label shows them in
    // parentheses rather than presenting them as published.
    const { labels } = render(1000, 600, 40)
    expect(labels.some((s) => s.startsWith('(') && s.endsWith(')'))).toBe(true)
  })
})

describe('palette switching', () => {
  afterEach(() => {
    setPalette('beige')
  })

  it('paints the ground from the active palette', () => {
    setPalette('beige')
    expect(render().fills[0]).toBe(palettes.beige.bg)
    setPalette('dark')
    expect(render().fills[0]).toBe(palettes.dark.bg)
  })

  it('redraws the whole picture in the new scheme', () => {
    // Every label still renders after a switch; a missing colour would
    // throw or silently draw nothing.
    setPalette('dark')
    const { labels } = render()
    expect(labels).toContain('EGLL APPROACH')
    expect(labels).toContain('LAM')
    expect(labels).toContain('LONDON TMA')
  })
})

describe('overlay control', () => {
  const only = (over: Partial<Overlays>): Overlays => ({
    ...OVERLAY_PRESETS.minimal,
    ...over,
  })

  it('draws the operational picture even at minimum density', () => {
    // What must survive every setting: the runways being worked, their
    // centrelines, the holds, and the sector boundary.
    const { labels, strokes } = render(1000, 600, 30, OVERLAY_PRESETS.minimal)
    expect(labels).toContain('27R')
    expect(labels).toContain('27L')
    for (const hold of ['LAM', 'BIG', 'BNN', 'OCK']) {
      expect(labels, hold).toContain(hold)
    }
    // And the edge of the airspace, which is now the published outline
    // rather than a circle: a closed stroke with as many points as the ring.
    expect(boundaryStrokes(strokes).length).toBeGreaterThan(0)
  })

  it('drops the context layers at minimum density', () => {
    const { labels } = render(1000, 600, 30, OVERLAY_PRESETS.minimal)
    expect(labels).not.toContain('LONDON TMA')
    expect(labels).not.toContain('EGKK')
    expect(labels).not.toContain('CPT')
  })

  it('keeps holds while hiding the other navaids', () => {
    const { labels } = render(1000, 600, 15, only({ navaids: false }))
    expect(labels).toContain('LAM')
    expect(labels).not.toContain('CPT')
    expect(labels).not.toContain('MAY')
  })

  it('separates traffic zones from controlled airspace', () => {
    const zonesOff = render(1000, 600, 8, only({ airspace: true, airspaceLabels: true }))
    expect(zonesOff.labels).not.toContain('EGWU ATZ')

    const zonesOn = render(
      1000,
      600,
      8,
      only({ airspace: true, airspaceLabels: true, trafficZones: true }),
    )
    expect(zonesOn.labels).toContain('EGWU ATZ')
  })

  it('can draw boundaries without their labels', () => {
    const { labels, dashes } = render(1000, 600, 30, only({ airspace: true }))
    expect(labels).not.toContain('LONDON TMA')
    // The line work is still stroked, just unlabelled.
    expect(dashes.length).toBeGreaterThan(0)
  })

  it('turns range rings off without losing the airspace boundary', () => {
    const off = render(1000, 600, 30, only({ rangeRings: false }))
    expect(boundaryStrokes(off.strokes).length).toBeGreaterThan(0)
    // The 10 NM ring is gone with the rest of them.
    expect(off.arcs.some((a) => Math.round(a.r) === 100)).toBe(false)
  })

  it('turns extended centrelines off', () => {
    const { labels } = render(1000, 600, 12, only({ centrelines: false }))
    expect(labels).not.toContain('FAF 27R')
    expect(labels).toContain('27R')
  })

  it('gates navaid frequencies separately from navaids', () => {
    const withFreq = render(1000, 600, 15, only({ navaids: true, navaidFreqs: true }))
    expect(withFreq.labels).toContain('113.60')
    const without = render(1000, 600, 15, only({ navaids: true, navaidFreqs: false }))
    expect(without.labels).toContain('LON')
    expect(without.labels).not.toContain('113.60')
  })

  it('names the active density in the status bar', () => {
    expect(
      render(1000, 600, 30, OVERLAY_PRESETS.minimal).labels.some((s) =>
        s.includes('MINIMAL'),
      ),
    ).toBe(true)
    expect(
      render(1000, 600, 30, only({ navaids: true })).labels.some((s) =>
        s.includes('CUSTOM'),
      ),
    ).toBe(true)
  })
})

describe('period chrome', () => {
  it('draws the readouts as bevelled panels', () => {
    // Raised faces for the title block and status bar, sunken wells for
    // each readout cell: the look is built from those two, so both must
    // actually be painted.
    const { fills } = render()
    expect(fills).toContain(palettes.beige.chromeFace)
    expect(fills).toContain(palettes.beige.chromeWell)
    expect(fills).toContain(palettes.beige.chromeLight)
    expect(fills).toContain(palettes.beige.chromeShadow)
  })

  it('shows who is working the position once they have logged on', () => {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.standard, {
      ...STATUS,
      controller: { initials: 'NF', position: 'EGLL_APP' },
    })
    const labels = rec.texts.map((t) => t.s)
    expect(labels).toContain('EGLL_APP  NF')
  })

  it('leaves the title block alone before anyone logs on', () => {
    expect(render().labels.some((s) => s.includes('_APP  '))).toBe(false)
  })

  it('names the field and the airport in the title block', () => {
    const { labels } = render()
    expect(labels).toContain('EGLL APPROACH')
    expect(labels).toContain('LONDON HEATHROW')
  })

  it('keeps the status bar inside a narrow window', () => {
    // Cells are dropped rather than allowed to spill past the bar, so a
    // small viewport loses readouts instead of drawing over the edge.
    const narrow = render(320, 400)
    const wide = render(1400, 800)
    expect(narrow.labels.length).toBeLessThan(wide.labels.length)
    expect(narrow.labels).toContain('RANGE')
  })

  it('drops the key hints before it drops a readout', () => {
    expect(render(1400, 800).labels.some((s) => s.includes('DRAG PAN'))).toBe(true)
    expect(render(420, 400).labels.some((s) => s.includes('DRAG PAN'))).toBe(false)
  })

  it('follows the palette into dark mode', () => {
    setPalette('dark')
    const { fills } = render()
    expect(fills).toContain(palettes.dark.chromeFace)
    expect(fills).not.toContain(palettes.beige.chromeFace)
    setPalette('beige')
  })
})

describe('display schemes', () => {
  afterEach(() => {
    setPalette('beige')
  })

  it('renders the full picture in every scheme', () => {
    for (const name of PALETTE_ORDER) {
      setPalette(name)
      const { labels, fills } = render()
      expect(labels, name).toContain('EGLL APPROACH')
      expect(labels, name).toContain('LAM')
      expect(labels, name).toContain('LONDON TMA')
      // Ground and chrome both painted from the scheme in force.
      expect(fills[0], name).toBe(palettes[name].bg)
      expect(fills, name).toContain(palettes[name].chromeFace)
    }
  })

  it('sinks the scope into a bevelled frame', () => {
    // Drawn last so it sits above the picture, using the chrome edges: the
    // display should read as a viewport recessed into a window.
    const { fills } = render()
    expect(fills).toContain(palettes.beige.chromeShadow)
    expect(fills).toContain(palettes.beige.chromeLight)
  })
})

describe('airspace label placement', () => {
  const AIRSPACE_NAMES = [
    'LONDON TMA',
    'LONDON CTR',
    'STANSTED CTA',
    'LUTON CTR',
    'LUTON CTA',
    'GATWICK CTR',
    'GATWICK CTA',
    'CITY CTA',
    'FARNBOROUGH CTR',
    'FARNBOROUGH CTA',
  ]

  it('never stacks two labels on the same spot', () => {
    // The reported bug: Stansted's CTA and the TMA's lowest band are built
    // from shared boundary lines and have the identical northernmost
    // vertex, so both labels were drawn on the same pixel and the text
    // turned to mush.
    for (const range of [12, 20, 30, 40, 60]) {
      const { texts } = render(1000, 600, range)
      const seen = new Set<string>()
      for (const t of texts) {
        const key = `${Math.round(t.x)},${Math.round(t.y)}`
        expect(seen.has(key), `two labels at ${key} at range ${range}: ${t.s}`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('separates the Stansted and TMA labels that share a vertex', () => {
    const { texts } = render()
    const stansted = texts.find((t) => t.s === 'STANSTED CTA')
    const tma = texts.find((t) => t.s === 'LONDON TMA')
    expect(stansted).toBeDefined()
    expect(tma).toBeDefined()
    if (!stansted || !tma) return
    expect(Math.hypot(stansted.x - tma.x, stansted.y - tma.y)).toBeGreaterThan(10)
  })

  it('does not name the same airspace over and over', () => {
    // The TMA has nine bands and Farnborough nine. Naming each one crowds
    // out the zones that have not been named at all.
    const { texts } = render()
    for (const name of AIRSPACE_NAMES) {
      const n = texts.filter((t) => t.s === name).length
      expect(n, `${name} drawn ${n} times`).toBeLessThanOrEqual(2)
    }
  })

  it('still names the surface zones around the field', () => {
    // These are the ones worth the space, so they must survive the cull.
    const { labels } = render()
    for (const name of ['LONDON CTR', 'LUTON CTR', 'GATWICK CTR']) {
      expect(labels, name).toContain(name)
    }
  })

  it('prefers the lowest base when it can only name one band', () => {
    // Of the TMA's nine bands the 2500 ft base is the one that matters:
    // it is the first thing an aircraft would climb into.
    const { labels } = render()
    expect(labels).toContain('2500-FL195')
  })

  it('keeps airspace labels inside the viewport', () => {
    // Only the airspace labels: compass marks sit on the sector ring, which
    // is deliberately outside the view at close range.
    const { texts, cam } = render(900, 500, 25)
    for (const t of texts.filter((x) => AIRSPACE_NAMES.includes(x.s))) {
      expect(t.x, t.s).toBeGreaterThan(0)
      expect(t.x, t.s).toBeLessThan(cam.width)
      expect(t.y, t.s).toBeGreaterThan(0)
      expect(t.y, t.s).toBeLessThan(cam.height)
    }
  })
})

describe('labels stay with their airspace when panning', () => {
  const AIRSPACE = [
    'LONDON TMA',
    'LONDON CTR',
    'STANSTED CTA',
    'LUTON CTR',
    'LUTON CTA',
    'GATWICK CTR',
    'GATWICK CTA',
    'CITY CTA',
    'FARNBOROUGH CTR',
    'FARNBOROUGH CTA',
  ]

  function renderCentred(centre: { x: number; y: number }, rangeNM = 30) {
    const cam = new Camera(centre, rangeNM, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, STATUS)
    return { ...rec, cam }
  }

  it('moves labels with the world rather than holding them still', () => {
    const before = renderCentred({ x: 0, y: 0 })
    const after = renderCentred({ x: 2, y: 0 })
    // Panning the camera 2 NM east moves the picture left by 2 NM of pixels.
    const expected = -2 * before.cam.pxPerNM

    let compared = 0
    for (const name of AIRSPACE) {
      const a = before.texts.find((t) => t.s === name)
      const b = after.texts.find((t) => t.s === name)
      if (!a || !b) continue
      compared += 1
      expect(Math.abs(b.x - a.x - expected), name).toBeLessThan(8)
    }
    expect(compared, 'labels compared across the pan').toBeGreaterThan(2)
  })

  it('drops a label rather than parking it against the edge', () => {
    // This is the fault being guarded: clamping an off-screen anchor into
    // the viewport made labels slide along the edge as the scope panned, so
    // they appeared to follow the view instead of staying with their
    // airspace. Nothing should end up hugging the border.
    for (const centre of [
      { x: 60, y: 0 },
      { x: -60, y: 0 },
      { x: 0, y: 60 },
      { x: 0, y: -60 },
    ]) {
      const { texts, cam } = renderCentred(centre)
      for (const t of texts.filter((x) => AIRSPACE.includes(x.s))) {
        expect(t.x, `${t.s} at ${centre.x},${centre.y}`).toBeGreaterThan(4)
        expect(t.x, `${t.s} at ${centre.x},${centre.y}`).toBeLessThan(cam.width - 4)
        expect(t.y, `${t.s} at ${centre.x},${centre.y}`).toBeGreaterThan(4)
        expect(t.y, `${t.s} at ${centre.x},${centre.y}`).toBeLessThan(cam.height - 4)
      }
    }
  })

  it('shows fewer airspace labels the further the field is from view', () => {
    // A sanity check on the same property: pan away and labels go, because
    // the airspace they name has gone.
    const near = renderCentred({ x: 0, y: 0 })
    const far = renderCentred({ x: 120, y: 120 })
    const count = (r: { texts: { s: string }[] }): number =>
      r.texts.filter((t) => AIRSPACE.includes(t.s)).length
    expect(count(far)).toBeLessThan(count(near))
  })
})

describe('labels hold still while zooming', () => {
  const NAMES = [
    'LONDON TMA',
    'LONDON CTR',
    'STANSTED CTA',
    'LUTON CTR',
    'LUTON CTA',
    'GATWICK CTR',
    'GATWICK CTA',
    'CITY CTA',
    'FARNBOROUGH CTR',
    'FARNBOROUGH CTA',
  ]
  const ZOOMS = [10, 14, 20, 26, 32, 40, 55]

  /** Pairs each name label with the limits drawn directly beneath it. */
  function bandsByName(texts: { s: string; x: number; y: number }[]) {
    const out = new Map<string, Set<string>>()
    for (const t of texts) {
      if (!NAMES.includes(t.s)) continue
      const limits = texts.find(
        (o) => o !== t && Math.abs(o.x - t.x) < 0.01 && o.y > t.y && o.y - t.y < 12,
      )
      if (!limits) continue
      const set = out.get(t.s) ?? new Set<string>()
      set.add(limits.s)
      out.set(t.s, set)
    }
    return out
  }

  it('never shows a different band of the same airspace at a different zoom', () => {
    // The reported fault. Farnborough has nine bands; when the count of
    // labels actually drawn was the limit, a band dropped for want of room
    // let another take its place, and since what collides changes with zoom
    // the label appeared somewhere else as the scope was zoomed.
    const perZoom = ZOOMS.map((z) => bandsByName(render(1000, 600, z).texts))

    for (const name of NAMES) {
      const seen = new Set<string>()
      for (const bands of perZoom) {
        for (const b of bands.get(name) ?? []) seen.add(b)
      }
      // At most the two eligible bands, and always the same two.
      expect(seen.size, `${name} showed bands ${[...seen].join(', ')}`).toBeLessThanOrEqual(2)
    }
  })

  it('anchors every label on its own airspace, not on the viewport', () => {
    // Independently recompute the centroids the renderer should be using,
    // and require every drawn label to sit on one of them, offset only
    // vertically by a whole number of label heights.
    const centroids = airport.airspace.flatMap((v) => {
      if (v.shape.kind === 'circle') return [v.shape.centreNM]
      const all =
        v.shape.kind === 'polygon' ? v.shape.verticesNM : v.shape.pathsNM.flat()
      if (all.length === 0) return []
      let sx = 0
      let sy = 0
      for (const p of all) {
        sx += p.x
        sy += p.y
      }
      return [{ x: sx / all.length, y: sy / all.length }]
    })

    for (const z of ZOOMS) {
      const { texts, cam } = render(1000, 600, z)
      const screens = centroids.map((c) => cam.worldToScreen(c))
      for (const t of texts.filter((x) => NAMES.includes(x.s))) {
        const match = screens.some(
          (s) => Math.abs(s.x - t.x) < 0.01 && t.y - s.y >= -4 && t.y - s.y < 70,
        )
        expect(match, `${t.s} at zoom ${z} is not on any airspace centre`).toBe(true)
      }
    }
  })

  it('keeps each band on the same airspace centre across zoom levels', () => {
    // Keyed by band, not by name: different bands of one airspace have
    // different centres, so comparing "the Stansted label" across zooms
    // compares two different volumes. The invariant is that a given band
    // never moves.
    const worldOf = (range: number): Map<string, { x: number; y: number }> => {
      const { texts, cam } = render(1000, 600, range)
      const m2 = new Map<string, { x: number; y: number }>()
      for (const t2 of texts.filter((x) => NAMES.includes(x.s))) {
        const limits = texts.find(
          (o) => o !== t2 && Math.abs(o.x - t2.x) < 0.01 && o.y > t2.y && o.y - t2.y < 12,
        )
        if (!limits) continue
        m2.set(`${t2.s}|${limits.s}`, cam.screenToWorld({ x: t2.x, y: t2.y }))
      }
      return m2
    }

    const a = worldOf(20)
    const b = worldOf(40)
    let compared = 0
    for (const [band, pa] of a) {
      const pb = b.get(band)
      if (!pb) continue
      compared += 1
      // The vertical slot offset is in pixels, so it covers slightly
      // different ground at different scales; the anchor itself must not
      // have moved.
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y), band).toBeLessThan(4)
    }
    expect(compared, 'bands compared across zooms').toBeGreaterThan(2)
  })
})

describe('the clock and rate readouts', () => {
  function withStatus(status: ScopeStatus) {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, status)
    return rec.texts.map((t) => t.s)
  }

  it('shows simulated time of day, not the wall clock', () => {
    const labels = withStatus({
      ...STATUS,
      clock: { ticks: 1200, elapsedSeconds: 60, timeOfDaySeconds: 13 * 3600 + 61 },
      speed: 1,
      paused: false,
      traffic: { spawned: 0, held: 0, landed: 0, left: 0, points: 0 },
  controller: null,
  airspaceEnforced: true,
  weather: CALM,
    })
    expect(labels).toContain('TIME')
    expect(labels).toContain('13:01:01')
  })

  it('shows the active rate', () => {
    for (const [speed, shown] of [
      [0.5, 'x0.5'],
      [1, 'x1'],
      [2, 'x2'],
      [4, 'x4'],
    ] as const) {
      const labels = withStatus({
      ...STATUS,
        clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 0 },
        speed,
        paused: false,
        traffic: { spawned: 0, held: 0, landed: 0, left: 0, points: 0 },
  controller: null,
  airspaceEnforced: true,
  weather: CALM,
      })
      expect(labels, `x${speed}`).toContain('RATE')
      expect(labels, `x${speed}`).toContain(shown)
    }
  })

  it('says PAUSED rather than a rate when stopped', () => {
    // Otherwise a paused scope showing x4 invites the obvious mistake.
    const labels = withStatus({
      ...STATUS,
      clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 0 },
      speed: 4,
      paused: true,
      traffic: { spawned: 0, held: 0, landed: 0, left: 0, points: 0 },
  controller: null,
  airspaceEnforced: true,
  weather: CALM,
    })
    expect(labels).toContain('PAUSED')
    expect(labels).not.toContain('x4')
  })
})

describe('the traffic readout', () => {
  it('shows what has been released and what is being held', () => {
    // The held count is how the spacing rule explains itself: an arrival
    // due but with no clear fix is a held one, not a missing one.
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1200, 700)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, {
      ...STATUS,
      clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 0 },
      speed: 1,
      paused: false,
      traffic: { spawned: 7, held: 3, landed: 2, left: 1, points: 150 },
      controller: null,
      airspaceEnforced: true,
      weather: CALM,
    })
    const labels = rec.texts.map((t) => t.s)
    expect(labels).toContain('TRAFFIC')
    expect(labels).toContain('7 HELD 3')
  })
})

describe('the map underneath', () => {
  // The coastline and the FIR limit are drawn from real line work, so the
  // checks are geometric: the right colour, in the right place, and not
  // projected at all when none of it can be on screen.

  const coastStrokes = (r: { strokes: Stroke[] }, palette = palettes.beige): Stroke[] =>
    r.strokes.filter((s) => s.style === palette.coast)
  const firStrokes = (r: { strokes: Stroke[] }, palette = palettes.beige): Stroke[] =>
    r.strokes.filter((s) => s.style === palette.fir)

  it('draws the coastline once the scope is wide enough to reach it', () => {
    const wide = render(1000, 600, 80)
    const strokes = coastStrokes(wide)
    expect(strokes.length).toBeGreaterThan(0)
    // A shoreline, not a straight line: the paths carry real detail.
    expect(strokes.reduce((n, s) => n + s.points.length, 0)).toBeGreaterThan(100)
  })

  it('draws the FIR boundary heavier than the shoreline', () => {
    // One is an airspace limit and the other is a backdrop, so they must
    // not read as the same kind of line.
    const wide = render(1000, 600, 80)
    const coast = coastStrokes(wide)[0]
    const fir = firStrokes(wide)[0]
    expect(coast).toBeDefined()
    expect(fir).toBeDefined()
    expect(fir?.width).toBeGreaterThan(Number(coast?.width))
  })

  it('puts the south coast south of the field', () => {
    // Beachy Head, through the same projection and camera the scope uses.
    const wide = render(1000, 600, 80)
    const head = wide.cam.worldToScreen(
      airport.projection.toWorld({ lat: 50.737, lon: 0.246 }),
    )
    const field = wide.cam.worldToScreen({ x: 0, y: 0 })
    expect(head.y).toBeGreaterThan(field.y)

    let nearest = Infinity
    for (const s of coastStrokes(wide)) {
      for (const p of s.points) {
        nearest = Math.min(nearest, Math.hypot(p.x - head.x, p.y - head.y))
      }
    }
    // The drawn line passes within a few pixels of a real headland, which
    // is the whole pipeline -- lat/lon to world to screen -- in one check.
    expect(nearest).toBeLessThan(8)
  })

  it('projects nothing that cannot be on screen', () => {
    // Zoomed onto the runway, every coastline and FIR chunk is rejected by
    // its bounding box rather than transformed point by point.
    const close = render(1000, 600, 2, { ...OVERLAY_PRESETS.full, rivers: false })
    expect(coastStrokes(close)).toHaveLength(0)
    expect(firStrokes(close)).toHaveLength(0)
  })

  it('keeps the Thames even at close range, because it is genuinely there', () => {
    // The river passes within a few miles of the field, so unlike the coast
    // it survives the cull zoomed right in -- which is most of why it is
    // worth drawing.
    const close = render(1000, 600, 4, {
      ...OVERLAY_PRESETS.full,
      coastline: false,
    })
    expect(coastStrokes(close).length).toBeGreaterThan(0)
  })

  it('draws the Thames at its real width, widening downstream', () => {
    // The estuary is over a kilometre across and the upper river is 60 m,
    // so a river drawn at one width everywhere is throwing away the most
    // recognisable thing about it.
    const wide = render(1000, 600, 60, { ...OVERLAY_PRESETS.full, coastline: false })
    const river = coastStrokes(wide)
    expect(river.length).toBeGreaterThan(1)

    // Widest run should be well east of the narrowest: width grows towards
    // the sea.
    const midX = (s: Stroke) =>
      s.points.reduce((n, p) => n + p.x, 0) / s.points.length
    const widest = river.reduce((a, b) => (b.width > a.width ? b : a))
    const narrowest = river.reduce((a, b) => (b.width < a.width ? b : a))
    expect(widest.width).toBeGreaterThan(narrowest.width)
    expect(midX(widest)).toBeGreaterThan(midX(narrowest))
  })

  it('scales the river width with the zoom', () => {
    // It is a real width in nautical miles, not a line weight, so zooming in
    // makes the estuary wider on screen.
    const widthAt = (rangeNM: number): number => {
      const r = render(1000, 600, rangeNM, { ...OVERLAY_PRESETS.full, coastline: false })
      return Math.max(...coastStrokes(r).map((s) => s.width))
    }
    expect(widthAt(20)).toBeGreaterThan(widthAt(60))
  })

  it('never draws the upper river thinner than a hairline', () => {
    // Zoomed out, a true-width Thames at Windsor is a fraction of a pixel.
    const out = render(1000, 600, 80, { ...OVERLAY_PRESETS.full, coastline: false })
    for (const s of coastStrokes(out)) expect(s.width).toBeGreaterThanOrEqual(1)
  })

  it('switches each layer independently', () => {
    // The river shares the coastline's colour -- it is water -- so proving
    // the switches are separate means turning them off one at a time.
    const noWater = render(1000, 600, 80, {
      ...OVERLAY_PRESETS.full,
      coastline: false,
      rivers: false,
    })
    expect(coastStrokes(noWater)).toHaveLength(0)
    expect(firStrokes(noWater).length).toBeGreaterThan(0)

    // Coast off but river on: whatever is left in the water colour is the
    // Thames, so the river has its own switch and is not riding on the
    // coastline's.
    const riverOnly = render(1000, 600, 80, { ...OVERLAY_PRESETS.full, coastline: false })
    expect(riverOnly.strokes.length).toBeGreaterThan(noWater.strokes.length)
    expect(coastStrokes(riverOnly).length).toBeGreaterThan(0)

    const noFir = render(1000, 600, 80, { ...OVERLAY_PRESETS.full, firBoundary: false })
    expect(firStrokes(noFir)).toHaveLength(0)
    expect(coastStrokes(noFir).length).toBeGreaterThan(0)
  })

  it('leaves the whole map out of the minimal picture', () => {
    const minimal = render(1000, 600, 80, OVERLAY_PRESETS.minimal)
    expect(coastStrokes(minimal)).toHaveLength(0)
    expect(firStrokes(minimal)).toHaveLength(0)
  })

  it('follows the palette', () => {
    setPalette('dark')
    const wide = render(1000, 600, 80)
    expect(coastStrokes(wide, palettes.dark).length).toBeGreaterThan(0)
    expect(coastStrokes(wide, palettes.beige)).toHaveLength(0)
    setPalette('beige')
  })

  it('counts the new layers in the overlay readout', () => {
    // The total is read off OVERLAY_ITEMS, so it cannot go stale.
    const { labels } = render(1400, 800, 80)
    expect(labels.some((s) => s.includes(`/${OVERLAY_ITEMS.length}`))).toBe(true)
  })
})

/* ------------------------------------------------------------- traffic */

/**
 * The scope is wired to the simulation through one argument. These tests
 * are about that seam: given contacts, the radar picture must contain
 * them, and given none it must be exactly what it was before.
 */
describe('traffic on the scope', () => {
  function plane(over: Partial<Aircraft> = {}): Aircraft {
    return {
      callsign: 'BAW42',
      type: 'A320',
      wake: 'M',
      pos: { x: 8, y: 8 },
      altFt: 9000,
      hdg: 225,
      iasKts: 250,
      gsKts: 250,
      vsFpm: -1500,
      clearedHdg: 225,
      clearedAltFt: 5000,
      clearedSpdKts: 220,
      navMode: 'VECTOR',
      clearedApproach: null,
      hold: null,
      originFix: 'LAM',
      entered: true,
      trail: [
        { x: 9, y: 9 },
        { x: 10, y: 10 },
      ],
      trailAt: 0,
      spawnedAt: 0,
      ...over,
    }
  }

  function withTraffic(contacts: ScopeContacts) {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, STATUS, contacts)
    return { ...rec, cam, labels: rec.texts.map((t) => t.s) }
  }

  it('puts the callsign and level on the display', () => {
    const { labels } = withTraffic({ aircraft: [plane()], selected: null })
    expect(labels).toContain('BAW42')
    expect(labels).toContain('090v050')
  })

  it('draws the target where the coordinate pipeline says it is', () => {
    const r = withTraffic({ aircraft: [plane({ pos: { x: 8, y: 8 } })] as Aircraft[], selected: null })
    const p = r.cam.worldToScreen({ x: 8, y: 8 })
    const block = at(r.texts, 'BAW42')
    // The block sits beside the target, not somewhere else on the scope.
    expect(Math.hypot(block.x - p.x, block.y - p.y)).toBeLessThan(40)
  })

  it('shows nothing extra on an empty scope', () => {
    const empty = withTraffic({ aircraft: [], selected: null })
    const none = render(1000, 600, 30)
    expect(empty.labels).toEqual(none.labels)
  })

  it('draws traffic above the airspace it is flying through', () => {
    // The callsign is written after the airspace labels, so it cannot be
    // hidden underneath one.
    const r = withTraffic({ aircraft: [plane()], selected: null })
    const callsign = r.texts.findIndex((t) => t.s === 'BAW42')
    const airspace = r.texts.findIndex((t) => t.s.includes('CTA') || t.s.includes('TMA'))
    expect(callsign).toBeGreaterThan(-1)
    if (airspace > -1) expect(callsign).toBeGreaterThan(airspace)
  })
})

describe('hold patterns', () => {
  // The racetrack is stroked in the hold colour, and so is the stub it
  // stands in for, so the two are told apart by shape: a stub is two points
  // and a racetrack is a couple of dozen.
  const holdStrokes = (r: { strokes: Stroke[] }) =>
    r.strokes.filter((s) => s.style === palettes.beige.hold)
  const racetracks = (r: { strokes: Stroke[] }) =>
    holdStrokes(r).filter((s) => s.points.length > 8)
  const stubs = (r: { strokes: Stroke[] }) =>
    holdStrokes(r).filter((s) => s.points.length === 2)

  it('draws one racetrack per holding fix', () => {
    const { cam, ...rest } = render(1000, 600, 30)
    void cam
    expect(racetracks(rest)).toHaveLength(airport.holdingFixes.length)
  })

  it('hangs the pattern off its fix', () => {
    // Every point of the ring is within a few miles of the fix it belongs
    // to, which is what catches a pattern drawn about the wrong point.
    const r = render(1000, 600, 30)
    const fixes = airport.holdingFixes.map((f) => r.cam.worldToScreen(f.posNM))
    for (const ring of racetracks(r)) {
      const near = fixes.some((f) =>
        ring.points.every((p) => Math.hypot(p.x - f.x, p.y - f.y) < r.cam.nmToPx(7)),
      )
      expect(near).toBe(true)
    }
  })

  it('re-strokes the inbound leg heavier than the ring', () => {
    // With two parallel legs, which one is flown towards the fix is the
    // only thing that says which way round the pattern goes.
    const r = render(1000, 600, 30)
    const ring = racetracks(r)[0]
    const leg = stubs(r)[0]
    expect(ring).toBeDefined()
    expect(leg).toBeDefined()
    expect(Number(leg?.width)).toBeGreaterThan(Number(ring?.width))
  })

  it('puts the fix symbol on top of its own pattern', () => {
    // Drawn before the navaids, so the hexagon is not buried.
    const r = render(1000, 600, 30)
    const firstRing = r.strokes.findIndex((s) => s.style === palettes.beige.hold && s.points.length > 8)
    const firstNavaid = r.strokes.findIndex((s) => s.style === palettes.beige.navaid)
    expect(firstRing).toBeGreaterThanOrEqual(0)
    expect(firstNavaid).toBeGreaterThan(firstRing)
  })

  it('switches off from the overlay menu', () => {
    const off = render(1000, 600, 30, { ...OVERLAY_PRESETS.full, holdPatterns: false })
    expect(racetracks(off)).toHaveLength(0)
  })

  it('falls back to the stub when the pattern is off', () => {
    // The inbound direction stays readable either way: the fix never loses
    // its mark entirely.
    const off = render(1000, 600, 30, { ...OVERLAY_PRESETS.full, holdPatterns: false })
    expect(stubs(off)).toHaveLength(airport.holdingFixes.length)
  })

  it('falls back to the stub when zoomed too far out to draw one', () => {
    // A 3.7 NM leg at the zoom ceiling is a handful of pixels, and a
    // squashed oval reads worse than a stub.
    const out = render(1000, 600, 80)
    expect(racetracks(out)).toHaveLength(0)
    expect(stubs(out)).toHaveLength(airport.holdingFixes.length)
  })

  it('keeps the holds out of the minimal picture entirely', () => {
    const minimal = render(1000, 600, 30, OVERLAY_PRESETS.minimal)
    expect(racetracks(minimal)).toHaveLength(0)
  })

  it('follows the palette', () => {
    setPalette('dark')
    const r = render(1000, 600, 30)
    expect(r.strokes.some((s) => s.style === palettes.dark.hold && s.points.length > 8)).toBe(true)
    setPalette('beige')
  })
})

describe('a vector being dragged', () => {
  function plane(over: Partial<Aircraft> = {}): Aircraft {
    return {
      callsign: 'BAW42',
      type: 'A320',
      wake: 'M',
      pos: { x: 6, y: 6 },
      altFt: 9000,
      hdg: 225,
      iasKts: 250,
      gsKts: 250,
      vsFpm: 0,
      clearedHdg: 225,
      clearedAltFt: 9000,
      clearedSpdKts: 220,
      navMode: 'VECTOR',
      clearedApproach: null,
      hold: null,
      originFix: 'LAM',
      entered: true,
      trail: [],
      trailAt: 0,
      spawnedAt: 0,
      ...over,
    }
  }

  const draw = (contacts: ScopeContacts) => {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, STATUS, contacts)
    return { ...rec, cam, labels: rec.texts.map((t) => t.s) }
  }

  it('puts the readout on the display while the drag is live', () => {
    const a = plane()
    const r = draw({ aircraft: [a], selected: a.callsign, drag: { aircraft: a, toPx: { x: 800, y: 150 } } })
    expect(r.labels.some((s) => /^\d{3}.* NM$/.test(s))).toBe(true)
  })

  it('draws nothing extra when no drag is in progress', () => {
    const a = plane()
    const withDrag = draw({ aircraft: [a], selected: null, drag: { aircraft: a, toPx: { x: 800, y: 150 } } })
    const without = draw({ aircraft: [a], selected: null })
    expect(withDrag.labels.length).toBeGreaterThan(without.labels.length)
    expect(without.labels.some((s) => /^\d{3}.* NM$/.test(s))).toBe(false)
  })

  it('treats an omitted drag and an explicit null the same', () => {
    const a = plane()
    const omitted = draw({ aircraft: [a], selected: null })
    const explicit = draw({ aircraft: [a], selected: null, drag: null })
    expect(explicit.labels).toEqual(omitted.labels)
  })

  it('draws the line above the traffic, so it is readable over a target', () => {
    const a = plane()
    const b = plane({ callsign: 'VIR9', pos: { x: 8, y: 8 } })
    const r = draw({
      aircraft: [a, b],
      selected: a.callsign,
      drag: { aircraft: a, toPx: { x: 700, y: 120 } },
    })
    const readout = r.texts.findIndex((t) => /^\d{3}.* NM$/.test(t.s))
    const block = r.texts.findIndex((t) => t.s === 'VIR9')
    expect(readout).toBeGreaterThan(-1)
    expect(block).toBeGreaterThan(-1)
    expect(readout).toBeGreaterThan(block)
  })
})

describe('the departures readout', () => {
  const draw = (landed: number, left: number) => {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1400, 800)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, {
      ...STATUS,
      traffic: { spawned: 20, held: 4, landed, left, points: landed * 100 - left * 50 },
    })
    return rec.texts.map((t) => t.s)
  }

  it('shows both numbers, because one without the other says nothing', () => {
    // Twelve landings means something different alongside one that got away
    // than alongside nine.
    const labels = draw(12, 3)
    expect(labels).toContain('LANDED')
    expect(labels.some((s) => s.includes('12') && s.includes('LOST') && s.includes('3'))).toBe(true)
  })

  it('reads zero and zero at the start of a session', () => {
    expect(draw(0, 0).some((s) => /^0 LOST 0$/.test(s))).toBe(true)
  })
})

describe('the area of responsibility', () => {
  const draw = (rangeNM = 60) => {
    const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, STATUS)
    return { ...rec, cam }
  }

  it('washes the map outside the boundary back towards the ground', () => {
    // Only one part of the map is the controller's, and the display should
    // say which without hiding the rest.
    // Specifically a partial-strength fill in the GROUND colour: other
    // layers use alpha of their own, and none of them fills with the ground.
    const wash = draw().washes.find((w) => w.alpha < 1 && w.style === palettes.beige.bg)
    expect(wash).toBeDefined()
    expect((wash as { alpha: number }).alpha).toBeGreaterThan(0)
  })

  it('hands the canvas back opaque, or the traffic would be dimmed too', () => {
    expect(draw().alphaAtEnd()).toBe(1)
  })

  it('draws the boundary itself over the wash, not under it', () => {
    // It is the one line on the display that has to be unmistakable, so it
    // must not be the thing that gets dimmed.
    const r = draw()
    const washAt = r.washes.findIndex((w) => w.alpha < 1)
    expect(washAt).toBeGreaterThan(-1)
    // The boundary is a full-strength stroke, and there is at least one
    // stroke recorded after the wash was painted.
    expect(r.strokes.length).toBeGreaterThan(0)
  })

  it('follows the palette, so the wash is never the wrong ground', () => {
    setPalette('dark')
    const wash = draw().washes.find((w) => w.alpha < 1 && w.style === palettes.dark.bg)
    expect(wash).toBeDefined()
    setPalette('beige')
  })
})

describe('a session with the airspace rule switched off', () => {
  const draw = (airspaceEnforced: boolean) => {
    const cam = new Camera({ x: 0, y: 0 }, 60, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, { ...STATUS, airspaceEnforced })
    return rec
  }

  const groundWash = (rec: ReturnType<typeof draw>) =>
    rec.washes.find((w) => w.alpha < 1 && w.style === palettes.beige.bg)

  it('draws the map whole, with nothing dimmed', () => {
    // There is no boundary to be on the wrong side of, so nothing should
    // look like it is somebody else's.
    expect(groundWash(draw(true))).toBeDefined()
    expect(groundWash(draw(false))).toBeUndefined()
  })

  it('still draws the boundary, which is useful either way', () => {
    // Knowing where the airspace is remains worth knowing, even in a
    // session that does not enforce it.
    const sizes = new Set(airport.controlFootprint.map((ring) => ring.length))
    expect(draw(false).strokes.some((s) => sizes.has(s.points.length))).toBe(true)
  })

  it('hands the canvas back opaque either way', () => {
    expect(draw(false).alphaAtEnd()).toBe(1)
    expect(draw(true).alphaAtEnd()).toBe(1)
  })
})

describe('the weather layer', () => {
  const STORMY = makeWeather(makeRng(4), {
    wind: { fromDeg: 250, speedKts: 20 },
    cellsPerHour: 12,
    minLifeMinutes: 20,
    maxLifeMinutes: 40,
    heavyChance: 0.5,
    minRadiusNM: 5,
    maxRadiusNM: 9,
    driftFactor: 0.8,
    driftSpreadDeg: 30,
    driftSpeedSpread: 0.35,
    shapeDriftDegPerMin: 6,
    spreadNM: 15,
  })

  const draw = (weather = STORMY, overlays = OVERLAY_PRESETS.full) => {
    const cam = new Camera({ x: 0, y: 0 }, 60, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, overlays, { ...STATUS, weather })
    return rec
  }

  /** The weather is the only thing filled at partial strength in a colour. */
  const cellFills = (rec: ReturnType<typeof draw>) =>
    rec.washes.filter((w) => w.alpha > 0 && w.alpha < 0.5)

  it('draws the cells when the layer is on', () => {
    expect(cellFills(draw()).length).toBeGreaterThan(0)
  })

  it('draws none of it when the layer is off', () => {
    const off = draw(STORMY, { ...OVERLAY_PRESETS.full, weather: false })
    expect(cellFills(off)).toHaveLength(0)
  })

  it('is on in every preset, because it is weather and not decoration', () => {
    for (const name of ['minimal', 'standard', 'full'] as const) {
      expect(OVERLAY_PRESETS[name].weather, name).toBe(true)
    }
  })

  it('hands the canvas back opaque with the cells drawn', () => {
    expect(draw().alphaAtEnd()).toBe(1)
  })
})

describe('the runway configuration', () => {
  const draw = (ids: readonly string[]) => {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.full, {
      ...STATUS,
      arrivalRunways: airport.runways.filter((r) => ids.includes(r.id)),
    })
    return rec.texts.map((t) => t.s)
  }

  it('draws a localiser for each runway being landed on', () => {
    const labels = draw(['27R', '27L'])
    expect(labels).toContain('FAF 27R')
    expect(labels).toContain('FAF 27L')
  })

  it('moves the localisers when the field turns round', () => {
    // The whole point of the ATIS being the authority rather than the
    // config: a beam left drawn on a runway nobody is landing on is how a
    // controller ends up vectoring to the wrong end of the field.
    const labels = draw(['09L', '09R'])
    expect(labels).toContain('FAF 09L')
    expect(labels).toContain('FAF 09R')
    expect(labels).not.toContain('FAF 27R')
    expect(labels).not.toContain('FAF 27L')
  })

  it('draws none at all when nothing is landing', () => {
    const labels = draw([])
    expect(labels.some((s) => s.startsWith('FAF'))).toBe(false)
  })

  it('names the runways in use on the status bar', () => {
    expect(draw(['09L', '09R'])).toContain('09L/09R')
    expect(draw(['27R', '27L'])).toContain('27R/27L')
  })

  it('says so on the status bar when the field is landing nothing', () => {
    // Rather than an empty cell, which reads as a display fault.
    expect(draw([])).toContain('--')
  })
})

describe('the flat idiom', () => {
  // `tracon` is the one scheme that is not period furniture. The colours are
  // covered by the contrast bands in theme.test.ts; what matters here is the
  // structural difference, which no colour can express.
  beforeEach(() => {
    setPalette('traconDark')
  })

  const flat = () => render(1000, 600, 30)

  it('is what the display ships in', () => {
    expect(PALETTE_ORDER[0]).toBe('traconDark')
    expect(palettes.traconDark.chromeStyle).toBe('flat')
  })

  it('paints the ground in the modern slate rather than black', () => {
    // Black is right for a CRT and wrong for an LCD in a dimmed room, where
    // it goes grey anyway and takes the contrast with it.
    expect(flat().fills[0]).toBe(palettes.traconDark.bg)
  })

  it('draws panels with a hairline instead of a bevel', () => {
    // One fill and one edge colour. Neither of the other two appears: the
    // shadow is the bottom-right of a bevel, and the well is a sunken cell
    // -- and a flat table has no sunken cells, only dividers.
    const { fills } = flat()
    expect(fills).toContain(palettes.traconDark.chromeFace)
    expect(fills).toContain(palettes.traconDark.chromeLight)
    expect(fills).not.toContain(palettes.traconDark.chromeShadow)
    expect(fills).not.toContain(palettes.traconDark.chromeWell)
  })

  it('still bevels the schemes that are meant to be bevelled', () => {
    // The switch is per scheme, so the period look has to survive it.
    setPalette('beige')
    const { fills } = flat()
    expect(fills).toContain(palettes.beige.chromeShadow)
    expect(fills).toContain(palettes.beige.chromeLight)
  })

  it('frames the display with one line rather than a sunken edge', () => {
    // A modern display is a rectangle of glass in a bezel, not a window
    // recessed into a desktop.
    const { fills } = flat()
    const shadowUsed = fills.filter((f) => f === palettes.traconDark.chromeShadow)
    expect(shadowUsed).toHaveLength(0)
  })

  it('keeps the traffic the brightest thing on it by a wide margin', () => {
    // The whole look: one bright ink for data over a very quiet map.
    const contrast = (hex: string): number => {
      const lum = (h: string): number => {
        const n = parseInt(h.slice(1), 16)
        const c = (v: number): number => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255)
      }
      const a = lum(hex)
      const b = lum(palettes.traconDark.bg)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    expect(contrast(palettes.traconDark.target)).toBeGreaterThan(10)
    expect(contrast(palettes.traconDark.coast)).toBeLessThan(2)
    expect(contrast(palettes.traconDark.ring)).toBeLessThan(2)
  })

  it('still draws the whole picture', () => {
    // A scheme missing a colour would throw, or silently draw nothing.
    const { labels } = flat()
    expect(labels).toContain('EGLL APPROACH')
    for (const n of ['LAM', 'BIG', 'BNN', 'OCK']) expect(labels).toContain(n)
    expect(labels).toContain('27R')
  })
})
describe('the flat readouts', () => {
  // The furniture, not the paint. A modern position arranges its readouts
  // as a ruled table hard against the glass, not as bevelled cells floating
  // with a margin round them.
  beforeEach(() => {
    setPalette('traconDark')
  })

  /**
   * The HUD rows along the bottom.
   *
   * Picked out by finding the shared baselines with several labels on them,
   * because map labels -- an aerodrome code, a navaid name -- can land in
   * the same band and must not be mistaken for readouts.
   */
  function hudRows(w = 1000, h = 600): { y: number; cells: Text[] }[] {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(w, h)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.standard, STATUS)

    const byRow = new Map<number, Text[]>()
    for (const t of rec.texts) {
      if (t.y < h - 34) continue
      const y = Math.round(t.y)
      byRow.set(y, [...(byRow.get(y) ?? []), t])
    }
    return [...byRow.entries()]
      .filter(([, cells]) => cells.length >= 5)
      .map(([y, cells]) => ({ y, cells: [...cells].sort((a, b) => a.x - b.x) }))
      .sort((a, b) => a.y - b.y)
  }

  it('sets a heading over every value', () => {
    // Two rows: the word that names the readout, and the readout under it.
    // Reading down beats reading sideways from a label beside a number.
    const rows = hudRows()
    expect(rows).toHaveLength(2)
    const [heads, values] = rows
    expect(values?.cells.length).toBe(heads?.cells.length)
    // Each pair shares a left edge, which is what makes it a column.
    heads?.cells.forEach((head, i) => {
      expect(values?.cells[i]?.x).toBeCloseTo(head.x, 6)
    })
  })

  it('names the columns and shows the values under them', () => {
    const rows = hudRows()
    expect(rows[0]?.cells.slice(0, 4).map((c) => c.s)).toEqual([
      'TIME',
      'SCORE',
      'RATE',
      'RANGE',
    ])
    expect(rows[1]?.cells[0]?.s).toBe('12:00:00')
  })

  it('runs the table the whole width of the glass', () => {
    // Flush, not inset: the period bar leaves ten pixels of ground either
    // side and this does not.
    expect(Number(hudRows()[0]?.cells[0]?.x)).toBeLessThan(12)
  })

  it('drops columns from the right when the window narrows', () => {
    const wide = hudRows(1000)[0]?.cells.map((c) => c.s) ?? []
    const narrow = hudRows(360)[0]?.cells.map((c) => c.s) ?? []
    expect(narrow.length).toBeGreaterThan(0)
    expect(narrow.length).toBeLessThan(wide.length)
    // What survives is a prefix of what fitted: the clock outlives the
    // airspace provenance, which is the right way round.
    expect(wide.slice(0, narrow.length)).toEqual(narrow)
    expect(narrow).toContain('TIME')
  })

  it('puts the position hard into the corner', () => {
    const cam = new Camera({ x: 0, y: 0 }, 30, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawScope(rec.ctx, cam, airport, OVERLAY_PRESETS.standard, {
      ...STATUS,
      controller: { initials: 'NF', position: 'EGLL_APP' },
    })
    const title = rec.texts.find((t) => t.s === 'EGLL APPROACH')
    const who = rec.texts.find((t) => t.s === 'EGLL_APP  NF')
    expect(title).toBeDefined()
    expect(who).toBeDefined()
    // The period block is inset ten pixels and starts nineteen in; this is
    // flush to the frame.
    expect(Number(title?.x)).toBeLessThan(12)
    expect(Number(title?.y)).toBeLessThan(8)
    expect(Number(who?.y)).toBeGreaterThan(Number(title?.y))
  })

  it('leaves the period bar alone', () => {
    // The two idioms are different furniture, not one with a flag: beige
    // keeps its single row of inset bevelled cells.
    setPalette('beige')
    expect(hudRows()).toHaveLength(1)
  })
})
