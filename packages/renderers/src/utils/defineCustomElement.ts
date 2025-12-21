// defineCustomElement defines a custom element if it has not already been defined.
// The custom element gets defined as a side effect of importing the module.
// We were hitting problems (https://github.com/runmedev/web/pull/28) when trying
// to use RunmeConsole and ConsoleView by importing both
// runmedev/renderers and runmedev/react-console because runmedev/react-console was
// importing its own copy of runmedev/renderers causing the custom element to be defined twice
// leading to the error
// Uncaught DOMException: Failed to execute 'define' on 'CustomElementRegistry': the name "console-view" has already been used with this registry
export function defineCustomElement(
  tag: string,
  ctor: CustomElementConstructor
) {
  if (customElements.get(tag)) {
    return
  }
  customElements.define(tag, ctor)
}
