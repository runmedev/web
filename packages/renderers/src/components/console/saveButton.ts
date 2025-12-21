import { LitElement, html } from 'lit'
import { property } from 'lit/decorators.js'

import { defineCustomElement } from '../../utils/defineCustomElement'
import './actionButton'

export class SaveButton extends LitElement {
  @property({ type: Boolean, reflect: true })
  loading: boolean = false

  @property({ type: Boolean, reflect: true })
  signedIn: boolean = false

  private handleClick(e: Event) {
    if (e.defaultPrevented) {
      e.preventDefault()
    }

    this.dispatchEvent(new CustomEvent('onClick'))
  }

  render() {
    let text = this.signedIn ? 'Save' : 'Save to Cloud'

    return html`
      <action-button
        ?loading=${this.loading}
        text="${text}"
        ?saveIcon=${true}
        @onClick="${this.handleClick}"
      >
      </action-button>
    `
  }
}

defineCustomElement('save-button', SaveButton)
