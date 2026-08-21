// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CommandConsole } from './console'

/**
 * The console is a dumb terminal: it takes a line and shows what it is told
 * to show. So these tests are about the terminal behaviours -- history,
 * clearing, how a refusal is distinguished from a readback -- and not about
 * commands, which are parsed and judged elsewhere.
 */

interface Harness {
  cli: CommandConsole
  mount: HTMLElement
  submitted: string[]
}

// No cleanup hook: unlike the menu and the guide, the console adds no
// document-level listeners, so a stale one cannot answer events.
function mountConsole(): Harness {
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const submitted: string[] = []
  const cli = new CommandConsole({
    mount,
    placeholder: 'e.g. BAW123 H270',
    onSubmit: (line) => submitted.push(line),
  })
  return { cli, mount, submitted }
}

const input = (m: HTMLElement): HTMLInputElement => {
  const el = m.querySelector<HTMLInputElement>('.console-input')
  if (!el) throw new Error('no command line')
  return el
}

const lines = (m: HTMLElement): { text: string; kind: string }[] =>
  [...m.querySelectorAll('.console-line')].map((l) => ({
    text: l.textContent ?? '',
    kind: [...l.classList].find((c) => c.startsWith('is-')) ?? '',
  }))

function type(m: HTMLElement, value: string): void {
  input(m).value = value
}

function key(m: HTMLElement, k: string): void {
  input(m).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

describe('the prompt', () => {
  it('submits on Enter and clears the line', () => {
    const h = mountConsole()
    type(h.mount, 'BAW178 H270')
    key(h.mount, 'Enter')
    expect(h.submitted).toEqual(['BAW178 H270'])
    expect(input(h.mount).value).toBe('')
  })

  it('trims what it hands on', () => {
    const h = mountConsole()
    type(h.mount, '  BAW178 H270  ')
    key(h.mount, 'Enter')
    expect(h.submitted).toEqual(['BAW178 H270'])
  })

  it('ignores an empty line', () => {
    const h = mountConsole()
    key(h.mount, 'Enter')
    type(h.mount, '   ')
    key(h.mount, 'Enter')
    expect(h.submitted).toEqual([])
  })

  it('abandons a half-typed line on Escape', () => {
    const h = mountConsole()
    type(h.mount, 'BAW178 H2')
    key(h.mount, 'Escape')
    expect(input(h.mount).value).toBe('')
    expect(h.submitted).toEqual([])
  })

  it('carries a hint until something is typed', () => {
    expect(input(mountConsole().mount).placeholder).toBe('e.g. BAW123 H270')
  })
})

describe('history', () => {
  it('walks back through what was typed', () => {
    const h = mountConsole()
    for (const line of ['BAW178 H270', 'VIR45 A30']) {
      type(h.mount, line)
      key(h.mount, 'Enter')
    }
    key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('VIR45 A30')
    key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('BAW178 H270')
  })

  it('walks forward again, and back to what was being typed', () => {
    const h = mountConsole()
    type(h.mount, 'BAW178 H270')
    key(h.mount, 'Enter')
    type(h.mount, 'half typ')
    key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('BAW178 H270')
    key(h.mount, 'ArrowDown')
    expect(input(h.mount).value).toBe('half typ')
  })

  it('stops at the oldest line rather than wrapping', () => {
    const h = mountConsole()
    type(h.mount, 'only one')
    key(h.mount, 'Enter')
    for (let i = 0; i < 5; i += 1) key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('only one')
  })

  it('keeps a refused line, because it is usually nearly right', () => {
    const h = mountConsole()
    type(h.mount, 'BAW178 H999')
    key(h.mount, 'Enter')
    h.cli.write('BAW178: heading 999 is beyond 360', 'reject')
    key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('BAW178 H999')
  })

  it('does not store the same line twice in a row', () => {
    // Repeating a clearance is common and would otherwise make the up arrow
    // useless.
    const h = mountConsole()
    for (let i = 0; i < 3; i += 1) {
      type(h.mount, 'BAW178 S180')
      key(h.mount, 'Enter')
    }
    type(h.mount, 'VIR45 S180')
    key(h.mount, 'Enter')
    key(h.mount, 'ArrowUp')
    key(h.mount, 'ArrowUp')
    expect(input(h.mount).value).toBe('BAW178 S180')
  })

  it('does nothing on the arrows with no history', () => {
    const h = mountConsole()
    key(h.mount, 'ArrowUp')
    key(h.mount, 'ArrowDown')
    expect(input(h.mount).value).toBe('')
  })
})

describe('the log', () => {
  it('distinguishes a readback from a refusal', () => {
    // The one thing that must never look the same.
    const h = mountConsole()
    h.cli.write('BAW178 HEADING 270', 'readback')
    h.cli.write('BAW178: heading 999 is beyond 360', 'reject')
    const shown = lines(h.mount)
    expect(shown[0]?.kind).toBe('is-readback')
    expect(shown[1]?.kind).toBe('is-reject')
  })

  it('marks what was typed with a prompt', () => {
    const h = mountConsole()
    h.cli.write('BAW178 H270', 'command')
    expect(lines(h.mount)[0]?.text).toBe('> BAW178 H270')
  })

  it('does not prefix anything else', () => {
    const h = mountConsole()
    h.cli.write('on position', 'note')
    expect(lines(h.mount)[0]?.text).toBe('on position')
  })

  it('shows document text as text, never as markup', () => {
    const h = mountConsole()
    h.cli.write('<b>BAW178</b>', 'note')
    expect(h.mount.querySelector('.console-line b')).toBeNull()
    expect(lines(h.mount)[0]?.text).toBe('<b>BAW178</b>')
  })

  it('drops the oldest lines rather than growing without limit', () => {
    const h = mountConsole()
    for (let i = 0; i < 260; i += 1) h.cli.write(`line ${i}`, 'note')
    const shown = lines(h.mount)
    expect(shown.length).toBeLessThanOrEqual(200)
    // The newest survived and the oldest did not.
    expect(shown[shown.length - 1]?.text).toBe('line 259')
    expect(shown[0]?.text).not.toBe('line 0')
  })

  it('is announced to assistive technology as it changes', () => {
    const log = mountConsole().mount.querySelector('.console-log')
    expect(log?.getAttribute('role')).toBe('log')
    expect(log?.getAttribute('aria-live')).toBe('polite')
  })
})
