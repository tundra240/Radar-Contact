/**
 * Whether a keystroke is meant as a shortcut at all.
 *
 * The scope's shortcuts are bare letters -- R, D, M, N -- because that is
 * how displays of this era worked. The moment the interface grew a text
 * field, typing "N" into it also released an aircraft and "D" also changed
 * the display scheme. Every global handler asks this first.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  // The property is the right question but is not implemented everywhere
  // (jsdom, for one), so the attribute is checked as well. An explicit
  // "false" turns editing off and must not count.
  if (target.isContentEditable) return true
  const editable = target.getAttribute('contenteditable')
  if (editable !== null && editable !== 'false') return true

  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  // A checkbox is not something you type into: the space bar is its only
  // keyboard control, but a letter pressed over one is still a shortcut.
  const type = (target as HTMLInputElement).type
  return type !== 'checkbox' && type !== 'radio' && type !== 'button'
}

/**
 * Whether the space bar should be left to the focused control.
 *
 * A checkbox has no other way to be set from the keyboard, and the options
 * menu is full of them, so space belongs to the control rather than to the
 * clock whenever one has focus.
 */
export function ownsSpace(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true
  if (!(target instanceof HTMLInputElement)) return false
  return target.type === 'checkbox' || target.type === 'radio'
}
