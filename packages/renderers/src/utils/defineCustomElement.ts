export function defineCustomElement(
  tag: string,
  ctor: CustomElementConstructor
) {
  if (customElements.get(tag)) {
    return
  }
  customElements.define(tag, ctor)
}
