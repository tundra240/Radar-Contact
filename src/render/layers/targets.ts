import type { Camera, Vec2Px } from '../../core/camera'
import {
  advance,
  bearingDeg,
  distanceNM,
  headingLabel,
  normalizeHeading,
  type Vec2NM,
} from '../../core/geo'
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

/* The data block's metrics, shared by the draw and the hit test. */
const BLOCK_FONT_PX = 10
const BLOCK_LINE_PX = 11
/** Gap between the target symbol and the first character of the block. */
const BLOCK_LEAD_PX = 11
/** How close to the right edge a target has to be before its block flips. */
const BLOCK_FLIP_MARGIN_PX = 90
/** Monospace advance as a fraction of the font size, as scope.ts assumes. */
const CHAR_ADVANCE = 0.6

/**
 * How close a click has to be to count. Pointing at a moving target is
 * not a precision task, so the symbol picks up well outside its own eight
 * pixels.
 */
export const PICK_RADIUS_PX = 12
/** The same forgiveness around the edges of a data block. */
const PICK_SLOP_PX = 2

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

/**
 * The data block's screen rectangle.
 *
 * Shared by the draw and the hit test on purpose. The block is the biggest
 * part of a target and the part a controller actually points at, so it has
 * to be clickable -- and a hit test that computed its own idea of where
 * the text sits would drift away from the text the moment either changed.
 */
export function blockBox(
  cam: Camera,
  a: Aircraft,
  p: Vec2Px,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly flip: boolean } {
  const lines = blockLines(a)
  const cols = Math.max(...lines.map((l) => l.length))
  const w = cols * BLOCK_FONT_PX * CHAR_ADVANCE
  const h = lines.length * BLOCK_LINE_PX

  // Up and to the right, the way a strip is written. Flipped to the left
  // near the right-hand edge so a block never runs off the display.
  const flip = p.x > cam.width - BLOCK_FLIP_MARGIN_PX
  const x = flip ? p.x - BLOCK_LEAD_PX - w : p.x + BLOCK_LEAD_PX
  return { x, y: p.y - BLOCK_LINE_PX * 1.5, w, h, flip }
}

function drawBlock(
  g: CanvasRenderingContext2D,
  cam: Camera,
  a: Aircraft,
  p: Vec2Px,
  ink: string,
): void {
  const lines = blockLines(a)
  const box = blockBox(cam, a, p)
  const dir = box.flip ? -1 : 1
  // The text hangs off whichever edge of the box faces the target.
  const anchorX = box.flip ? box.x + box.w : box.x

  g.strokeStyle = theme.trail
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(p.x + dir * (TARGET_PX + 1), p.y - 1)
  g.lineTo(anchorX - dir * 2, box.y + BLOCK_LINE_PX * 0.4)
  g.stroke()

  g.fillStyle = ink
  g.font = fonts.label(BLOCK_FONT_PX)
  g.textAlign = box.flip ? 'right' : 'left'
  g.textBaseline = 'middle'
  for (let i = 0; i < lines.length; i += 1) {
    g.fillText(lines[i] as string, anchorX, box.y + BLOCK_LINE_PX * (i + 0.5))
  }
}

/**
 * Which aircraft is under a screen point, or null for empty scope.
 *
 * The symbol gets a radius rather than its exact eight pixels, because
 * pointing at a moving target with a mouse is not a precision task, and
 * the block counts as part of the target for the same reason. Ties go to
 * whichever symbol is nearest, so two overlapping blocks resolve to the
 * aircraft the cursor is actually closest to.
 *
 * `prefer` breaks the tie differently: if that callsign is among the hits
 * it wins outright. Four aircraft stacked over the same fix are within a
 * mile of each other, which at a normal range is inside the pick radius --
 * so without this, picking one out of a stack and then dragging a vector
 * off it could quietly turn its neighbour. Selecting from the strip and
 * then dragging on the scope is the way a stack is worked, and this is what
 * makes that hold together.
 */
export function pickTarget(
  cam: Camera,
  traffic: readonly Aircraft[],
  at: Vec2Px,
  radiusPx = PICK_RADIUS_PX,
  prefer: string | null = null,
): Aircraft | null {
  let best: Aircraft | null = null
  let nearest = Infinity
  let preferred: Aircraft | null = null

  for (const a of traffic) {
    const p = cam.worldToScreen(a.pos)
    const away = Math.hypot(at.x - p.x, at.y - p.y)

    let hit = away <= radiusPx
    // Only when the block is actually drawn: an invisible block that can
    // still be clicked is a trap.
    if (!hit && cam.pxPerNM >= BLOCK_MIN_PX_PER_NM) {
      const box = blockBox(cam, a, p)
      hit =
        at.x >= box.x - PICK_SLOP_PX &&
        at.x <= box.x + box.w + PICK_SLOP_PX &&
        at.y >= box.y - PICK_SLOP_PX &&
        at.y <= box.y + box.h + PICK_SLOP_PX
    }

    if (!hit) continue
    if (a.callsign === prefer) preferred = a
    if (away < nearest) {
      best = a
      nearest = away
    }
  }
  return preferred ?? best
}

