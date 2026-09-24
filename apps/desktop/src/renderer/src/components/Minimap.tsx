import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useBrain } from '../store.js'

const SIZE = 176

/**
 * Bottom-right minimap: a 2-hop overview of the graph around the focus,
 * drawn from the pure ringLayout in @the-brain/core. Click a dot to focus it.
 */
export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const minimap = useBrain((s) => s.minimap)
  const inspectorOpen = useBrain((s) => s.inspectorOpen)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !minimap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, SIZE, SIZE)

    const scale = (SIZE / 2 - 12) / Math.max(minimap.extent, 1)
    const px = (x: number) => SIZE / 2 + x * scale
    const py = (y: number) => SIZE / 2 + y * scale
    const at = new Map(minimap.nodes.map((n) => [n.id, n]))

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
    ctx.lineWidth = 1
    for (const [a, b] of minimap.edges) {
      const na = at.get(a)
      const nb = at.get(b)
      if (!na || !nb) continue
      ctx.beginPath()
      ctx.moveTo(px(na.x), py(na.y))
      ctx.lineTo(px(nb.x), py(nb.y))
      ctx.stroke()
    }

    for (const n of minimap.nodes) {
      const focus = n.depth === 0
      ctx.beginPath()
      ctx.arc(px(n.x), py(n.y), focus ? 5 : 3, 0, Math.PI * 2)
      ctx.fillStyle = focus ? '#e2e8f0' : n.color ?? (n.depth === 1 ? '#7dd3fc' : '#64748b')
      ctx.fill()
      if (focus) {
        ctx.strokeStyle = '#818cf8'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
  }, [minimap])

  if (!minimap) return null

  const onClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !minimap) return
    const rect = canvas.getBoundingClientRect()
    const scale = (SIZE / 2 - 12) / Math.max(minimap.extent, 1)
    const mx = (e.clientX - rect.left - SIZE / 2) / scale
    const my = (e.clientY - rect.top - SIZE / 2) / scale
    let best: { id: string; d: number } | null = null
    for (const n of minimap.nodes) {
      const d = Math.hypot(n.x - mx, n.y - my)
      if (d < 14 && (!best || d < best.d)) best = { id: n.id, d }
    }
    if (best && best.id !== useBrain.getState().focusId)
      void useBrain.getState().focus(best.id)
  }

  return (
    <div className="minimap" style={{ right: inspectorOpen ? 330 : 14 }}>
      <canvas ref={canvasRef} width={SIZE} height={SIZE} onClick={onClick} />
      <span className="label">2-hop overview</span>
    </div>
  )
}
