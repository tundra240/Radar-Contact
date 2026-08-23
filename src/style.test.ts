import { describe, expect, it } from 'vitest'
import stylesheet from './style.css?raw'

/**
 * The stylesheet, checked for the one class of mistake that does not
 * announce itself.
 *
 * A missing closing brace is not a CSS error a browser reports. The parser
 * is inside a declaration block, so it consumes everything that follows --
 * every rule after the fault becomes a bad declaration in the unclosed
 * one -- and it keeps doing that to the end of the file. Nothing breaks
 * loudly. Several hundred lines of styling are simply absent, and the only
 * symptom is that some part of the interface looks wrong.
 *
 * That happened here: one rule lost its brace in a merge and took the whole
 * flat-chrome section and the tutorial's styling with it, which is why the
 * lesson tore the layout apart -- its overlay had no positioning, so it
 * became another item in a flex row. Two attempts went into the wrong
 * explanation before the stylesheet was measured rather than reasoned about.
 */

/** Strip comments, so a brace inside prose is not counted. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('the stylesheet', () => {
  it('closes every rule it opens', () => {
    const css = withoutComments(stylesheet)
    const opens = css.match(/\{/g)?.length ?? 0
    const closes = css.match(/\}/g)?.length ?? 0
    expect(opens).toBe(closes)
  })

  it('never closes a rule that was not open', () => {
    // Balanced totals are not enough on their own: an extra close early and
    // an extra open late would cancel out while still breaking the middle.
    let depth = 0
    let lowest = 0
    for (const ch of withoutComments(stylesheet)) {
      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1
      lowest = Math.min(lowest, depth)
    }
    expect(lowest).toBe(0)
    expect(depth).toBe(0)
  })

  it('closes every comment it opens', () => {
    // An unterminated comment swallows the rest of the file just as
    // silently, and this file is full of long prose ones.
    const opens = stylesheet.match(/\/\*/g)?.length ?? 0
    const closes = stylesheet.match(/\*\//g)?.length ?? 0
    expect(opens).toBe(closes)
  })

  it('nests no deeper than a media query', () => {
    // Plain CSS here by choice -- no preprocessor -- so anything at depth
    // three is a brace that has gone astray rather than a nested rule.
    let depth = 0
    let deepest = 0
    for (const ch of withoutComments(stylesheet)) {
      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1
      deepest = Math.max(deepest, depth)
    }
    expect(deepest).toBeLessThanOrEqual(2)
  })
})

describe('the logon choice notes', () => {
  const rule = (selector: string): string => {
    const escaped = selector.replace('.', '\\.')
    return new RegExp(escaped + '[^{]*\\{[^}]*\\}').exec(stylesheet)?.[0] ?? ''
  }

  it('gives them a slot so the panel cannot reflow', () => {
    // The line under each row changes as the cursor moves across the
    // choices, and its natural height differs by a line. Without a slot the
    // whole panel grew and shrank under the cursor.
    const notes = rule('.logon-sector-note')
    expect(notes).toMatch(/min-height/)
  })

  it('gives them a size, because nothing else does', () => {
    // .logon-note is only styled inside a .logon-check, so these two were
    // rendering at the browser default -- half again the size of anything
    // else on the panel.
    expect(rule('.logon-sector-note')).toMatch(/font-size/)
  })
})
