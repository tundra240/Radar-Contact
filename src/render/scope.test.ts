import { describe, expect, it } from 'vitest'
import { Camera } from '../core/camera'
import { loadAirport } from '../data/airport'
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

function recorder(): { ctx: CanvasRenderingContext2D; texts: Text[]; arcs: Arc[] } {
  const texts: Text[] = []
  const arcs: Arc[] = []
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
    setLineDash: noop,
    arc: (x: number, y: number, r: number) => {
      arcs.push({ x, y, r })
    },
    fillText: (s: string, x: number, y: number) => {
      texts.push({ s, x, y })
    },
    // Assigned-to properties need to exist but do nothing useful here.
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  }
  return { ctx: stub as unknown as CanvasRenderingContext2D, texts, arcs }
}

const airport = loadAirport(raw)

function render(w = 1000, h = 600, rangeNM = 30) {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM)
  cam.setViewport(w, h)
  const rec = recorder()
  drawScope(rec.ctx, cam, airport)
  return { ...rec, cam }
}

describe('drawScope', () => {
  it('draws without throwing and labels the sector', () => {
    const { texts } = render()
    expect(texts.some((t) => t.s === 'EGLL APPROACH')).toBe(true)
  })

  it('centres the range rings on the airport reference point', () => {
    const { arcs } = render()
    expect(arcs.length).toBeGreaterThan(0)
    for (const a of arcs) {
      expect(a.x).toBeCloseTo(500, 6)
      expect(a.y).toBeCloseTo(300, 6)
    }
  })

  it('scales the range rings to the configured radii', () => {
    const { arcs, cam } = render()
    // 600 / 2 / 30 = 10 px per NM, so the 5 NM ring has a 50 px radius.
    expect(cam.pxPerNM).toBeCloseTo(10, 9)
    const radii = arcs.map((a) => Math.round(a.r)).sort((a, b) => a - b)
    expect(radii).toContain(50)
    expect(radii).toContain(200)
  })

  it('labels all four holds and both arrival runways', () => {
    const { texts } = render()
    const labels = texts.map((t) => t.s)
    for (const name of ['LAM', 'BIG', 'BNN', 'OCK', '27R', '27L']) {
      expect(labels, name).toContain(name)
    }
  })

  it('draws 27R north of 27L on screen', () => {
    // The whole point of the y-flip living in the camera: north must be up.
    const { texts } = render()
    const r = texts.find((t) => t.s === '27R')
    const l = texts.find((t) => t.s === '27L')
    expect(r).toBeDefined()
    expect(l).toBeDefined()
    if (!r || !l) return
    expect(r.y).toBeLessThan(l.y)
  })

  it('places the holds on the correct sides of the field', () => {
    const { texts } = render()
    const at = (name: string): Text => {
      const t = texts.find((x) => x.s === name)
      if (!t) throw new Error(`no label ${name}`)
      return t
    }
    // LAM north-east, BIG south-east, BNN north, OCK south.
    expect(at('LAM').x).toBeGreaterThan(500)
    expect(at('LAM').y).toBeLessThan(300)
    expect(at('BIG').x).toBeGreaterThan(500)
    expect(at('BIG').y).toBeGreaterThan(300)
    expect(at('BNN').y).toBeLessThan(300)
    expect(at('OCK').y).toBeGreaterThan(300)
  })

  it('renders every hold inside the viewport at the default range', () => {
    const { texts, cam } = render()
    for (const name of ['LAM', 'BIG', 'BNN', 'OCK']) {
      const t = texts.find((x) => x.s === name)
      expect(t, name).toBeDefined()
      if (!t) continue
      expect(t.x, `${name} x`).toBeGreaterThan(0)
      expect(t.x, `${name} x`).toBeLessThan(cam.width)
      expect(t.y, `${name} y`).toBeGreaterThan(0)
      expect(t.y, `${name} y`).toBeLessThan(cam.height)
    }
  })

  it('drops fine detail when zoomed far out rather than drawing mush', () => {
    const { texts } = render(1000, 600, 150)
    expect(texts.some((t) => t.s.startsWith('FAF'))).toBe(false)
  })

  it('shows the final approach fix when zoomed in', () => {
    const { texts } = render(1000, 600, 12)
    expect(texts.some((t) => t.s === 'FAF 27R')).toBe(true)
  })
})
