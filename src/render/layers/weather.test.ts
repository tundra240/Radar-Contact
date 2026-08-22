import { describe, expect, it } from 'vitest'
import { Camera } from '../../core/camera'
import { makeRng } from '../../core/rng'
import {
  makeWeather,
  type Weather,
  type WeatherCell,
  type WeatherConfig,
} from '../../sim/weather'
import { palettes, setPalette } from '../theme'
import { drawCells, drawWeather } from './weather'

/** One filled shape, with the state it was filled under. */
interface Shape {
  style: string
  alpha: number
  points: number
  extent: number
  centreX: number
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
  const midX = (): number =>
    path.length === 0 ? 0 : path.reduce((sum, p) => sum + p.x, 0) / path.length
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
        centreX: midX(),
      })
    },
    stroke: () => {
      strokes.push({
        style: String(stub['strokeStyle']),
        alpha: Number(stub['globalAlpha']),
        points: path.length,
        extent: measure(),
        centreX: midX(),
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

/** A rate high enough that a seeded schedule reliably has something on it. */
const CONFIG: WeatherConfig = {
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
}

const SCHEDULE = makeWeather(makeRng(4), CONFIG)
const CLEAR = makeWeather(makeRng(4), { ...CONFIG, cellsPerHour: 0 })

/** Half an hour in, by which time the seeded schedule has cells running. */
const MIDWAY = 1800

const draw = (weather: Weather, elapsed = MIDWAY, rangeNM = 60) => {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
  cam.setViewport(1000, 600)
  const rec = recorder()
  drawWeather(rec.ctx, cam, weather, elapsed)
  return { ...rec, cam }
}

/**
 * One cell of a known strength, drawn at its mid-life by default so the
 * envelope is exactly one and the geometry is the nominal geometry.
 */
const one = (
  cell: Partial<WeatherCell> & { peak: number },
  elapsed = 50,
  rangeNM = 60,
  weather: Weather = CLEAR,
) => {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
  cam.setViewport(1000, 600)
  const rec = recorder()
  drawCells(
    rec.ctx,
    cam,
    weather,
    [
      {
        originNM: { x: 0, y: 0 },
        radiusNM: 8,
        lobes: [],
        bornSeconds: 0,
        lifeSeconds: 100,
        driftOffsetDeg: 0,
        driftFactor: 1,
        ...cell,
      },
    ],
    elapsed,
  )
  return { ...rec, cam }
}

describe('drawWeather', () => {
  it('draws nothing at all for a clear scope', () => {
    const r = draw(CLEAR)
    expect(r.fills).toEqual([])
    expect(r.strokes).toEqual([])
  })

  it('fills and outlines every contour it draws', () => {
    // A fill alone leaves the boundary vague, and the boundary is what a
    // band is read off.
    const r = draw(SCHEDULE)
    expect(r.fills.length).toBeGreaterThan(0)
    expect(r.strokes).toHaveLength(r.fills.length)
  })

  it('draws each contour as a closed ring of many points, not a circle', () => {
    for (const shape of draw(SCHEDULE).fills) {
      expect(shape.points).toBeGreaterThan(30)
    }
  })

  it('fills faintly and outlines at full strength', () => {
    const r = draw(SCHEDULE)
    for (const f of r.fills) {
      expect(f.alpha).toBeGreaterThan(0)
      expect(f.alpha).toBeLessThan(0.5)
    }
    for (const s of r.strokes) expect(s.alpha).toBe(1)
  })

  it('hands the canvas back opaque', () => {
    // A leaked alpha here would wash out the airspace, the traffic and the
    // chrome, all of which are drawn afterwards.
    expect(draw(SCHEDULE).alphaAtEnd()).toBe(1)
  })
})

describe('the bands', () => {
  it('nests them, worst innermost', () => {
    const r = one({ peak: 1 })
    expect(r.fills).toHaveLength(3)
    // Drawn outside in, so each is smaller than the last and the core ends
    // up on top.
    expect(r.fills[1]!.extent).toBeLessThan(r.fills[0]!.extent)
    expect(r.fills[2]!.extent).toBeLessThan(r.fills[1]!.extent)
  })

  it('gives a shower one band and a storm three', () => {
    // A cell that never reaches moderate must not be drawn with a yellow
    // ring of zero size, which is what a naive contour would do.
    expect(one({ peak: 0.2 }).fills).toHaveLength(1)
    expect(one({ peak: 0.5 }).fills).toHaveLength(2)
    expect(one({ peak: 0.9 }).fills).toHaveLength(3)
  })

  it('colours them green, amber and red', () => {
    setPalette('dark')
    const styles = one({ peak: 1 }).fills.map((f) => f.style)
    expect(styles).toEqual([
      palettes.dark.wxLight,
      palettes.dark.wxModerate,
      palettes.dark.wxHeavy,
    ])
    setPalette('beige')
  })

  it('follows the palette', () => {
    setPalette('dark')
    expect(one({ peak: 0.2 }).fills[0]?.style).toBe(palettes.dark.wxLight)
    setPalette('beige')
  })
})

describe('the life of a cell', () => {
  const storm = { peak: 1, lifeSeconds: 100 }

  it('draws nothing before it forms or after it collapses', () => {
    expect(one(storm, -1).fills).toEqual([])
    expect(one(storm, 0).fills).toEqual([])
    expect(one(storm, 100).fills).toEqual([])
    expect(one(storm, 101).fills).toEqual([])
  })

  it('works up through the bands and back down', () => {
    // A storm arrives as a green blob, cores out, and goes back to a blob.
    // Three rings on the first frame would read as a switch being thrown
    // rather than as weather developing.
    expect(one(storm, 3).fills.length).toBe(1)
    expect(one(storm, 50).fills.length).toBe(3)
    expect(one(storm, 97).fills.length).toBe(1)
  })

  it('grows as well as strengthens', () => {
    const young = one(storm, 12).fills[0]!.extent
    const grown = one(storm, 50).fills[0]!.extent
    expect(grown).toBeGreaterThan(young)
  })
})

describe('drift and culling', () => {
  const BLOWN = makeWeather(makeRng(1), {
    ...CONFIG,
    cellsPerHour: 0,
    wind: { fromDeg: 270, speedKts: 30 },
    driftFactor: 1,
  })
  // Two hours of life, sampled a quarter and three quarters through, so the
  // cell is the same strength at both and only its position differs.
  const long = { peak: 0.9, radiusNM: 6, lifeSeconds: 7200 }

  it('draws the cell where it has drifted to, not where it started', () => {
    const early = one(long, 1800, 60, BLOWN)
    const late = one(long, 5400, 60, BLOWN)
    // A wind from 270 at 30 kt moves it east, an hour apart on the clock.
    expect(late.fills.length).toBe(early.fills.length)
    expect(late.fills[0]!.extent).toBeCloseTo(early.fills[0]!.extent, 3)
    expect(late.fills[0]!.centreX).toBeGreaterThan(early.fills[0]!.centreX)
  })

  it('stops drawing one that is off the display', () => {
    // Cheap, and at a low zoom most of them are.
    expect(one(long, 3600, 60, BLOWN).fills.length).toBeGreaterThan(0)
    expect(one({ ...long, originNM: { x: 400, y: 0 } }, 3600, 60, BLOWN).fills).toEqual([])
  })
})
