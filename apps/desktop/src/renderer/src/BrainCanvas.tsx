import { useEffect, useRef } from 'react'
import { useBrain } from './store.js'
import { typeIcon } from './typeIcons.js'
import type { Layout, PositionedNode, PositionedEdge, Side } from '@the-brain/core'

const ROLE_COLOR: Record<PositionedNode['role'], string> = {
  focus: '#ffffff',
  parent: '#7cc4a1',
  child: '#5aa2ff',
  jump: '#d78bff',
  sibling: '#ffbe5c'
}

interface Display {
  x: number
  y: number
  w: number
  h: number
  alpha: number
}

/** An in-progress drag-to-link gesture, in canvas screen pixels. */
interface Drag {
  fromId: string
  sx: number
  sy: number
  mx: number
  my: number
  shift: boolean
  active: boolean
  overId: string | null
}

/**
 * Canvas 2D renderer for the dynamic grid. It keeps a set of animated
 * "display" boxes that ease toward the latest layout targets every frame, so
 * changing the focus produces TheBrain-like flowing transitions.
 */
export function BrainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layoutRef = useRef<Layout | null>(null)
  const focusRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const displayRef = useRef<Map<string, Display>>(new Map())
  const dragRef = useRef<Drag | null>(null)
  const suppressClickRef = useRef(false)

  layoutRef.current = useBrain((s) => s.layout)
  focusRef.current = useBrain((s) => s.focusId)
  selectedRef.current = useBrain((s) => s.selectedId)
  const focus = useBrain((s) => s.focus)

  // Seed / retire display boxes when the layout changes.
  useEffect(() => {
    const layout = layoutRef.current
    if (!layout) return
    const disp = displayRef.current
    const ids = new Set<string>()
    for (const n of layout.nodes) {
      ids.add(n.id)
      if (!disp.has(n.id)) {
        // New nodes start collapsed at the center and fade in.
        disp.set(n.id, { x: 0, y: 0, w: n.w, h: n.h, alpha: 0 })
      }
      const d = disp.get(n.id)!
      d.w = n.w
      d.h = n.h
    }
    for (const id of [...disp.keys()]) if (!ids.has(id)) disp.delete(id)
  }, [layoutRef.current?.nodes.length, focusRef.current])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let running = true

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const frame = () => {
      if (!running) return
      const layout = layoutRef.current
      const rect = canvas.getBoundingClientRect()
      const W = rect.width
      const H = rect.height
      ctx.clearRect(0, 0, W, H)

      if (layout) {
        const disp = displayRef.current
        const cx = W / 2
        const cy = H / 2
        const pad = 120
        const scale = Math.min(
          1,
          (W - pad) / Math.max(1, layout.bounds.width),
          (H - pad) / Math.max(1, layout.bounds.height)
        )

        // Ease display boxes toward targets.
        for (const n of layout.nodes) {
          const d = disp.get(n.id)
          if (!d) continue
          const s = 0.25
          d.x += (n.x - d.x) * s
          d.y += (n.y - d.y) * s
          d.alpha += (1 - d.alpha) * 0.2
        }

        // Edges first, under nodes. Drawn between the animated source/target
        // boxes so parent->sibling links follow the parent, not the focus.
        for (const e of layout.edges) {
          const s = disp.get(e.sourceId)
          const t = disp.get(e.targetId)
          if (!s || !t) continue
          drawEdge(ctx, project(s, cx, cy, scale), project(t, cx, cy, scale), e)
        }

        // Gates on the focus: parent above, child below, jump to the left.
        const counts = { parent: 0, child: 0, jump: 0 }
        for (const n of layout.nodes) {
          if (n.role === 'parent') counts.parent++
          else if (n.role === 'child') counts.child++
          else if (n.role === 'jump') counts.jump++
        }
        const fd = disp.get(layout.byId[focusRef.current ?? '']?.id ?? '')
        if (fd) drawGates(ctx, project(fd, cx, cy, scale), counts)

        // Nodes.
        for (const n of layout.nodes) {
          const d = disp.get(n.id)
          if (!d) continue
          const isFocus = n.id === focusRef.current
          const isSelected = n.id === selectedRef.current
          drawNode(ctx, project(d, cx, cy, scale), n, d.alpha, isFocus, isSelected)
        }

        // Drag-to-link rubber band, above the nodes.
        const drag = dragRef.current
        if (drag?.active) {
          const src = disp.get(drag.fromId)
          const color = drag.shift ? ROLE_COLOR.parent : ROLE_COLOR.jump
          if (drag.overId && drag.overId !== drag.fromId) {
            const over = disp.get(drag.overId)
            if (over) {
              const b = project(over, cx, cy, scale)
              ctx.save()
              ctx.strokeStyle = color
              ctx.setLineDash([5, 4])
              ctx.lineWidth = 1.8
              ctx.beginPath()
              roundRect(ctx, b.cx - b.w / 2 - 4, b.cy - b.h / 2 - 4, b.w + 8, b.h + 8, 12)
              ctx.stroke()
              ctx.restore()
            }
          }
          if (src) {
            const b = project(src, cx, cy, scale)
            ctx.save()
            ctx.strokeStyle = hexA(color, 0.85)
            ctx.setLineDash([6, 5])
            ctx.lineWidth = 1.6
            ctx.beginPath()
            ctx.moveTo(b.cx, b.cy)
            ctx.quadraticCurveTo(
              (b.cx + drag.mx) / 2,
              (b.cy + drag.my) / 2 + 18,
              drag.mx,
              drag.my
            )
            ctx.stroke()
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(drag.mx, drag.my, 3, 0, Math.PI * 2)
            ctx.fill()
            ctx.restore()
          }
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // Convert a client point to layout coordinates (null if no layout yet).
  const toLayout = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const layout = layoutRef.current
    const canvas = canvasRef.current
    if (!layout || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const pad = 120
    const scale = Math.min(
      1,
      (rect.width - pad) / Math.max(1, layout.bounds.width),
      (rect.height - pad) / Math.max(1, layout.bounds.height)
    )
    return { x: (clientX - rect.left - cx) / scale, y: (clientY - rect.top - cy) / scale }
  }

  // Map a raw mouse event to a thought id (if any node box contains it).
  const hitTest = (clientX: number, clientY: number): string | null => {
    const layout = layoutRef.current
    const p = toLayout(clientX, clientY)
    if (!layout || !p) return null
    for (const n of layout.nodes) {
      if (Math.abs(p.x - n.x) <= n.w / 2 && Math.abs(p.y - n.y) <= n.h / 2) return n.id
    }
    return null
  }

  // Gate / zone routing for clicks that miss every node (TheBrain: click a
  // zone or its gate to create a thought already linked in that direction).
  const zoneAt = (clientX: number, clientY: number) => {
    const layout = layoutRef.current
    const st = useBrain.getState()
    const f = layout?.byId[st.focusId ?? '']
    const p = toLayout(clientX, clientY)
    if (!f || !p) return null
    const GATE = 14 // generous hit radius around each gate dot (layout units)
    if (Math.hypot(p.x - f.x, p.y - (f.y - f.h / 2 - 9)) < GATE) return 'addParent' as const
    if (Math.hypot(p.x - f.x, p.y - (f.y + f.h / 2 + 9)) < GATE) return 'addChild' as const
    if (Math.hypot(p.x - (f.x - f.w / 2 - 9), p.y - f.y) < GATE) return 'addJump' as const
    // Empty space: the dominant axis from the focus decides the zone.
    const dx = p.x - f.x
    const dy = p.y - f.y
    if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? ('addParent' as const) : ('addChild' as const)
    return dx < 0 ? ('addJump' as const) : ('addSibling' as const)
  }

  return (
    <canvas
      ref={canvasRef}
      className="brain-canvas"
      onMouseMove={(e) => {
        const over = hitTest(e.clientX, e.clientY) || zoneAt(e.clientX, e.clientY)
        e.currentTarget.style.cursor = over ? 'pointer' : 'default'
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const fromId = hitTest(e.clientX, e.clientY)
        if (!fromId) return
        const canvas = canvasRef.current!
        const rect = canvas.getBoundingClientRect()
        const drag: Drag = {
          fromId,
          sx: e.clientX - rect.left,
          sy: e.clientY - rect.top,
          mx: e.clientX - rect.left,
          my: e.clientY - rect.top,
          shift: e.shiftKey,
          active: false,
          overId: null
        }
        dragRef.current = drag
        const onMove = (ev: MouseEvent) => {
          drag.mx = ev.clientX - rect.left
          drag.my = ev.clientY - rect.top
          drag.shift = ev.shiftKey
          if (!drag.active && Math.hypot(drag.mx - drag.sx, drag.my - drag.sy) > 6) {
            drag.active = true // past the threshold: it is a link drag, not a click
          }
          drag.overId = drag.active ? hitTest(ev.clientX, ev.clientY) : null
        }
        const onUp = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          if (dragRef.current === drag) dragRef.current = null
          if (!drag.active) return
          suppressClickRef.current = true // swallow the click that ends the drag
          const target = hitTest(ev.clientX, ev.clientY)
          if (target && target !== drag.fromId) {
            // Plain drag = jump association; shift-drag = from becomes parent.
            void useBrain
              .getState()
              .linkThoughts(drag.fromId, target, drag.shift ? 'child' : 'jump')
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        const id = hitTest(e.clientX, e.clientY)
        if (id) {
          if (id !== focusRef.current) void focus(id)
          return
        }
        const zone = zoneAt(e.clientX, e.clientY)
        if (zone) useBrain.getState().openDialog(zone)
      }}
      onDoubleClick={(e) => {
        const id = hitTest(e.clientX, e.clientY)
        if (id) useBrain.setState({ selectedId: id })
      }}
    />
  )
}

interface Box {
  cx: number
  cy: number
  w: number
  h: number
}

function project(d: Display, cx: number, cy: number, scale: number): Box {
  return { cx: cx + d.x * scale, cy: cy + d.y * scale, w: d.w * scale, h: d.h * scale }
}

/** Point on a box's boundary at the midpoint of the given side. */
function sidePoint(box: Box, side: Side): { x: number; y: number } {
  const hw = box.w / 2
  const hh = box.h / 2
  if (side === 'top') return { x: box.cx, y: box.cy - hh }
  if (side === 'bottom') return { x: box.cx, y: box.cy + hh }
  if (side === 'left') return { x: box.cx - hw, y: box.cy }
  return { x: box.cx + hw, y: box.cy }
}

const SIDE_NORMAL: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  source: Box,
  target: Box,
  e: PositionedEdge
): void {
  const color = ROLE_COLOR[e.kind]
  // Every link leaves/enters through a fixed side anchor, so all child curves
  // converge on one point under the focus (the signature TheBrain fan).
  const a = sidePoint(source, e.fromSide)
  const b = sidePoint(target, e.toSide)
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const k = Math.max(24, dist * 0.45)
  const na = SIDE_NORMAL[e.fromSide]
  const nb = SIDE_NORMAL[e.toSide]
  const c1 = { x: a.x + na.x * k, y: a.y + na.y * k }
  const c2 = { x: b.x + nb.x * k, y: b.y + nb.y * k }

  ctx.save()
  ctx.strokeStyle = hexA(color, 0.5)
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y)
  ctx.stroke()

  // TheBrain draws a small dot at the far end of a link instead of an arrow.
  ctx.fillStyle = hexA(color, 0.9)
  ctx.beginPath()
  ctx.arc(b.x, b.y, 2.6, 0, Math.PI * 2)
  ctx.fill()

  // Intimacy: the number of connections shows along strong links (>1).
  if (e.intimacy > 1) {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    ctx.font = '600 10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hexA(color, 0.95)
    ctx.fillText(String(e.intimacy), mx, my)
  }
  ctx.restore()
}

/**
 * Gate circles on the focus box (User Guide: parent gate above, child gate
 * below, jump gate to the left). Solid when links exist, hollow otherwise.
 */
function drawGates(
  ctx: CanvasRenderingContext2D,
  box: Box,
  counts: { parent: number; child: number; jump: number }
): void {
  const gates: Array<{ x: number; y: number; active: boolean; color: string }> = [
    { x: box.cx, y: box.cy - box.h / 2 - 9, active: counts.parent > 0, color: ROLE_COLOR.parent },
    { x: box.cx, y: box.cy + box.h / 2 + 9, active: counts.child > 0, color: ROLE_COLOR.child },
    { x: box.cx - box.w / 2 - 9, y: box.cy, active: counts.jump > 0, color: ROLE_COLOR.jump }
  ]
  ctx.save()
  for (const g of gates) {
    ctx.beginPath()
    ctx.arc(g.x, g.y, 3.2, 0, Math.PI * 2)
    if (g.active) {
      ctx.fillStyle = g.color
      ctx.fill()
    } else {
      ctx.strokeStyle = hexA('#ffffff', 0.35)
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  box: Box,
  n: PositionedNode,
  alpha: number,
  isFocus: boolean,
  isSelected: boolean
) {
  const { cx, cy, w, h } = box
  const x = cx - w / 2
  const y = cy - h / 2
  const r = 9
  const color = ROLE_COLOR[n.role]

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha))

  // body
  ctx.beginPath()
  roundRect(ctx, x, y, w, h, r)
  ctx.fillStyle = isFocus ? '#1d2634' : '#161d28'
  ctx.fill()

  // color bar
  ctx.lineWidth = isFocus ? 2.5 : 1.5
  ctx.strokeStyle = n.color ?? color
  ctx.stroke()

  if (isSelected && !isFocus) {
    ctx.beginPath()
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, r + 3)
    ctx.strokeStyle = hexA('#ffffff', 0.55)
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  if (isFocus) {
    ctx.beginPath()
    roundRect(ctx, x - 5, y - 5, w + 10, h + 10, r + 5)
    ctx.strokeStyle = hexA(ROLE_COLOR.child, 0.35)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // label: leading type icon (or plain role/color dot) + text, as TheBrain does
  const dotColor = n.color ?? color
  const icon = typeIcon(n.type)
  if (icon) {
    ctx.font = '11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = dotColor
    ctx.fillText(icon, x + 12, cy + 1)
  } else {
    ctx.fillStyle = dotColor
    ctx.beginPath()
    ctx.arc(x + 12, cy, 3.4, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = isFocus ? '#ffffff' : '#dbe3ee'
  ctx.font = `${isFocus ? 600 : 500} ${Math.round(12 * Math.min(1.15, Math.max(0.85, w / 150)))}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const label = truncate(ctx, n.pinned ? `★ ${n.name}` : n.name, w - 30)
  ctx.fillText(label, x + 20, cy + 1)

  ctx.restore()
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let out = text
  while (out.length > 1 && ctx.measureText(out + '…').width > maxW) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${a})`
}
