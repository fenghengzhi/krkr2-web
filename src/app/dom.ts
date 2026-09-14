/** Preserve the text node during a held press; WebKit can otherwise cancel click. */
export function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}
