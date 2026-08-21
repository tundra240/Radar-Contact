import { describe, expect, it } from 'vitest'
import {
  isHeavy,
  modeC,
  statusText,
  trendOf,
  type Aircraft,
  type NavMode,
} from './types'

const base: Aircraft = {
  callsign: 'TEST01',
  type: 'A320',
  wake: 'M',
  pos: { x: 0, y: 0 },
  altFt: 5000,
  hdg: 270,
  gsKts: 200,
  vsFpm: 0,
  clearedHdg: null,
  clearedAltFt: 5000,
  clearedSpdKts: 200,
  navMode: 'VECTOR',
  clearedApproach: null,
  hold: null,
  originFix: 'LAM',
  trail: [],
  trailAt: 0,
  spawnedAt: 0,
}

describe('modeC', () => {
  it('reads altitude in hundreds of feet, three digits', () => {
    expect(modeC(4000)).toBe('040')
    expect(modeC(12000)).toBe('120')
    expect(modeC(900)).toBe('009')
    expect(modeC(0)).toBe('000')
  })

  it('rounds to the nearest hundred rather than truncating', () => {
    expect(modeC(4051)).toBe('041')
    expect(modeC(4049)).toBe('040')
  })
})

describe('trendOf', () => {
  it('has a deadband so a level aircraft does not flicker', () => {
    // Real vertical speed jitters around zero; without this the trend
    // arrow would flap every tick.
    expect(trendOf(0)).toBe('level')
    expect(trendOf(90)).toBe('level')
    expect(trendOf(-90)).toBe('level')
    expect(trendOf(500)).toBe('climb')
    expect(trendOf(-500)).toBe('descend')
  })
})

describe('isHeavy', () => {
  it('flags heavy and super, not medium', () => {
    expect(isHeavy('H')).toBe(true)
    expect(isHeavy('J')).toBe(true)
    expect(isHeavy('M')).toBe(false)
    expect(isHeavy('L')).toBe(false)
  })
})

describe('statusText', () => {
  it('covers every nav mode', () => {
    // A missing branch would surface as an empty status line rather than a
    // type error, so this walks the whole state machine.
    const modes: NavMode[] = [
      'HOLD',
      'VECTOR',
      'LOC_ARMED',
      'LOC_CAPTURED',
      'GS_TRACKING',
      'GO_AROUND',
      'LANDED',
      'HANDOFF',
    ]
    for (const navMode of modes) {
      const text = statusText({ ...base, navMode, clearedApproach: '27R' })
      expect(text, navMode).toBeTruthy()
      expect(text, navMode).toBe(text.toUpperCase())
    }
  })

  it('names the fix when holding and the runway when established', () => {
    expect(statusText({ ...base, navMode: 'HOLD', originFix: 'BIG' })).toBe('HOLDING BIG')
    expect(
      statusText({ ...base, navMode: 'GS_TRACKING', clearedApproach: '27L' }),
    ).toBe('ESTABLISHED 27L')
  })

  it('copes with a hold that has no named fix', () => {
    expect(statusText({ ...base, navMode: 'HOLD', originFix: null })).toBe('HOLDING')
  })
})


