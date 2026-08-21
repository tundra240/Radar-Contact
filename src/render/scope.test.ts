import { afterEach, describe, expect, it } from 'vitest'
import { Camera } from '../core/camera'
import { loadAirport, runwayScaleAt } from '../data/airport'
import raw from '../data/egll.json'
import { drawScope } from './scope'
import { OVERLAY_PRESETS, type Overlays } from './overlays'
import { palettes, setPalette } from './theme'

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
  drawScope(rec.ctx, cam, airport, overlays)
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
