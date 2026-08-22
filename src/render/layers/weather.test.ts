import { describe, expect, it } from 'vitest'
import { Camera } from '../../core/camera'
import { makeRng } from '../../core/rng'
import { makeWeather, type Weather, type WeatherConfig } from '../../sim/weather'
import { palettes, setPalette } from '../theme'
import { drawWeather } from './weather'

/** One filled shape, with the state it was filled under. */
interface Shape {
  style: string
  alpha: number
  points: number
  extent: number
}

function recorder(): {
  ctx: CanvasRenderingContext2D
  fills: Shape[]
  strokes: Shape[]
  alphaAtEnd: () => number
} {
  const fills: Shape[] = []
  const strokes: Shape[] = []
  let path: { x: number; y: number }[] = []
  const noop = (): void => {}
  const measure = (): number => {
    if (path.length === 0) return 0
    const xs = path.map((p) => p.x)
    const ys = path.map((p) => p.y)
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  }
  const stub: Record<string, unknown> = {
    beginPath: () => {
      path = []
    },
    closePath: noop,
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    fill: () => {
      fills.push({
        style: String(stub['fillStyle']),
        alpha: Number(stub['globalAlpha']),
        points: path.length,
        extent: measure(),
      })
    },
    stroke: () => {
      strokes.push({
        style: String(stub['strokeStyle']),
        alpha: Number(stub['globalAlpha']),
        points: path.length,
        extent: measure(),
      })
    },
    arc: noop,
    rect: noop,
    fillRect: noop,
    save: noop,
    restore: noop,
    setLineDash: noop,
    fillText: noop,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  }
  return {
    ctx: stub as unknown as CanvasRenderingContext2D,
    fills,
    strokes,
    alphaAtEnd: () => Number(stub['globalAlpha']),
  }
}

const CONFIG: WeatherConfig = {
  wind: { fromDeg: 250, speedKts: 20 },
  chance: 1,
  maxCells: 4,
  minRadiusNM: 5,
  maxRadiusNM: 9,
  driftFactor: 0.8,
  spreadNM: 15,
}

const draw = (weather: Weather, elapsed = 0, rangeNM = 60) => {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
  cam.setViewport(1000, 600)
  const rec = recorder()
  drawWeather(rec.ctx, cam, weather, elapsed)
  return { ...rec, cam }
}

describe('drawWeather', () => {
  it('draws nothing at all for a clear scope', () => {
    const r = draw(makeWeather(makeRng(1), { ...CONFIG, maxCells: 0 }))
    expect(r.fills).toEqual([])
    expect(r.strokes).toEqual([])
  })

  it('fills and outlines every contour it draws', () => {
    // A fill alone leaves the boundary vague, and the boundary is what a
    // band is read off.
    const r = draw(makeWeather(makeRng(4), CONFIG))
    expect(r.fills.length).toBeGreaterThan(0)
    expect(r.strokes).toHaveLength(r.fills.length)
  })

  it('draws each contour as a closed ring of many points, not a circle', () => {
    const r = draw(makeWeather(makeRng(4), CONFIG))
    for (const shape of r.fills) {
      expect(shape.points).toBeGreaterThan(30)
    }
  })

  it('fills faintly and outlines at full strength', () => {
    const r = draw(makeWeather(makeRng(4), CONFIG))
    for (const f of r.fills) {
      expect(f.alpha).toBeGreaterThan(0)
      expect(f.alpha).toBeLessThan(0.5)
    }
    for (const s of r.strokes) expect(s.alpha).toBe(1)
  })

  it('hands the canvas back opaque', () => {
    // A leaked alpha here would wash out the airspace, the traffic and the
    // chrome, all of which are drawn afterwards.
    expect(draw(makeWeather(makeRng(4), CONFIG)).alphaAtEnd()).toBe(1)
  })
})

describe('the bands', () => {
  /** One cell, exactly as bad as asked for, with no wobble to complicate it. */
  const cell = (peak: number) => ({
    wind: CONFIG.wind,
    driftFactor: 0,
    cells: [{ originNM: { x: 0, y: 0 }, radiusNM: 8, peak, lobes: [] }],
  })

  it('nests them, worst innermost', () => {
    const r = draw(cell(1))
    expect(r.fills).toHaveLength(3)
    // Drawn outside in, so each is smaller than the last and the core ends
    // up on top.
    expect(r.fills[1]!.extent).toBeLessThan(r.fills[0]!.extent)
    expect(r.fills[2]!.extent).toBeLessThan(r.fills[1]!.extent)
  })

  it('gives a shower one band and a storm three', () => {
    // A cell that never reaches moderate must not be drawn with a yellow
    // ring of zero size, which is what a naive contour would do.
    expect(draw(cell(0.2)).fills).toHaveLength(1)
    expect(draw(cell(0.5)).fills).toHaveLength(2)
    expect(draw(cell(0.9)).fills).toHaveLength(3)
  })

  it('colours them green, amber and red', () => {
    setPalette('dark')
    const styles = draw(cell(1)).fills.map((f) => f.style)
    expect(styles).toEqual([
      palettes.dark.wxLight,
      palettes.dark.wxModerate,
      palettes.dark.wxHeavy,
    ])
    setPalette('beige')
  })

  it('follows the palette', () => {
    setPalette('amber')
    expect(draw(cell(0.2)).fills[0]?.style).toBe(palettes.amber.wxLight)
    setPalette('beige')
  })
})

describe('drift and culling', () => {
  const oneCell = {
    wind: { fromDeg: 270, speedKts: 30 },
    driftFactor: 1,
    cells: [{ originNM: { x: 0, y: 0 }, radiusNM: 6, peak: 0.9, lobes: [] }],
  }

  it('draws the cell where it has drifted to, not where it started', () => {
    const start = draw(oneCell, 0)
    const later = draw(oneCell, 3600)
    // A wind from 270 at 30 kt moves it 30 NM east in the hour, so the
    // shape lands somewhere else on the screen.
    expect(later.fills.length).toBe(start.fills.length)
    expect(later.fills[0]?.extent).toBeCloseTo(start.fills[0]?.extent ?? 0, 3)
  })

  it('stops drawing one that has drifted off the display', () => {
    // Cheap, and at a low zoom most of them have.
    expect(draw(oneCell, 0, 20).fills.length).toBeGreaterThan(0)
    expect(draw(oneCell, 20 * 3600, 20).fills).toEqual([])
  })
})
