import { afterEach, describe, expect, it } from 'vitest'
import { Camera } from '../core/camera'
import { loadAirport, runwayScaleAt } from '../data/airport'
import raw from '../data/egll.json'
import { drawScope } from './scope'
import { OVERLAY_PRESETS, type Overlays } from './overlays'
import type { ScopeStatus } from './scope'
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

function recorder(): {
  ctx: CanvasRenderingContext2D
  texts: Text[]
  arcs: Arc[]
  dashes: number[][]
  fills: string[]
} {
  const texts: Text[] = []
  const arcs: Arc[] = []
  const dashes: number[][] = []
  const fills: string[] = []
  const noop = (): void => {}
  const stub: Record<string, unknown> = {
    fillRect: () => {
      fills.push(String(stub["fillStyle"]))
    },
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
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
  return { ctx: stub as unknown as CanvasRenderingContext2D, texts, arcs, dashes, fills }
}

const airport = loadAirport(raw)

// A settled clock, so the status bar has something to show without the
// tests needing a running loop.
const STATUS: ScopeStatus = {
  clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 12 * 3600 },
  speed: 1,
  paused: false,
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
    const { labels, arcs } = render(1000, 600, 30, OVERLAY_PRESETS.minimal)
    expect(labels).toContain('27R')
    expect(labels).toContain('27L')
    for (const hold of ['LAM', 'BIG', 'BNN', 'OCK']) {
      expect(labels, hold).toContain(hold)
    }
    // 40 NM sector boundary at 10 px per NM.
    expect(arcs.some((a) => Math.round(a.r) === 400)).toBe(true)
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

  it('turns range rings off without losing the sector boundary', () => {
    const { arcs } = render(1000, 600, 30, only({ rangeRings: false }))
    expect(arcs.some((a) => Math.round(a.r) === 400)).toBe(true)
    expect(arcs.some((a) => Math.round(a.r) === 100)).toBe(false)
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
      clock: { ticks: 1200, elapsedSeconds: 60, timeOfDaySeconds: 13 * 3600 + 61 },
      speed: 1,
      paused: false,
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
        clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 0 },
        speed,
        paused: false,
      })
      expect(labels, `x${speed}`).toContain('RATE')
      expect(labels, `x${speed}`).toContain(shown)
    }
  })

  it('says PAUSED rather than a rate when stopped', () => {
    // Otherwise a paused scope showing x4 invites the obvious mistake.
    const labels = withStatus({
      clock: { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 0 },
      speed: 4,
      paused: true,
    })
    expect(labels).toContain('PAUSED')
    expect(labels).not.toContain('x4')
  })
})
