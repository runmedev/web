import { LitElement, html } from 'lit'
import { property } from 'lit/decorators.js'

import { safeCustomElement } from '../../decorators'
import './actionButton'

@safeCustomElement('share-button')
export class ShareButton extends LitElement {
  @property({ type: Boolean, reflect: true })
  loading: boolean = false

  private handleClick(e: Event) {
    if (e.defaultPrevented) {
      e.preventDefault()
    }

    this.dispatchEvent(new CustomEvent('onClick'))
  }

  render() {
    return html`
      <action-button
        ?loading=${this.loading}
        text="Share"
        ?shareIcon=${true}
        @onClick="${this.handleClick}"
      >
      </action-button>
    `
  }
}
