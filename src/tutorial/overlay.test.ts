// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import stylesheet from '../style.css?raw'
import { holeAround, holeOfElement, TutorialOverlay } from './overlay'

function mount(): {
  overlay: TutorialOverlay
  root: HTMLElement
  onContinue: () => void
  continued: () => number
  exited: () => number
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let continues = 0
  let exits = 0
  const overlay = new TutorialOverlay({
    mount: host,
    onContinue: () => {
      continues += 1
    },
    onExit: () => {
      exits += 1
    },
  })
  return {
    overlay,
    root: overlay.element,
    onContinue: () => {},
    continued: () => continues,
    exited: () => exits,
  }
}

const CARD = {
  title: 'Holding pattern',
  counter: 'Step 4 of 16',
  text: 'The flight has entered the published hold.',
  button: 'Continue' as string | null,
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the instruction card', () => {
  it('starts hidden', () => {
    // A lesson nobody asked for should not be on the screen.
    const { overlay, root } = mount()
    expect(overlay.isOpen).toBe(false)
    expect(root.hidden).toBe(true)
  })

  it('shows the title, the count and the instruction', () => {
    const { overlay, root } = mount()
    overlay.show(CARD)
    expect(overlay.isOpen).toBe(true)
    expect(root.querySelector('.tutorial-title')?.textContent).toBe('Holding pattern')
    expect(root.querySelector('.tutorial-counter')?.textContent).toBe('Step 4 of 16')
    expect(root.querySelector('.tutorial-text')?.textContent).toContain('published hold')
  })

  it('shows the button when the step has one', () => {
    const { overlay, root } = mount()
    overlay.show(CARD)
    const button = root.querySelector<HTMLButtonElement>('.tutorial-continue')
    expect(button?.hidden).toBe(false)
    expect(button?.textContent).toBe('Continue')
  })

  it('hides the button rather than disabling it on an action step', () => {
    // A control that cannot be pressed still invites pressing, and the
    // instruction already says what to do.
    const { overlay, root } = mount()
    overlay.show({ ...CARD, button: null })
    expect(root.querySelector<HTMLButtonElement>('.tutorial-continue')?.hidden).toBe(true)
  })

  it('reports the button being pressed', () => {
    const { overlay, root, continued } = mount()
    overlay.show(CARD)
    root.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    expect(continued()).toBe(1)
  })

  it('offers a way out of the lesson', () => {
    const { overlay, root, exited } = mount()
    overlay.show(CARD)
    root.querySelector<HTMLButtonElement>('.tutorial-close')?.click()
    expect(exited()).toBe(1)
  })

  it('repaints in place rather than being rebuilt', () => {
    // The card is one element for the whole lesson: rebuilding it every
    // step would lose focus and restart the transition on every advance.
    const { overlay, root } = mount()
    overlay.show(CARD)
    const first = root.querySelector('.tutorial-title')
    overlay.paint({ ...CARD, title: 'Base leg', counter: 'Step 9 of 16' })
    expect(root.querySelector('.tutorial-title')).toBe(first)
    expect(first?.textContent).toBe('Base leg')
  })
})

