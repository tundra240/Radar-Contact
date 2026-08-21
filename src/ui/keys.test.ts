// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isTypingTarget, ownsSpace } from './keys'

/**
 * The scope's shortcuts are bare letters, which is period-correct and was
 * fine until the interface grew a text field: typing initials into the
 * logon window also released aircraft (N) and changed the display scheme
 * (D). This is the guard that stops it, so it is worth pinning properly.
 */

function make(html: string): HTMLElement {
  document.body.innerHTML = html
  const el = document.body.firstElementChild
  if (!(el instanceof HTMLElement)) throw new Error('no element')
  return el
}

describe('isTypingTarget', () => {
  it('claims a text field', () => {
    expect(isTypingTarget(make('<input type="text">'))).toBe(true)
  })

  it('claims a field with no type at all, which defaults to text', () => {
    expect(isTypingTarget(make('<input>'))).toBe(true)
  })

  it('claims the other typing controls', () => {
    expect(isTypingTarget(make('<textarea></textarea>'))).toBe(true)
    expect(isTypingTarget(make('<select></select>'))).toBe(true)
    expect(isTypingTarget(make('<div contenteditable="true"></div>'))).toBe(true)
    expect(isTypingTarget(make('<div contenteditable></div>'))).toBe(true)
  })

  it('leaves the controls you do not type into alone', () => {
    // A letter pressed while a checkbox has focus is still a shortcut --
    // the options menu is full of them and D should still switch scheme.
    expect(isTypingTarget(make('<input type="checkbox">'))).toBe(false)
    expect(isTypingTarget(make('<input type="radio">'))).toBe(false)
    expect(isTypingTarget(make('<button></button>'))).toBe(false)
    expect(isTypingTarget(make('<div></div>'))).toBe(false)
    // Explicitly switched off, so it is not being typed into.
    expect(isTypingTarget(make('<div contenteditable="false"></div>'))).toBe(false)
  })

  it('handles a target that is not an element', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(document)).toBe(false)
  })

  it('covers the actual logon field', () => {
    // The specific case that was broken: the initials box.
    const el = make('<input type="text" class="logon-input" maxlength="3">')
    expect(isTypingTarget(el)).toBe(true)
  })
})

describe('ownsSpace', () => {
  it('gives the space bar to a checkbox', () => {
    // Space is a checkbox's only keyboard control, so it cannot also pause.
    expect(ownsSpace(make('<input type="checkbox">'))).toBe(true)
    expect(ownsSpace(make('<input type="radio">'))).toBe(true)
  })

  it('gives it to a text field as well', () => {
    expect(ownsSpace(make('<input type="text">'))).toBe(true)
  })

  it('leaves it to the clock everywhere else', () => {
    // Including on a focused button: space always means pause there, which
    // is why the handler calls preventDefault rather than letting the
    // button fire again.
    expect(ownsSpace(make('<button></button>'))).toBe(false)
    expect(ownsSpace(make('<div></div>'))).toBe(false)
    expect(ownsSpace(null)).toBe(false)
  })
})
