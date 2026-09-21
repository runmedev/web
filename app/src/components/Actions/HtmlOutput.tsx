import { useEffect, useMemo, useRef, useState } from 'react'

/** Measure isolated HTML without granting same-origin or notebook API access. */
export function HtmlOutput({
  html,
  title,
  onDoubleClick,
}: {
  html: string
  title: string
  onDoubleClick?: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const nonce = useMemo(() => crypto.randomUUID(), [html])
  const [height, setHeight] = useState(120)
  const [expanded, setExpanded] = useState(false)
  const limit = expanded ? 10000 : 2000
  const srcDoc = useMemo(() => {
    const bridge = `<script>(()=>{const send=()=>parent.postMessage({type:'runme-output-height',nonce:${JSON.stringify(nonce)},height:Math.ceil(Math.max(document.body?.scrollHeight||0,document.body?.getBoundingClientRect().height||0))},'*');addEventListener('load',()=>{send();new ResizeObserver(send).observe(document.body);document.fonts?.ready.then(send)});})();</script>`
    // Insert at the beginning so the bridge is installed even for full HTML
    // documents. The iframe stays opaque-origin with only allow-scripts.
    // Iframe mouse events do not bubble to the reference cell. Forward this
    // presentation gesture through the same frame/nonce-checked channel.
    const gestures = `<script>addEventListener('dblclick',event=>{if(event.target instanceof Element && event.target.closest('a,button,input,textarea,select,summary,[contenteditable]'))return;parent.postMessage({type:'runme-output-dblclick',nonce:${JSON.stringify(nonce)}},'*')});</script>`
    return bridge + gestures + html
  }, [html, nonce])
  useEffect(() => {
    setHeight(120)
    setExpanded(false)
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (
        event.source !== frame.current?.contentWindow ||
        data?.nonce !== nonce
      )
        return
      if (data.type === 'runme-output-dblclick') {
        onDoubleClick?.()
        return
      }
      if (
        data.type !== 'runme-output-height' ||
        typeof data.height !== 'number' ||
        !Number.isFinite(data.height) ||
        data.height < 0
      )
        return
      setHeight(Math.min(10001, Math.ceil(data.height) + 20))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [nonce, onDoubleClick])
  return (
    <div className="min-w-0" data-testid="html-output">
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height: Math.min(height, limit) }}
        className="w-full rounded-md border border-nb-cell-border bg-white"
      />
      {height > 2000 && (
        <button
          type="button"
          className="nb-btn"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse output' : 'Expand output'}
        </button>
      )}
    </div>
  )
}
