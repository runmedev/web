/**
 * A safe version of @customElement that checks if the element is already defined
 * before registering it. This prevents errors when the same module is imported multiple times.
 */
export function safeCustomElement(tagName: string) {
  return function <T extends CustomElementConstructor>(constructor: T): T {
    if (!customElements.get(tagName)) {
      customElements.define(tagName, constructor)
    }
    return constructor
  }
}
