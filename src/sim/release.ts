/**
 * Whether a new aeroplane may be put here.
 *
 * Every feed has a point it hands traffic over at: a gate out on the radial
 * through an arrival's fix, or the near end of a transit's corridor. Those
 * points are fixed, which is right -- a feed that wandered about would be a
 * feed you could not learn -- and it means two releases from the same feed
 * want the same square mile of sky.
 *
 * Left unchecked that is what they get. Press the release key twice and two
 * targets land on one blip: the second is invisible until it moves, and by
 * the time it has moved it is already in conflict with the first. That is
 * not a hard exercise, it is a broken display, and it is not something the
 * controller did.
 *
 * Both generators already refused to release on top of traffic. The hole
 * was in what "on top of" meant. The arrival spawner asked whether anything
 * was near the gate AT THE SAME LEVEL, because traffic a thousand feet
 * apart is separated -- which is true, and is the whole point of a holding
 * stack, and is not the question. A radar symbol and its data block are a
 * few dozen pixels across and know nothing about the third dimension: two
 * aeroplanes a thousand feet apart and nought point nought miles apart are
 * legally separated and completely unreadable. The transit generator asked
 * nothing at all, so pressing the transit key twice could put two of them
 * on the same point at the same level, which is not even legal.
 *
 * So the rule is here, once, and it is about the display first: a release
 * has to be far enough away to be its own target, whatever the levels are.
 *
 * What this deliberately does NOT do is queue. An occupied feed could hand
 * the next one over further back along the same track, which is what a real
 * feed does -- but sim/aircraft.ts deletes anything beyond the ring
 * arrivals are released on plus five miles, so an aeroplane placed in trail
 * would appear and vanish on the next tick. Widening the world to allow it
 * is a bigger change than this bug is asking for. A feed with no room says
 * so, the caller picks another one, and only when every feed is full does
 * the release get declined -- which is what both generators already did
 * with the counters and the announcements to match.
 */

import { distanceNM, type Vec2NM } from '../core/geo'
import { DIFFICULTIES } from './difficulty'
import type { Aircraft } from './types'

/**
 * Two targets closer than this are one target.
 *
 * About the display rather than about separation, so it applies whatever
 * the level difference: traffic can be perfectly legally separated and
 * still be unreadable because the data blocks are on top of each other.
 */
export const BLIP_CLEAR_NM = 3

/**
 * A release must also not be born inside a conflict warning.
 *
 * Taken as the loudest warning any difficulty gives rather than the
 * session's own, so a release is clear under all of them and this cannot
 * drift when a difficulty is retuned. Being handed an aeroplane that is
 * already flashing is a separation loss the controller had no hand in.
 */
const WARN_NM = Math.max(...Object.values(DIFFICULTIES).map((d) => d.warnNM))
const WARN_FT = Math.max(...Object.values(DIFFICULTIES).map((d) => d.warnFt))

/**
 * Whether an aeroplane may be released here without landing on somebody.
 *
 * `altFt` is the level it would appear at. Where that is not settled yet --
 * a transit draws its level after its corridor is chosen -- pass the middle
 * of the band it will come from: the lateral rule does the work, and the
 * vertical one is a second line of defence rather than the first.
 */
export function isClearForRelease(
  at: Vec2NM,
  altFt: number,
  existing: readonly Aircraft[],
): boolean {
  for (const a of existing) {
    const nm = distanceNM(a.pos, at)
    // Readable as its own target, whatever the level difference.
    if (nm < BLIP_CLEAR_NM) return false
    // And not already in a warning with somebody the moment it appears.
    if (nm < WARN_NM && Math.abs(a.altFt - altFt) < WARN_FT) return false
  }
  return true
}
