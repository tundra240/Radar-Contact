import { describe, expect, it } from 'vitest'
import { SEPARATION_FT, SEPARATION_NM } from './conflict'
import {
  allowsCorridor,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  difficultyOf,
  hasTransits,
  intervalSecondsFor,
  openingIntervalSecondsFor,
  scaledPoints,
  type DifficultyName,
} from './difficulty'

const ladder = DIFFICULTY_ORDER.map((name) => DIFFICULTIES[name])

/** Every adjacent pair, easiest first, for checking the progression. */
const rungs = ladder
  .slice(0, -1)
  .map((easier, i) => [easier, ladder[i + 1] as (typeof ladder)[number]] as const)

describe('the ladder', () => {
  it('runs from easy to pro', () => {
    expect(DIFFICULTY_ORDER).toEqual(['easy', 'normal', 'hard', 'pro'])
    expect(DIFFICULTIES[DEFAULT_DIFFICULTY]).toBeDefined()
  })

  it('names itself consistently', () => {
    // The key and the name in the record have to agree, or difficultyOf
    // returns something that disagrees with what was asked for.
    for (const name of DIFFICULTY_ORDER) expect(DIFFICULTIES[name].name).toBe(name)
  })

  it('falls back rather than throwing on a name it does not know', () => {
    // A saved session from a later version, or a hand-edited setting.
    expect(difficultyOf('nonsense').name).toBe(DEFAULT_DIFFICULTY)
    expect(difficultyOf('pro').name).toBe('pro')
  })

  it('gets busier every rung', () => {
    for (const [easier, harder] of rungs) {
      expect(harder.arrivalsPerHour, harder.name).toBeGreaterThan(easier.arrivalsPerHour)
      expect(harder.maxConcurrent, harder.name).toBeGreaterThan(easier.maxConcurrent)
      expect(harder.transitsPerHour, harder.name).toBeGreaterThanOrEqual(easier.transitsPerHour)
    }
  })

  it('gets rougher every rung', () => {
    for (const [easier, harder] of rungs) {
      expect(harder.cellsPerHour, harder.name).toBeGreaterThanOrEqual(easier.cellsPerHour)
      expect(harder.heavyChance, harder.name).toBeGreaterThanOrEqual(easier.heavyChance)
      expect(harder.windStrength, harder.name).toBeGreaterThanOrEqual(easier.windStrength)
    }
  })

  it('takes the display away as it goes', () => {
    for (const [easier, harder] of rungs) {
      // Fewer history dots and a narrower warning: the picture gets less
      // helpful exactly as the traffic gets harder.
      expect(harder.trailDots, harder.name).toBeLessThanOrEqual(easier.trailDots)
      expect(harder.warnNM, harder.name).toBeLessThanOrEqual(easier.warnNM)
      expect(harder.warnFt, harder.name).toBeLessThanOrEqual(easier.warnFt)
    }
  })

  it('pays more every rung', () => {
    for (const [easier, harder] of rungs) {
      expect(harder.scoreMultiplier, harder.name).toBeGreaterThan(easier.scoreMultiplier)
    }
    expect(DIFFICULTIES.easy.scoreMultiplier).toBe(1)
  })

  it('matches the rates the brief asks for', () => {
    // The numbers somebody chose, held to, so a tidy-up cannot quietly
    // rebalance the game.
    expect(DIFFICULTIES.easy.arrivalsPerHour).toBeGreaterThanOrEqual(8)
    expect(DIFFICULTIES.easy.arrivalsPerHour).toBeLessThanOrEqual(10)
    expect(DIFFICULTIES.normal.arrivalsPerHour).toBeGreaterThanOrEqual(14)
    expect(DIFFICULTIES.normal.arrivalsPerHour).toBeLessThanOrEqual(18)
    expect(DIFFICULTIES.hard.arrivalsPerHour).toBeGreaterThanOrEqual(22)
    expect(DIFFICULTIES.hard.arrivalsPerHour).toBeLessThanOrEqual(26)
    expect(DIFFICULTIES.pro.arrivalsPerHour).toBeGreaterThanOrEqual(32)
  })
})

