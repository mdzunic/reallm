// The two lines of DOM plumbing every overlay in `ui/` repeats. The UI layer is
// plain DOM: no framework, no `three` (SPEC-001 §4).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `#ui` itself is `pointer-events: none`; a test hook makes elements findable. */
export function testId<T extends HTMLElement>(node: T, id: string): T {
  node.dataset['testid'] = id;
  return node;
}
