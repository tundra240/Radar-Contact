import { describe, expect, it } from 'vitest'
import { Camera } from '../core/camera'
import { loadAirport, runwayScaleAt } from '../data/airport'
import raw from '../data/egll.json'
import { drawScope } from './scope'

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
} {
  const texts: Text[] = []
  const arcs: Arc[] = []
  const dashes: number[][] = []
  const noop = (): void => {}
  const stub = {
    fillRect: noop,
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
  return { ctx: stub as unknown as CanvasRenderingContext2D, texts, arcs, dashes }
}

const airport = loadAirport(raw)

function render(w = 1000, h = 600, rangeNM = 30) {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM)
  cam.setViewport(w, h)
  const rec = recorder()
  drawScope(rec.ctx, cam, airport)
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

  it('anchors a zone on the aerodrome it belongs to', () => {
    // GATWICK CTR is defined by centreAirport, so its circle must sit on
    // Gatwick rather than on the field being controlled.
    const { arcs, texts } = render()
    const gatwick = at(texts, 'EGKK')
    const ctr = arcs.find((a) => Math.round(a.r) === 80)
    expect(ctr).toBeDefined()
    if (!ctr) return
    expect(ctr.x).toBeCloseTo(gatwick.x, 0)
  })

  it('dashes approximate boundaries and leaves rule-derived ones solid', () => {
    const { dashes } = render(1000, 600, 8)
    expect(dashes.some((d) => d.length > 0)).toBe(true)
    expect(dashes.some((d) => d.length === 0)).toBe(true)
  })

  it('says on the display which boundaries are approximate', () => {
    expect(render().labels.some((s) => s.includes('approximate'))).toBe(true)
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

  it('reports the current magnification on the display', () => {
    expect(render().labels.some((s) => s.includes('RWY x'))).toBe(true)
  })
})