describe('the separation minimum', () => {
  it('is the same law on every setting', () => {
    // The one thing difficulty does NOT move. What changes is how much room
    // the display gives you before you reach it.
    for (const settings of ladder) {
      expect(settings.warnNM, settings.name).toBeGreaterThanOrEqual(SEPARATION_NM)
      expect(settings.warnFt, settings.name).toBeGreaterThanOrEqual(SEPARATION_FT)
    }
  })

  it('warns early on the gentle settings and not at all early on the hard ones', () => {
    expect(DIFFICULTIES.easy.warnNM).toBeGreaterThan(SEPARATION_NM)
    expect(DIFFICULTIES.normal.warnNM).toBeGreaterThan(SEPARATION_NM)
    // On these two the warning and the breach are the same event.
    expect(DIFFICULTIES.hard.warnNM).toBe(SEPARATION_NM)
    expect(DIFFICULTIES.pro.warnNM).toBe(SEPARATION_NM)
    expect(DIFFICULTIES.pro.warnFt).toBe(SEPARATION_FT)
  })
})

describe('the transits', () => {
  it('are off entirely on the gentlest setting', () => {
    expect(hasTransits(DIFFICULTIES.easy)).toBe(false)
    expect(DIFFICULTIES.easy.corridors).toEqual([])
  })

  it('are on everywhere else', () => {
    for (const name of ['normal', 'hard', 'pro'] as DifficultyName[]) {
      expect(hasTransits(DIFFICULTIES[name]), name).toBe(true)
    }
  })

  it('let more of the airspace be used the harder it gets', () => {
    expect(allowsCorridor(DIFFICULTIES.easy, 'clear')).toBe(false)
    expect(allowsCorridor(DIFFICULTIES.normal, 'clear')).toBe(true)
    // Normal keeps them out of the arrival flow.
    expect(allowsCorridor(DIFFICULTIES.normal, 'crossing')).toBe(false)
    expect(allowsCorridor(DIFFICULTIES.hard, 'crossing')).toBe(true)
    // Only Pro sends them over the top of the field.
    expect(allowsCorridor(DIFFICULTIES.hard, 'overhead')).toBe(false)
    expect(allowsCorridor(DIFFICULTIES.pro, 'overhead')).toBe(true)
  })

  it('treats an unclassified corridor as one that gets in the way', () => {
    // The cautious reading: a corridor nobody has thought about should not
    // turn up on the gentle settings.
    expect(allowsCorridor(DIFFICULTIES.normal, null)).toBe(false)
    expect(allowsCorridor(DIFFICULTIES.hard, null)).toBe(true)
  })
})

describe('turning a rate into a cadence', () => {
  it('converts arrivals an hour into seconds apart', () => {
    expect(intervalSecondsFor(60)).toBe(60)
    expect(intervalSecondsFor(30)).toBe(120)
    expect(intervalSecondsFor(9)).toBeCloseTo(400, 0)
  })

  it('treats no traffic as an infinite gap rather than a division by zero', () => {
    expect(intervalSecondsFor(0)).toBe(Number.POSITIVE_INFINITY)
  })

  it('opens quieter than it finishes', () => {
    // Every setting ramps: dropping a controller straight into the peak
    // gives them no time to build a picture.
    for (const settings of ladder) {
      expect(
        openingIntervalSecondsFor(settings.arrivalsPerHour),
        settings.name,
      ).toBeGreaterThan(intervalSecondsFor(settings.arrivalsPerHour))
    }
  })
})

describe('what a landing is worth', () => {
  it('scales with the setting', () => {
    expect(scaledPoints(100, DIFFICULTIES.easy)).toBe(100)
    expect(scaledPoints(100, DIFFICULTIES.normal)).toBe(150)
    expect(scaledPoints(100, DIFFICULTIES.hard)).toBe(200)
    expect(scaledPoints(100, DIFFICULTIES.pro)).toBe(300)
  })

  it('is a whole number', () => {
    // A score with a decimal point reads as a measurement rather than a
    // tally, and 1.5 times an odd figure is where that would come from.
    for (const settings of ladder) {
      expect(Number.isInteger(scaledPoints(75, settings)), settings.name).toBe(true)
    }
  })
})