/* ----------------------------------------------------- vectoring by hand */

/** A vector being dragged out of a target with the mouse. */
export interface VectorDrag {
  readonly aircraft: Aircraft
  /** Where the cursor is, in the canvas's own pixels. */
  readonly toPx: Vec2Px
}

/** Written as an escape so this file stays ASCII, as the strip bay does. */
const DEGREE = String.fromCharCode(0xb0)

const DRAG_FONT_PX = 11
const DRAG_PAD_PX = 4
/** Clear of the cursor, so the readout is never under the pointer. */
const DRAG_OFFSET_PX = 14
const DRAG_ORIGIN_PX = 3

/**
 * The heading a drag would issue: from where the aircraft is now to where
 * the cursor is.
 *
 * True, not magnetic. Every heading in the simulation is true -- the tag
 * menu's, the console's, the hold inbound legs -- and `magVarDeg` is zero
 * at Heathrow in the config, so the two coincide exactly. Converting here
 * alone would make a dragged vector disagree with a typed one the day that
 * value changed; making the display magnetic is a change that belongs in
 * every heading at once, not in one input path.
 */
export function dragHeading(a: Aircraft, toWorld: Vec2NM): number {
  return normalizeHeading(Math.round(bearingDeg(a.pos, toWorld)))
}

/**
 * The elastic line: the aircraft, the cursor, and the clearance that
 * releasing would issue.
 *
 * Drawn from the aircraft's live position rather than from where it was
 * when the drag started, so the line stays attached to a target that is
 * still flying -- which it is, because the simulation does not stop for
 * the mouse.
 */
export function drawVectorDrag(
  g: CanvasRenderingContext2D,
  cam: Camera,
  drag: VectorDrag,
): void {
  const from = cam.worldToScreen(drag.aircraft.pos)
  const to = drag.toPx
  const world = cam.screenToWorld(to)

  // Dashed, and in the attention colour: this is a proposal, not something
  // that is on the map.
  g.strokeStyle = theme.accent
  g.lineWidth = 1.4
  g.setLineDash([6, 4])
  g.beginPath()
  g.moveTo(from.x, from.y)
  g.lineTo(to.x, to.y)
  g.stroke()
  g.setLineDash([])

  // Anchored on the aircraft, so which one is being turned is unambiguous
  // even where two targets overlap.
  g.fillStyle = theme.accent
  g.beginPath()
  g.arc(from.x, from.y, DRAG_ORIGIN_PX, 0, Math.PI * 2)
  g.fill()

  const text = `${headingLabel(dragHeading(drag.aircraft, world))}${DEGREE}  ${distanceNM(
    drag.aircraft.pos,
    world,
  ).toFixed(1)} NM`
  drawDragReadout(g, cam, to, text)
}

function drawDragReadout(
  g: CanvasRenderingContext2D,
  cam: Camera,
  at: Vec2Px,
  text: string,
): void {
  const w = text.length * DRAG_FONT_PX * CHAR_ADVANCE + DRAG_PAD_PX * 2
  const h = DRAG_FONT_PX + DRAG_PAD_PX * 2

  // Beside the cursor, and on the other side of it near an edge, so the
  // readout is never the thing that runs off the display.
  const x =
    at.x + DRAG_OFFSET_PX + w > cam.width ? at.x - DRAG_OFFSET_PX - w : at.x + DRAG_OFFSET_PX
  const y = at.y - DRAG_OFFSET_PX - h < 0 ? at.y + DRAG_OFFSET_PX : at.y - DRAG_OFFSET_PX - h

  // Filled with the ground colour first: a heading read off a readout that
  // has airspace boundaries running through it is a heading read wrong.
  g.fillStyle = theme.bg
  g.fillRect(x, y, w, h)
  g.strokeStyle = theme.accent
  g.lineWidth = 1
  g.beginPath()
  g.rect(x, y, w, h)
  g.stroke()

  g.fillStyle = theme.accent
  g.font = fonts.bold(DRAG_FONT_PX)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(text, x + DRAG_PAD_PX, y + h / 2)
}
