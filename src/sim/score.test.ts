import { describe, expect, it } from 'vitest'
import { LANDING_POINTS, LOST_PENALTY, NO_SCORE, pointsFor, scoreDeparture } from './score'

describe('the score', () => {
  it('starts at nothing', () => {
    expect(NO_SCORE).toEqual({ points: 0, landed: 0, lost: 0 })
  })

  it('pays for a landing and charges for a loss', () => {
    expect(pointsFor('landed')).toBe(LANDING_POINTS)
    expect(pointsFor('left')).toBe(-LOST_PENALTY)
  })

  it('costs less to lose one than it pays to land one', () => {
    // So a session that lands most of its traffic still climbs. It is a
    // penalty, not a punishment.
    expect(LOST_PENALTY).toBeLessThan(LANDING_POINTS)
  })

  it('counts the two outcomes separately from the points', () => {
    let score = NO_SCORE
    score = scoreDeparture(score, 'landed')
    score = scoreDeparture(score, 'landed')
    score = scoreDeparture(score, 'left')
    expect(score).toEqual({
      points: LANDING_POINTS * 2 - LOST_PENALTY,
      landed: 2,
      lost: 1,
    })
  })

  it('leaves the score it was given alone', () => {
    // A value, not a counter: a session's score is a thing you can hold on
    // to and compare, in the same spirit as the seeded traffic.
    const before = NO_SCORE
    scoreDeparture(before, 'landed')
    expect(before).toEqual({ points: 0, landed: 0, lost: 0 })
  })

  it('can go negative, because losing traffic should hurt', () => {
    expect(scoreDeparture(NO_SCORE, 'left').points).toBeLessThan(0)
  })
})
