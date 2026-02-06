import { LitElement, css, html } from 'lit'
import { property } from 'lit/decorators.js'

import { safeCustomElement } from '../decorators'
import { CopyIcon } from './icons/copy'

@safeCustomElement('copy-button')
export class CopyButton extends LitElement {
  @property({ type: String })
  copyText: string = 'Copy'
   
  static styles = css`
    vscode-button {
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-background);
      transform: scale(0.9);
    }
    vscode-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    vscode-button:focus {
      outline: #007fd4 1px solid;
    }
    .icon {
      width: 13px;
      margin: 0 5px 0 -5px;
      padding: 0;
    }
  `

  private onCopy(e: Event) {
    if (e.defaultPrevented) {
      e.preventDefault()
    }
    const event = new CustomEvent('onCopy')
    this.dispatchEvent(event)
  }

  render() {
    return html`
      <vscode-button appearance="secondary" @click=${this.onCopy}>
        ${CopyIcon} ${this.copyText}
      </vscode-button>
    `
  }
}