describe('the spotlight mask', () => {
  it('cuts a hole for each thing the step points at', () => {
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([
      { x: 10, y: 20, w: 30, h: 30 },
      { x: 100, y: 200, w: 40, h: 40 },
    ])
    // One cut-out in the mask and one bright ring for each.
    expect(root.querySelectorAll('mask rect')).toHaveLength(3) // the ground, plus two holes
    expect(root.querySelectorAll('.tutorial-ring')).toHaveLength(2)
  })

  it('darkens nothing when the step points at nothing', () => {
    // A step with no spotlight should not black out the display.
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([])
    expect(root.querySelector('.tutorial-shade')?.getAttribute('opacity')).toBe('0')
  })

  it('darkens the display once there is a hole to look through', () => {
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([{ x: 0, y: 0, w: 10, h: 10 }])
    expect(root.querySelector('.tutorial-shade')?.getAttribute('opacity')).toBe('1')
  })

  it('replaces the holes rather than adding to them', () => {
    // An aircraft moves under the mask twenty times a second, so this is
    // called constantly and must not accumulate.
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([{ x: 0, y: 0, w: 10, h: 10 }])
    overlay.place([{ x: 50, y: 50, w: 10, h: 10 }])
    expect(root.querySelectorAll('.tutorial-ring')).toHaveLength(1)
  })

  it('leaves a margin round what it highlights', () => {
    // The ring goes outside the control, not through it.
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([{ x: 100, y: 100, w: 20, h: 20 }])
    const ring = root.querySelector('.tutorial-ring')
    expect(Number(ring?.getAttribute('x'))).toBeLessThan(100)
    expect(Number(ring?.getAttribute('width'))).toBeGreaterThan(20)
  })

  it('never takes a click', () => {
    // Darkening the display says "look here". It must not stop the
    // controller panning the scope while they read about it.
    const { overlay, root } = mount()
    overlay.show(CARD)
    expect(root.querySelector('.tutorial-mask')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('clears the holes when the lesson ends', () => {
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.place([{ x: 0, y: 0, w: 10, h: 10 }])
    overlay.hide()
    expect(overlay.isOpen).toBe(false)
    expect(root.querySelectorAll('.tutorial-ring')).toHaveLength(0)
  })
})

describe('the reset notice', () => {
  it('appears and then goes away by itself', () => {
    // A player who has just lost separation has enough to do without
    // dismissing a dialog.
    vi.useFakeTimers()
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.toast('Step reset -- separation lost.', 1000)
    const toast = root.querySelector<HTMLElement>('.tutorial-toast')
    expect(toast?.hidden).toBe(false)
    expect(toast?.textContent).toContain('separation lost')
    vi.advanceTimersByTime(1100)
    expect(toast?.hidden).toBe(true)
    vi.useRealTimers()
  })

  it('replaces one already showing rather than queueing', () => {
    vi.useFakeTimers()
    const { overlay, root } = mount()
    overlay.show(CARD)
    overlay.toast('first', 1000)
    overlay.toast('second', 1000)
    expect(root.querySelector('.tutorial-toast')?.textContent).toBe('second')
    vi.useRealTimers()
  })
})

describe('working out where a hole goes', () => {
  it('finds a control by selector and takes its rectangle', () => {
    const button = document.createElement('button')
    button.className = 'rate-button'
    document.body.appendChild(button)
    // jsdom lays nothing out, so the size is stubbed. What is being tested
    // is that the hole comes from the element rather than from a constant.
    button.getBoundingClientRect = (): DOMRect =>
      ({ x: 4, y: 70, width: 30, height: 30 }) as DOMRect
    expect(holeOfElement('.rate-button')).toEqual({ x: 4, y: 70, w: 30, h: 30, r: 4 })
  })

  it('gives no hole for a control that is not on the screen', () => {
    // A hole around something with no size would be a bright square in the
    // corner of the display, pointing at nothing.
    const hidden = document.createElement('button')
    hidden.className = 'gone-button'
    hidden.hidden = true
    document.body.appendChild(hidden)
    expect(holeOfElement('.gone-button')).toBeNull()
  })

  it('returns nothing for a control that is not there', () => {
    expect(holeOfElement('.no-such-thing')).toBeNull()
  })

  it('centres a round hole on a point, for things drawn on canvas', () => {
    const hole = holeAround({ x: 200, y: 150 }, 96)
    expect(hole.x).toBe(152)
    expect(hole.y).toBe(102)
    expect(hole.w).toBe(96)
    // A circle, asked for as one. It used to be a rectangle with a corner
    // radius of half its width, which only reads as a circle before the
    // padding is added -- and the padding is added to the width and the
    // height, so it came out a rounded square at a different amount for
    // every size.
    expect(hole.round).toBe(true)
  })

  it('cuts a real circle for a round hole', () => {
    const overlay = new TutorialOverlay({
      mount: document.body,
      onContinue: () => {},
      onExit: () => {},
    })
    overlay.show({ title: 't', counter: 'Step 1 of 1', text: 'x', button: null })
    overlay.place([holeAround({ x: 400, y: 300 }, 96)])
    const ring = overlay.element.querySelector('.tutorial-ring')
    expect(ring?.tagName.toLowerCase()).toBe('circle')
    // Centred where it was asked for, whatever the padding does to the size.
    expect(Number(ring?.getAttribute('cx'))).toBe(400)
    expect(Number(ring?.getAttribute('cy'))).toBe(300)
  })

  it('still cuts a rectangle for a control', () => {
    const overlay = new TutorialOverlay({
      mount: document.body,
      onContinue: () => {},
      onExit: () => {},
    })
    overlay.show({ title: 't', counter: 'Step 1 of 1', text: 'x', button: null })
    overlay.place([{ x: 10, y: 20, w: 30, h: 12 }])
    expect(overlay.element.querySelector('.tutorial-ring')?.tagName.toLowerCase()).toBe('rect')
  })
})

describe('staying out of the way of the display', () => {
  /**
   * The stylesheet, read as text.
   *
   * jsdom computes no layout, so the only way to hold this rule is to
   * assert the declaration exists. Worth doing: the bug it guards took the
   * whole interface apart the first time the lesson was opened.
   */
  const css = stylesheet

  it('takes the overlay out of the flow', () => {
    // #app is a flex row -- the scope in one column, the strip bay in the
    // other. A wrapper appended to it with no positioning becomes a third
    // flex item and takes width off both of them, which is exactly what
    // happened: showing the lesson rearranged the display.
    const rule = /\.tutorial\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/pointer-events:\s*none/)
  })

  it('lets the card be clicked even though the mask cannot be', () => {
    // The mask must not eat a click meant for the control it is drawing a
    // ring around, and the card's own button still has to work.
    const rule = /\.tutorial-card\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toMatch(/pointer-events:\s*auto/)
  })

  it('adds exactly one element to whatever it is mounted in', () => {
    // However the overlay is built inside itself, the host sees one child.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const before = host.childElementCount
    const overlay = new TutorialOverlay({
      mount: host,
      onContinue: () => {},
      onExit: () => {},
    })
    overlay.show({ title: 't', counter: 'Step 1 of 1', text: 'x', button: null })
    expect(host.childElementCount).toBe(before + 1)
  })
})
