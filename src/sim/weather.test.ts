import { describe, expect, it } from 'vitest'
import { advance, bearingDeg, distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import {
  HEAVY_AT,
  MODERATE_AT,
  bandOf,
  cellCentreNM,
  cellRadiusNM,
  contourFraction,
  intensityAt,
  isAvoidable,
  makeWeather,
  windVector,
  type WeatherConfig,
} from './weather'

const CONFIG: WeatherConfig = {
  wind: { fromDeg: 250, speedKts: 20 },
  cellCount: 6,
  minRadiusNM: 4,
  maxRadiusNM: 10,
  driftFactor: 0.8,
  spreadNM: 34,
}

describe('windVector', () => {
  it('points where the air is going, not where it came from', () => {
    // The whole of the confusion in this subject: reported from, flown
    // towards. A wind from 270 moves the air east.
    const v = windVector({ fromDeg: 270, speedKts: 20 })
    expect(v.x).toBeCloseTo(20, 6)
    expect(v.y).toBeCloseTo(0, 6)
  })

  it('handles each cardinal', () => {
    expect(windVector({ fromDeg: 180, speedKts: 10 }).y).toBeCloseTo(10, 6)
    expect(windVector({ fromDeg: 360, speedKts: 10 }).y).toBeCloseTo(-10, 6)
    expect(windVector({ fromDeg: 90, speedKts: 10 }).x).toBeCloseTo(-10, 6)
  })

  it('scales, so a session can apply a fraction of it', () => {
    const full = windVector({ fromDeg: 250, speedKts: 20 })
    const part = windVector({ fromDeg: 250, speedKts: 20 }, 0.25)
    expect(Math.hypot(part.x, part.y)).toBeCloseTo(Math.hypot(full.x, full.y) / 4, 6)
  })

  it('is nothing in calm air', () => {
    const v = windVector({ fromDeg: 250, speedKts: 0 })
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(0, 9)
  })
})

describe('makeWeather', () => {
  it('produces the configured number of cells', () => {
    expect(makeWeather(makeRng(1), CONFIG).cells).toHaveLength(6)
  })

  it('is the same weather for the same seed, and different for another', () => {
    // Seeded for the same reasons the traffic is: a repeatable scenario and
    // an actionable bug report. It is also why no save carries a polygon.
    const a = makeWeather(makeRng(42), CONFIG)
    const b = makeWeather(makeRng(42), CONFIG)
    const c = makeWeather(makeRng(43), CONFIG)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('keeps every cell inside the configured spread and size', () => {
    const weather = makeWeather(makeRng(7), CONFIG)
    for (const cell of weather.cells) {
      expect(distanceNM({ x: 0, y: 0 }, cell.originNM)).toBeLessThanOrEqual(CONFIG.spreadNM)
      expect(cell.radiusNM).toBeGreaterThanOrEqual(CONFIG.minRadiusNM)
      expect(cell.radiusNM).toBeLessThanOrEqual(CONFIG.maxRadiusNM)
      expect(cell.peak).toBeGreaterThan(0)
      expect(cell.peak).toBeLessThanOrEqual(1)
    }
  })

  it('asks for no cells and gets none', () => {
    expect(makeWeather(makeRng(1), { ...CONFIG, cellCount: 0 }).cells).toEqual([])
  })

  it('spreads the cells round the field rather than into one corner', () => {
    // Placed by bearing and range, with the range square-rooted so the
    // distribution is even over the area rather than bunched at the middle.
    const weather = makeWeather(makeRng(3), { ...CONFIG, cellCount: 60 })
    const quadrants = new Set(
      weather.cells.map((c) => Math.floor(bearingDeg({ x: 0, y: 0 }, c.originNM) / 90)),
    )
    expect(quadrants.size).toBe(4)
  })
})

describe('cell shape', () => {
  const weather = makeWeather(makeRng(11), CONFIG)
  const cell = weather.cells[0]!

  it('is not a circle', () => {
    const radii = [0, 45, 90, 135, 180, 225, 270, 315].map((b) => cellRadiusNM(cell, b))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.1)
  })

  it('stays a sensible size in every direction', () => {
    for (let b = 0; b < 360; b += 5) {
      const r = cellRadiusNM(cell, b)
      expect(r, `${b} deg`).toBeGreaterThan(0)
      expect(r, `${b} deg`).toBeLessThan(cell.radiusNM * 2)
    }
  })

  it('closes on itself, so the outline has no seam', () => {
    expect(cellRadiusNM(cell, 0)).toBeCloseTo(cellRadiusNM(cell, 360), 9)
  })
})

describe('drift', () => {
  const weather = makeWeather(makeRng(5), CONFIG)
  const cell = weather.cells[0]!

  it('starts where the cell was made', () => {
    expect(cellCentreNM(cell, weather, 0)).toEqual(cell.originNM)
  })

  it('moves downwind at the configured fraction of the wind', () => {
    // A wind from 250 at 20 kt, drifting at 0.8, is 16 kt towards 070.
    const after = cellCentreNM(cell, weather, 3600)
    expect(distanceNM(cell.originNM, after)).toBeCloseTo(16, 1)
    expect(bearingDeg(cell.originNM, after)).toBeCloseTo(70, 1)
  })

  it('is linear in time', () => {
    const half = cellCentreNM(cell, weather, 1800)
    const full = cellCentreNM(cell, weather, 3600)
    expect(distanceNM(cell.originNM, half) * 2).toBeCloseTo(
      distanceNM(cell.originNM, full),
      6,
    )
  })

  it('does not drift backwards before the session starts', () => {
    expect(cellCentreNM(cell, weather, -600)).toEqual(cell.originNM)
  })
})

describe('intensity', () => {
  const weather = makeWeather(makeRng(9), CONFIG)
  const cell = weather.cells[0]!

  it('is worst at the core and nothing outside the edge', () => {
    expect(intensityAt(weather, cell.originNM, 0)).toBeCloseTo(cell.peak, 6)
    const outside = advance(cell.originNM, 0, cellRadiusNM(cell, 0) + 1)
    expect(intensityAt(weather, outside, 0)).toBe(0)
  })

  it('falls away from the core rather than stepping', () => {
    const towards = 30
    const edge = cellRadiusNM(cell, towards)
    let last = Infinity
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const here = intensityAt(weather, advance(cell.originNM, towards, edge * f), 0)
      expect(here).toBeLessThan(last)
      last = here
    }
  })

  it('is clear air where there is no weather at all', () => {
    const calm = makeWeather(makeRng(1), { ...CONFIG, cellCount: 0 })
    expect(intensityAt(calm, { x: 0, y: 0 }, 0)).toBe(0)
    expect(bandOf(intensityAt(calm, { x: 0, y: 0 }, 0))).toBeNull()
  })

  it('takes the worst cell where two overlap', () => {
    const pair = makeWeather(makeRng(2), { ...CONFIG, cellCount: 2, spreadNM: 1 })
    const worst = Math.max(...pair.cells.map((c) => c.peak))
    const middle = pair.cells[0]!.originNM
    expect(intensityAt(pair, middle, 0)).toBeLessThanOrEqual(worst)
  })

  it('moves with the cell', () => {
    // The same point is in the weather now and clear of it later, which is
    // what makes a vector round a cell a temporary thing.
    const spot = cell.originNM
    expect(intensityAt(weather, spot, 0)).toBeGreaterThan(0)
    expect(intensityAt(weather, spot, 6 * 3600)).toBe(0)
  })
})

describe('bands', () => {
  it('splits intensity into the three the scope draws', () => {
    expect(bandOf(0)).toBeNull()
    expect(bandOf(0.1)).toBe('light')
    expect(bandOf(MODERATE_AT)).toBe('moderate')
    expect(bandOf(HEAVY_AT)).toBe('heavy')
    expect(bandOf(1)).toBe('heavy')
  })

  it('asks for a vector round moderate and worse, and not round light', () => {
    // Light precipitation is a nuisance, not a hazard: an aircraft that
    // asked to avoid every shower would make the alert meaningless.
    expect(isAvoidable(0.1)).toBe(false)
    expect(isAvoidable(MODERATE_AT)).toBe(true)
    expect(isAvoidable(HEAVY_AT)).toBe(true)
  })
})

describe('contourFraction', () => {
  it('nests the bands, worst innermost', () => {
    const bad = { originNM: { x: 0, y: 0 }, radiusNM: 10, peak: 1, lobes: [] }
    const light = contourFraction(bad, 'light')
    const moderate = contourFraction(bad, 'moderate')
    const heavy = contourFraction(bad, 'heavy')
    expect(light).toBe(1)
    expect(moderate).toBeLessThan(light as number)
    expect(heavy).toBeLessThan(moderate as number)
  })

  it('gives a weak cell no core to draw', () => {
    // A cell that never reaches moderate should not be drawn with a yellow
    // ring of zero size, which is what a naive contour would do.
    const weak = { originNM: { x: 0, y: 0 }, radiusNM: 8, peak: 0.2, lobes: [] }
    expect(contourFraction(weak, 'light')).toBe(1)
    expect(contourFraction(weak, 'moderate')).toBeNull()
    expect(contourFraction(weak, 'heavy')).toBeNull()
  })

  it('agrees with the intensity it is derived from', () => {
    // The contour is where the intensity crosses the threshold, so reading
    // the intensity at the contour should land on the threshold.
    const cell = { originNM: { x: 0, y: 0 }, radiusNM: 9, peak: 0.9, lobes: [] }
    const weather = { wind: CONFIG.wind, cells: [cell], driftFactor: 0 }
    const f = contourFraction(cell, 'moderate') as number
    const at = advance(cell.originNM, 40, cellRadiusNM(cell, 40) * f)
    expect(intensityAt(weather, at, 0)).toBeCloseTo(MODERATE_AT, 6)
  })
})
