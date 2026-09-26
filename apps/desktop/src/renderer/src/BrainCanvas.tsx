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
  const hoverIdRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const prevFocusRef = useRef<string | null>(null)

  layoutRef.current = useBrain((s) => s.layout)
  focusRef.current = useBrain((s) => s.focusId)
  selectedRef.current = useBrain((s) => s.selectedId)
  const focus = useBrain((s) => s.focus)

  // Seed / retire display boxes when the layout changes. New thoughts pop in
  // FROM their source: TheBrain spawns entering thoughts at the neighbor you
  // came through, not out of the empty middle of the canvas.
  useEffect(() => {
    const layout = layoutRef.current
    if (!layout) return
    const disp = displayRef.current
    // Snapshot of boxes that were on screen BEFORE this layout arrived.
    const had = new Map<string, Display>()
    for (const [id, d] of disp) had.set(id, { ...d })
    const nbr = new Map<string, string[]>()
    const touch = (a: string, b: string) => {
      if (!nbr.has(a)) nbr.set(a, [])
      nbr.get(a)!.push(b)
    }
    for (const e of layout.edges) {
      touch(e.sourceId, e.targetId)
      touch(e.targetId, e.sourceId)
    }
    const ids = new Set<string>()
    for (const n of layout.nodes) {
      ids.add(n.id)
      if (!disp.has(n.id)) {
        let sx = 0
        let sy = 0
        const prevF = prevFocusRef.current
        const src =
          n.id === focusRef.current && prevF && prevF !== n.id
            ? had.get(prevF)
            : (nbr.get(n.id) ?? []).map((id) => had.get(id)).find((d) => d !== undefined)
        if (src) {
          sx = src.x
          sy = src.y
        }
        disp.set(n.id, { x: sx, y: sy, w: n.w, h: n.h, alpha: 0 })
      }
      const d = disp.get(n.id)!
      d.w = n.w
      d.h = n.h
    }
    for (const id of [...disp.keys()]) if (!ids.has(id)) disp.delete(id)
    prevFocusRef.current = focusRef.current
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

        // "More" gate dots: thoughts with off-screen neighbors get tiny
        // markers on the parent/child/jump sides (click jumps into them).
        for (const n of layout.nodes) {
          if (!n.hidden) continue
          const d = disp.get(n.id)
          if (d) drawMoreDots(ctx, project(d, cx, cy, scale), n)
        }

        // Attachment badges: a count pill on the top-right corner of any
        // thought that carries material (↗ marks an external link among them).
        for (const n of layout.nodes) {
          if (!n.attach) continue
          const d = disp.get(n.id)
          if (d) drawAttachBadge(ctx, project(d, cx, cy, scale), n.attach)
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

  // A focus change moves the whole graph under the cursor: drop any tip.
  useEffect(() => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverIdRef.current = null
    useBrain.getState().hideHover()
  }, [focus])

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

  // A "More" dot under the cursor? Clicking it jumps into the hidden relation
  // (TheBrain opens a gate list; we go straight to the first hidden neighbor).
  const moreDotAt = (
    clientX: number,
    clientY: number
  ): { id: string; dir: 'parents' | 'children' | 'jumps' } | null => {
    const layout = layoutRef.current
    const p = toLayout(clientX, clientY)
    if (!layout || !p) return null
    for (const n of layout.nodes) {
      if (!n.hidden) continue
      const spots: Array<{ dir: 'parents' | 'children' | 'jumps'; x: number; y: number }> = []
      if (n.hidden.parents > 0) spots.push({ dir: 'parents', x: n.x, y: n.y - n.h / 2 - 6 })
      if (n.hidden.children > 0) spots.push({ dir: 'children', x: n.x, y: n.y + n.h / 2 + 6 })
      if (n.hidden.jumps > 0) spots.push({ dir: 'jumps', x: n.x - n.w / 2 - 6, y: n.y })
      for (const s of spots) {
        if (Math.hypot(p.x - s.x, p.y - s.y) < 7) return { id: n.id, dir: s.dir }
      }
    }
    return null
  }

  const cancelHover = () => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverIdRef.current = null
    useBrain.getState().hideHover()
  }

  return (
    <canvas
      ref={canvasRef}
      className="brain-canvas"
      onMouseMove={(e) => {
        const { clientX, clientY } = e
        const nodeId = hitTest(clientX, clientY)
        e.currentTarget.style.cursor =
          nodeId || moreDotAt(clientX, clientY) || zoneAt(clientX, clientY) ? 'pointer' : 'default'

        // Hover card: appears after a short dwell on one node, follows the
        // cursor while parked there, and never competes with a link drag.
        if (nodeId !== hoverIdRef.current) {
          if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
          hoverTimerRef.current = null
          hoverIdRef.current = nodeId
          useBrain.getState().hideHover()
          if (nodeId && !dragRef.current) {
            hoverTimerRef.current = window.setTimeout(() => {
              hoverTimerRef.current = null
              void useBrain.getState().showHover(nodeId, clientX + 16, clientY + 18)
            }, 350)
          }
        } else if (nodeId && useBrain.getState().hoverTip) {
          useBrain.setState((s) =>
            s.hoverTip ? { hoverTip: { ...s.hoverTip, x: clientX + 16, y: clientY + 18 } } : {}
          )
        }
      }}
      onMouseLeave={cancelHover}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        cancelHover()
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
        cancelHover()
        const dot = moreDotAt(e.clientX, e.clientY)
        if (dot) {
          const target = useBrain.getState().viewport?.hidden[dot.id]?.[dot.dir]?.[0]
          if (target) void focus(target)
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

/**
 * "More" gate dots (TheBrain gates report MORE when relations exist beyond
 * the viewport): tiny filled markers on the parent/child/jump side of the
 * box, haloed so they read as clickable. Radius grows slightly with count.
 */
function drawMoreDots(ctx: CanvasRenderingContext2D, box: Box, n: PositionedNode): void {
  const h = n.hidden
  if (!h) return
  const dots: Array<{ x: number; y: number; color: string; count: number }> = []
  if (h.parents > 0)
    dots.push({ x: box.cx, y: box.cy - box.h / 2 - 6, color: ROLE_COLOR.parent, count: h.parents })
  if (h.children > 0)
    dots.push({ x: box.cx, y: box.cy + box.h / 2 + 6, color: ROLE_COLOR.child, count: h.children })
  if (h.jumps > 0)
    dots.push({ x: box.cx - box.w / 2 - 6, y: box.cy, color: ROLE_COLOR.jump, count: h.jumps })
  ctx.save()
  for (const dt of dots) {
    ctx.beginPath()
    ctx.arc(dt.x, dt.y, 2.1 + Math.min(1.5, dt.count * 0.3), 0, Math.PI * 2)
    ctx.strokeStyle = hexA(dt.color, 0.3)
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.fillStyle = hexA(dt.color, 0.95)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * Attachment badge (TheBrain marks thoughts that carry material): a small
 * rounded pill centered on the node's top-right corner showing the count,
 * plus an ↗ arrow when one of the attachments is an external URL.
 */
function drawAttachBadge(
  ctx: CanvasRenderingContext2D,
  box: Box,
  a: { total: number; urls: number }
): void {
  const text = String(a.total)
  ctx.save()
  ctx.font = '700 9px Inter, system-ui, sans-serif'
  const arrowW = a.urls > 0 ? 10 : 0
  const w = 9 + ctx.measureText(text).width + arrowW
  const h = 13
  const x = box.cx + box.w / 2
  const y = box.cy - box.h / 2
  ctx.beginPath()
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2)
  ctx.fillStyle = '#0b1119'
  ctx.fill()
  ctx.strokeStyle = hexA('#8fb4ff', 0.75)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#dbe3ee'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  ctx.fillText(text, x + w / 2 - (a.urls > 0 ? 11 : 4.5), y + 0.5)
  if (a.urls > 0) {
    ctx.textAlign = 'left'
    ctx.fillText('↗', x + w / 2 - 10, y + 0.5)
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
