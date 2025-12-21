import { LitElement, html } from 'lit'
import { property } from 'lit/decorators.js'

import { defineCustomElement } from '../../utils/defineCustomElement'
import './actionButton'

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

defineCustomElement('share-button', ShareButton)
