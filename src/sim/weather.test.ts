import { describe, expect, it } from 'vitest'
import { advance, bearingDeg, distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import {
  HEAVY_AT,
  MODERATE_AT,
  activeCells,
  bandOf,
  cellCentreNM,
  cellRadiusNM,
  contourFraction,
  envelopeOf,
  intensityAt,
  isAvoidable,
  makeWeather,
  radiusScaleOf,
  windVector,
  type WeatherCell,
  type WeatherConfig,
} from './weather'

/**
 * A busy schedule, so the geometry tests below reliably have cells to look
 * at. The shipped rate is a twelfth of this; the rarity it is actually set
 * to is measured on its own terms in `how often there is weather`.
 */
const CONFIG: WeatherConfig = {
  wind: { fromDeg: 250, speedKts: 20 },
  cellsPerHour: 12,
  minLifeMinutes: 20,
  maxLifeMinutes: 40,
  heavyChance: 0.5,
  minRadiusNM: 4,
  maxRadiusNM: 10,
  driftFactor: 0.8,
  driftSpreadDeg: 30,
  driftSpeedSpread: 0.35,
  shapeDriftDegPerMin: 6,
  spreadNM: 34,
}

/** Half an hour in, by which time a seeded schedule is running. */
const MIDWAY = 1800

/** How many cells are alive at a moment, over a run of sessions. */
function counts(config: WeatherConfig, sessions: number, at = 0): number[] {
  return Array.from(
    { length: sessions },
    (_unused, i) => activeCells(makeWeather(makeRng(i + 1), config), at).length,
  )
}

/** Everything that forms in the first hour of a session. */
function bornInFirstHour(config: WeatherConfig, seed: number): WeatherCell[] {
  const weather = makeWeather(makeRng(seed), config)
  const seen = new Map<number, WeatherCell>()
  // Sampled minute by minute, since a cell can form and die within the hour.
  for (let t = 0; t <= 3600; t += 60) {
    for (const cell of activeCells(weather, t)) {
      if (cell.bornSeconds >= 0 && cell.bornSeconds < 3600) seen.set(cell.bornSeconds, cell)
    }
  }
  return [...seen.values()]
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

describe('how often there is weather', () => {
  /** Close to the shipped settings: the numbers that decide how it feels. */
  const REAL: WeatherConfig = {
    ...CONFIG,
    cellsPerHour: 1,
    minLifeMinutes: 7,
    maxLifeMinutes: 18,
    heavyChance: 0.12,
    spreadNM: 22,
  }

  it('gives a clear scope to log on to, most of the time', () => {
    // The point of the whole exercise. Weather that is on the scope every
    // session is not weather, it is terrain, and a hazard met every time
    // stops being a hazard.
    const wet = counts(REAL, 3000).filter((n) => n > 0).length / 3000
    expect(wet).toBeLessThan(0.3)
  })

  it('rarely puts a red core in front of you at all', () => {
    let red = 0
    for (let s = 0; s < 2000; s += 1) {
      const weather = makeWeather(makeRng(s + 1), REAL)
      const worst = Math.max(
        0,
        ...activeCells(weather, 0).map((c) => c.peak * envelopeOf(c, 0)),
      )
      if (worst >= HEAVY_AT) red += 1
    }
    // The distribution this replaced put red on nine sessions in ten.
    expect(red / 2000).toBeLessThan(0.05)
  })

  it('brings one along once or twice an hour rather than never', () => {
    // Rare at any instant is not the same as absent: the cells have to turn
    // up during a session, or the feature may as well not exist.
    const perHour =
      Array.from({ length: 400 }, (_unused, i) => bornInFirstHour(REAL, i + 1).length).reduce(
        (a, b) => a + b,
        0,
      ) / 400
    expect(perHour).toBeGreaterThan(0.6)
    expect(perHour).toBeLessThan(1.6)
  })

  it('gives nothing at all at no rate', () => {
    expect(counts({ ...REAL, cellsPerHour: 0 }, 200, MIDWAY).every((n) => n === 0)).toBe(true)
  })

  it('does not correlate the answer with the seed', () => {
    // Sequential seeds are what a run of sessions looks like. A generator
    // whose answer tracked its seed would give runs of wet days and runs of
    // dry ones, and the rarity above would be a fiction.
    const all = counts(REAL, 4000)
    const halves = [0, 1].map(
      (half) => all.slice(half * 2000, (half + 1) * 2000).filter((n) => n > 0).length / 2000,
    )
    expect(Math.abs(halves[0]! - halves[1]!)).toBeLessThan(0.05)
  })
})

describe('the schedule', () => {
  it('is the same weather for the same seed, and different for another', () => {
    // Seeded for the same reasons the traffic is: a repeatable scenario and
    // an actionable bug report. It is also why no save carries a polygon.
    const a = activeCells(makeWeather(makeRng(42), CONFIG), MIDWAY)
    const b = activeCells(makeWeather(makeRng(42), CONFIG), MIDWAY)
    const c = activeCells(makeWeather(makeRng(43), CONFIG), MIDWAY)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('answers for a moment hours in without having generated the hours before', () => {
    // The whole reason cells are drawn per hour-slot: a long session must
    // not cost more than a short one, and a save resumed at hour six must
    // get exactly what it would have got by playing to it.
    const weather = makeWeather(makeRng(8), CONFIG)
    const late = activeCells(weather, 6 * 3600 + 900)
    expect(late).toEqual(activeCells(weather, 6 * 3600 + 900))
    expect(late.length).toBeGreaterThan(0)
  })

  it('finds a cell that formed before the session began', () => {
    // Which is what makes logging on into weather already in progress
    // possible without it being special-cased.
    const weather = makeWeather(makeRng(3), CONFIG)
    const early = activeCells(weather, 0)
    expect(early.some((c) => c.bornSeconds < 0)).toBe(true)
  })

  it('keeps every cell inside the configured spread and size', () => {
    for (const cell of activeCells(makeWeather(makeRng(7), CONFIG), MIDWAY)) {
      expect(distanceNM({ x: 0, y: 0 }, cell.originNM)).toBeLessThanOrEqual(CONFIG.spreadNM)
      expect(cell.radiusNM).toBeGreaterThanOrEqual(CONFIG.minRadiusNM)
      expect(cell.radiusNM).toBeLessThanOrEqual(CONFIG.maxRadiusNM)
      expect(cell.peak).toBeGreaterThan(0)
      expect(cell.peak).toBeLessThanOrEqual(1)
      expect(cell.lifeSeconds).toBeGreaterThanOrEqual(CONFIG.minLifeMinutes * 60)
      expect(cell.lifeSeconds).toBeLessThanOrEqual(CONFIG.maxLifeMinutes * 60)
    }
  })

  it('honours the share of cells that core out to red', () => {
    const sample = (heavyChance: number): number => {
      const cells = Array.from({ length: 300 }, (_unused, i) =>
        bornInFirstHour({ ...CONFIG, heavyChance }, i + 1),
      ).flat()
      return cells.filter((c) => c.peak >= HEAVY_AT).length / cells.length
    }
    expect(sample(0)).toBe(0)
    expect(sample(0.12)).toBeGreaterThan(0.06)
    expect(sample(0.12)).toBeLessThan(0.2)
    expect(sample(1)).toBe(1)
  })

  it('spreads the cells round the field rather than into one corner', () => {
    // Placed by bearing and range, with the range square-rooted so the
    // distribution is even over the area rather than bunched at the middle.
    const origins = Array.from({ length: 40 }, (_unused, i) =>
      activeCells(makeWeather(makeRng(i + 1), CONFIG), MIDWAY),
    ).flat()
    const quadrants = new Set(
      origins.map((c) => Math.floor(bearingDeg({ x: 0, y: 0 }, c.originNM) / 90)),
    )
    expect(quadrants.size).toBe(4)
  })
})

describe('the life of a cell', () => {
  const cell: WeatherCell = {
    originNM: { x: 0, y: 0 },
    radiusNM: 8,
    peak: 1,
    lobes: [],
    bornSeconds: 0,
    lifeSeconds: 600,
    driftOffsetDeg: 0,
    driftFactor: 0.8,
  }

  it('is nothing before it forms and nothing after it collapses', () => {
    expect(envelopeOf(cell, -1)).toBe(0)
    expect(envelopeOf(cell, 0)).toBe(0)
    expect(envelopeOf(cell, 600)).toBe(0)
    expect(envelopeOf(cell, 601)).toBe(0)
  })

  it('is strongest half way through', () => {
    expect(envelopeOf(cell, 300)).toBeCloseTo(1, 9)
    expect(envelopeOf(cell, 150)).toBeLessThan(1)
    expect(envelopeOf(cell, 450)).toBeLessThan(1)
    // Symmetric: it dies the way it grew.
    expect(envelopeOf(cell, 150)).toBeCloseTo(envelopeOf(cell, 450), 9)
  })

  it('grows and fades without ever jumping', () => {
    let last = 0
    for (let t = 1; t <= 300; t += 10) {
      const now = envelopeOf(cell, t)
      expect(now).toBeGreaterThan(last)
      last = now
    }
  })

  it('grows in size too, but never shrinks to a dot', () => {
    expect(radiusScaleOf(0)).toBeGreaterThan(0.4)
    expect(radiusScaleOf(1)).toBe(1)
    expect(radiusScaleOf(0.5)).toBeGreaterThan(radiusScaleOf(0))
  })
})

describe('cell shape', () => {
  const cell = activeCells(makeWeather(makeRng(11), CONFIG), MIDWAY)[0]!

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

  it('still closes on itself once it has reshaped', () => {
    // The phases turn with age; the harmonics are whole numbers, so the
    // outline has to stay seamless however far it has evolved.
    for (const age of [60, 600, 3600]) {
      expect(cellRadiusNM(cell, 0, age)).toBeCloseTo(cellRadiusNM(cell, 360, age), 9)
    }
  })

  it('changes shape as it ages rather than sliding rigid', () => {
    const at = (age: number) =>
      [0, 45, 90, 135, 180, 225, 270, 315].map((b) => cellRadiusNM(cell, b, age))
    const young = at(0)
    const older = at(600)
    const moved = young.filter((r, i) => Math.abs(r - older[i]!) > 0.01).length
    expect(moved).toBeGreaterThan(3)
  })

  it('reshapes gradually, not in jumps', () => {
    // Ten minutes of evolution is a cell developing; ten seconds of it
    // would be a shimmer.
    for (let age = 0; age < 600; age += 10) {
      const step = Math.abs(cellRadiusNM(cell, 90, age) - cellRadiusNM(cell, 90, age + 10))
      expect(step).toBeLessThan(cell.radiusNM * 0.05)
    }
  })
})

describe('drift', () => {
  const weather = makeWeather(makeRng(5), CONFIG)
  const cell = activeCells(weather, MIDWAY)[0]!

  it('starts where the cell formed', () => {
    expect(cellCentreNM(cell, weather, cell.bornSeconds)).toEqual(cell.originNM)
  })

  it('moves broadly downwind, but on its own track', () => {
    // A wind from 250 at 20 kt drifting at 0.8 gives a mean of 16 kt towards
    // 070. Each cell varies either side of that -- 35% in speed and 30
    // degrees in track -- so this is a band, not a number. Moving every cell
    // on the identical vector is what made the field look panned rather than
    // alive.
    const after = cellCentreNM(cell, weather, cell.bornSeconds + 3600)
    const run = distanceNM(cell.originNM, after)
    expect(run).toBeGreaterThan(16 * 0.65 - 0.01)
    expect(run).toBeLessThan(16 * 1.35 + 0.01)
    const track = bearingDeg(cell.originNM, after)
    expect(Math.abs(track - 70)).toBeLessThanOrEqual(30.01)
  })

  it('does not move every cell on the same vector', () => {
    // The point of the spread: a group of cells has to spread out as it
    // crosses, or it reads as one picture being slid across the scope.
    const many = activeCells(makeWeather(makeRng(21), CONFIG), MIDWAY)
    expect(many.length).toBeGreaterThan(2)
    const tracks = many.map((c) => {
      const to = cellCentreNM(c, weather, c.bornSeconds + 3600)
      return bearingDeg(c.originNM, to)
    })
    const spread = Math.max(...tracks) - Math.min(...tracks)
    expect(spread).toBeGreaterThan(1)
  })

  it('still moves nothing when the drift factor is nothing', () => {
    const still = makeWeather(makeRng(5), { ...CONFIG, driftFactor: 0 })
    for (const c of activeCells(still, MIDWAY)) {
      expect(cellCentreNM(c, still, c.bornSeconds + 3600)).toEqual(c.originNM)
    }
  })

  it('is linear in the time since it formed', () => {
    const half = cellCentreNM(cell, weather, cell.bornSeconds + 1800)
    const full = cellCentreNM(cell, weather, cell.bornSeconds + 3600)
    expect(distanceNM(cell.originNM, half) * 2).toBeCloseTo(distanceNM(cell.originNM, full), 6)
  })

  it('does not drift backwards before it formed', () => {
    expect(cellCentreNM(cell, weather, cell.bornSeconds - 600)).toEqual(cell.originNM)
  })
})

describe('intensity', () => {
  // A schedule with exactly one cell alive at MIDWAY, and that one well
  // developed. These tests are about how intensity behaves within a single
  // cell, and intensityAt takes the worst of all of them -- so a neighbour
  // overlapping the probe point would be measuring something else. Overlap
  // has its own test below.
  const weather = makeWeather(makeRng(16), { ...CONFIG, cellsPerHour: 1 })
  const cell = activeCells(weather, MIDWAY)[0]!
  /** The strength it is at right now, which is what intensity is measured against. */
  const now = cell.peak * envelopeOf(cell, MIDWAY)
  const centre = cellCentreNM(cell, weather, MIDWAY)

  /** Its age at the moment under test: the shape evolves, so this matters. */
  const age = MIDWAY - cell.bornSeconds

  it('is worst at the core and nothing outside the edge', () => {
    expect(intensityAt(weather, centre, MIDWAY)).toBeCloseTo(now, 6)
    const outside = advance(centre, 0, cellRadiusNM(cell, 0, age) + 1)
    expect(intensityAt(weather, outside, MIDWAY)).toBe(0)
  })

  it('falls away from the core rather than stepping', () => {
    const towards = 30
    const edge = cellRadiusNM(cell, towards, age) * radiusScaleOf(envelopeOf(cell, MIDWAY))
    let last = Infinity
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const here = intensityAt(weather, advance(centre, towards, edge * f), MIDWAY)
      expect(here).toBeLessThan(last)
      last = here
    }
  })

  it('is clear air where there is no weather at all', () => {
    const calm = makeWeather(makeRng(1), { ...CONFIG, cellsPerHour: 0 })
    expect(intensityAt(calm, { x: 0, y: 0 }, MIDWAY)).toBe(0)
    expect(bandOf(intensityAt(calm, { x: 0, y: 0 }, MIDWAY))).toBeNull()
  })

  it('takes the worst cell where they overlap', () => {
    const tight = makeWeather(makeRng(9), { ...CONFIG, spreadNM: 1 })
    const cells = activeCells(tight, MIDWAY)
    expect(cells.length).toBeGreaterThan(1)
    const worst = Math.max(...cells.map((c) => c.peak * envelopeOf(c, MIDWAY)))
    expect(intensityAt(tight, cells[0]!.originNM, MIDWAY)).toBeLessThanOrEqual(worst + 1e-9)
  })

  it('clears the spot the cell has left', () => {
    // The same point is in the weather now and clear of it later, which is
    // what makes a vector round a cell a temporary thing -- and now also
    // what makes waiting a viable answer.
    expect(intensityAt(weather, centre, MIDWAY)).toBeGreaterThan(0)
    expect(intensityAt(weather, centre, MIDWAY + 6 * 3600)).toBe(0)
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
  const bad: WeatherCell = {
    originNM: { x: 0, y: 0 },
    radiusNM: 10,
    peak: 1,
    lobes: [],
    bornSeconds: 0,
    lifeSeconds: 100,
    driftOffsetDeg: 0,
    driftFactor: 0.8,
  }

  it('nests the bands, worst innermost', () => {
    const light = contourFraction(bad, 'light', 1)
    const moderate = contourFraction(bad, 'moderate', 1)
    const heavy = contourFraction(bad, 'heavy', 1)
    expect(light).toBe(1)
    expect(moderate).toBeLessThan(light as number)
    expect(heavy).toBeLessThan(moderate as number)
  })

  it('gives a weak cell no contour for a band it never reaches', () => {
    expect(contourFraction({ ...bad, peak: 0.2 }, 'moderate', 1)).toBeNull()
    expect(contourFraction({ ...bad, peak: 0.2 }, 'heavy', 1)).toBeNull()
    expect(contourFraction({ ...bad, peak: 0.2 }, 'light', 1)).toBe(1)
  })

  it('gives a young cell no contour for a band it has not worked up to yet', () => {
    // Same rule doing double duty: a storm at a tenth of its strength is a
    // shower, and is drawn as one.
    expect(contourFraction(bad, 'heavy', 0.1)).toBeNull()
    expect(contourFraction(bad, 'heavy', 1)).not.toBeNull()
  })

  it('is nothing at all for a cell that has not formed', () => {
    expect(contourFraction(bad, 'light', 0)).toBeNull()
    expect(contourFraction(bad, 'heavy', 0)).toBeNull()
  })
})
