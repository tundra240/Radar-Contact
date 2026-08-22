// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Guide } from './guide'

/**
 * The guide is a book button and a window. The property worth defending is
 * that its contents come from the document it was handed and from nowhere
 * else -- so a person editing that file changes what the game shows.
 */

const SOURCE = [
  '# How to play',
  '',
  'Turn four streams into one sequence.',
  '',
  '## The stacks',
  '',
  '| Fix | Where |',
  '|---|---|',
  '| BNN | north |',
].join('\n')

let live: Guide | null = null

function mountGuide(source = SOURCE, note?: string): { guide: Guide; mount: HTMLElement } {
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const guide = new Guide(
    note === undefined
      ? { mount, source, title: 'EGLL approach -- how to play' }
      : { mount, source, title: 'EGLL approach -- how to play', note },
  )
  live = guide
  return { guide, mount }
}

afterEach(() => {
  live?.destroy()
  live = null
})

const button = (m: HTMLElement): HTMLButtonElement => {
  const b = m.querySelector<HTMLButtonElement>('.guide-button')
  if (!b) throw new Error('no guide button')
  return b
}

const win = (m: HTMLElement): HTMLElement => {
  const w = m.querySelector<HTMLElement>('.guide-window')
  if (!w) throw new Error('no guide window')
  return w
}

const press = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('the book button', () => {
  it('is a drawn book rather than an emoji', () => {
    // An emoji renders in whatever colour and weight the platform feels
    // like, which is never the rail's. This one is a path that takes the
    // button's own colour.
    const b = button(mountGuide().mount)
    const glyph = b.querySelector('svg.tool-icon')
    expect(glyph).not.toBeNull()
    expect(glyph?.querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(b.textContent).not.toContain(String.fromCodePoint(0x1f4d6))
  })

  it('hides the glyph from a screen reader, which cannot read a shape', () => {
    const glyph = button(mountGuide().mount).querySelector('svg.tool-icon')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
  })

  it('says what it is, for anyone not seeing the glyph', () => {
    const b = button(mountGuide().mount)
    expect(b.getAttribute('aria-label')).toBe('How to play')
    expect(b.title).toBe('How to play')
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('starts closed and toggles', () => {
    const { guide, mount } = mountGuide()
    expect(win(mount).hidden).toBe(true)
    expect(button(mount).getAttribute('aria-expanded')).toBe('false')

    button(mount).click()
    expect(guide.open).toBe(true)
    expect(win(mount).hidden).toBe(false)
    expect(button(mount).getAttribute('aria-expanded')).toBe('true')

    button(mount).click()
    expect(guide.open).toBe(false)
  })

  it('reads as pressed in while the window is up', () => {
    const { guide, mount } = mountGuide()
    guide.setOpen(true)
    expect(button(mount).classList.contains('is-open')).toBe(true)
  })
})

describe('the window', () => {
  it('renders the document it was given', () => {
    const { guide, mount } = mountGuide()
    guide.setOpen(true)
    const body = mount.querySelector('.guide-body')
    expect(body?.querySelector('h1')?.textContent).toBe('How to play')
    expect(body?.querySelector('table')).not.toBeNull()
    expect(body?.textContent).toContain('one sequence')
  })

  it('shows a different document without any change to the code', () => {
    // The point of the whole feature: swap the file, swap the guide.
    const { guide, mount } = mountGuide('# Something else\n\nEntirely.')
    guide.setOpen(true)
    expect(mount.querySelector('.guide-body h1')?.textContent).toBe('Something else')
  })

  it('says where to edit what is on screen, when told to', () => {
    const { mount } = mountGuide(SOURCE, 'This guide is TUTORIAL.md.')
    expect(mount.querySelector('.guide-note')?.textContent).toBe('This guide is TUTORIAL.md.')
  })

  it('leaves the note out when there is none', () => {
    expect(mountGuide().mount.querySelector('.guide-note')).toBeNull()
  })

  it('names itself in the caption', () => {
    const { mount } = mountGuide()
    expect(mount.querySelector('.guide-caption')?.textContent).toContain('how to play')
    expect(win(mount).getAttribute('role')).toBe('dialog')
  })

  it('closes on Escape', () => {
    const { guide } = mountGuide()
    guide.setOpen(true)
    press('Escape')
    expect(guide.open).toBe(false)
  })

  it('closes from its own close button', () => {
    const { guide, mount } = mountGuide()
    guide.setOpen(true)
    mount.querySelector<HTMLButtonElement>('.guide-close')?.click()
    expect(guide.open).toBe(false)
  })

  it('closes when something else is clicked', () => {
    const { guide } = mountGuide()
    guide.setOpen(true)
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(guide.open).toBe(false)
  })

  it('stays open while it is being read', () => {
    // Scrolling and selecting text inside the window must not dismiss it.
    const { guide, mount } = mountGuide()
    guide.setOpen(true)
    mount
      .querySelector('.guide-body')
      ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(guide.open).toBe(true)
  })

  it('takes itself out of the document when destroyed', () => {
    const { guide, mount } = mountGuide()
    guide.destroy()
    expect(mount.querySelector('.guide')).toBeNull()
    expect(() => press('Escape')).not.toThrow()
  })
})
