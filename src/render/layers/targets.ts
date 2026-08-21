import type { Camera, Vec2Px } from '../../core/camera'
import { advance } from '../../core/geo'
import { isHeavy, modeC, trendOf, type Aircraft } from '../../sim/types'
import { fonts, theme } from '../theme'

/**
 * Traffic: the trail, the target symbol, its speed vector and its data
 * block.
 *
 * Drawn last of the scope content and above every overlay, because the
 * traffic is the job and the map is only context for it. Nothing here is
 * switchable for the same reason -- an overlay you can turn off is one you
 * could work without.
 */

/** Half-width of the correlated-target square, in pixels. */
const TARGET_PX = 4

/** The speed vector reaches where the aircraft will be in one minute. */
const VECTOR_MINUTES = 1

/**
 * Below this the scope is showing so much ground that three lines of text
 * per target would overlap the next target. The symbol and its trail stay;
 * the block is what goes.
 */
const BLOCK_MIN_PX_PER_NM = 3.5

/** Oldest trail dot, as a fraction of the newest. */
const TRAIL_FADE_FLOOR = 0.18

const TRAIL_DOT_PX = 1.6

export function drawTargets(
  g: CanvasRenderingContext2D,
  cam: Camera,
  traffic: readonly Aircraft[],
  selected: string | null,
): void {
  // Two passes so that no target's data block can be buried under a
  // neighbour's trail, however close the two pass.
  for (const a of traffic) drawTrail(g, cam, a)
  for (const a of traffic) drawTarget(g, cam, a, a.callsign === selected)
}

/**
 * The radar history: one dot per sweep, fading with age.
 *
 * The fade is what makes a trail read as a direction at a glance rather
 * than as a row of dots, and it is also how speed is judged by eye -- the
 * dots of a fast aircraft are spaced further apart.
 */
function drawTrail(g: CanvasRenderingContext2D, cam: Camera, a: Aircraft): void {
  if (a.trail.length === 0) return

  g.fillStyle = theme.trail
  const oldest = a.trail.length
  for (let i = 0; i < a.trail.length; i += 1) {
    const age = (i + 1) / oldest
    g.globalAlpha = 1 - age * (1 - TRAIL_FADE_FLOOR)
    const p = cam.worldToScreen(a.trail[i] as { x: number; y: number })
    g.beginPath()
    g.arc(p.x, p.y, TRAIL_DOT_PX, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
}

function drawTarget(
  g: CanvasRenderingContext2D,
  cam: Camera,
  a: Aircraft,
  isSelected: boolean,
): void {
  const p = cam.worldToScreen(a.pos)
  // Selection is a change of ink rather than an extra mark, so a selected
  // target stays the same size and shape as every other one.
  const ink = isSelected ? theme.accent : theme.target

  // Where it will be in a minute. This is the single most useful mark on
  // an approach scope: two vectors that cross are two aircraft that will.
  const ahead = cam.worldToScreen(advance(a.pos, a.hdg, (a.gsKts / 60) * VECTOR_MINUTES))
  g.strokeStyle = ink
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(p.x, p.y)
  g.lineTo(ahead.x, ahead.y)
  g.stroke()

  // A correlated return: a square, filled once it is the target under the
  // controller's hand.
  g.beginPath()
  g.rect(p.x - TARGET_PX, p.y - TARGET_PX, TARGET_PX * 2, TARGET_PX * 2)
  if (isSelected) {
    g.fillStyle = ink
    g.fill()
  } else {
    g.lineWidth = 1.4
    g.stroke()
  }

  if (cam.pxPerNM >= BLOCK_MIN_PX_PER_NM) drawBlock(g, cam, a, p, ink)
}

/**
 * The three lines every approach controller reads off a target: who it is,
 * what level it is passing and where it is going, and how fast.
 */
export function blockLines(a: Aircraft): readonly string[] {
  const trend = trendOf(a.vsFpm)
  const glyph = trend === 'climb' ? '^' : 'v'

  // Only show a cleared level while the aircraft is still going there. A
  // block that permanently reads "070 070" is two thirds noise.
  const level = trend === 'level' ? modeC(a.altFt) : `${modeC(a.altFt)}${glyph}${modeC(a.clearedAltFt)}`

  // Rounded to five knots: the autopilot moves speed a knot and a half a
  // second, and a digit that changes every frame cannot be read.
  const speed = Math.round(a.gsKts / 5) * 5

  return [`${a.callsign}${isHeavy(a.wake) ? ' H' : ''}`, level, `${speed} ${a.type}`]
}

function drawBlock(
  g: CanvasRenderingContext2D,
  cam: Camera,
  a: Aircraft,
  p: Vec2Px,
  ink: string,
): void {
  const lines = blockLines(a)
  const size = 10
  const lead = 11
  const gap = size + 1

  // Up and to the right, the way a strip is written. Flipped to the left
  // near the right-hand edge so a block never runs off the display.
  const flip = p.x > cam.width - 90
  const dir = flip ? -1 : 1
  const x = p.x + dir * lead
  const top = p.y - gap

  g.strokeStyle = theme.trail
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(p.x + dir * (TARGET_PX + 1), p.y - 1)
  g.lineTo(x - dir * 2, top + gap * 0.4)
  g.stroke()

  g.fillStyle = ink
  g.font = fonts.label(size)
  g.textAlign = flip ? 'right' : 'left'
  g.textBaseline = 'middle'
  for (let i = 0; i < lines.length; i += 1) {
    g.fillText(lines[i] as string, x, top + i * gap)
  }
}
