import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { cleanText } from './diagnostics.js'
import { SOURCE_KIND } from './constants.js'

const textOf = content => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n')
const put = (rows, row) => {
  const index = rows.findIndex(other => other.key === row.key)
  if (index === -1) rows.push(row)
  else rows[index] = { ...rows[index], ...row }
}

// The same fold serves live events and replay. Identifiers include the Session because
// a context handoff restarts turn and step numbers in a new Session.
export function foldProcess(rows, sessionId, event) {
  const data = event.data ?? {}
  const parent = rows.find(row => row.sessionId === sessionId && row.callId === (data.parentCallId ?? data.rootCallId))
  const turn = data.turn ?? parent?.turn ?? 0
  const prefix = `${sessionId}:${turn}`
  const callId = data.subCallId ?? data.callId ?? data.message?.source?.callId ?? data.message?.toolCallId ?? data.message?.callId
  const key = `${prefix}:tool:${callId}`
  switch (event.type) {
    case 'assistant/message':
    case 'assistant/attempt': {
      let content = data.message?.content
      if (!content && data.stream) {
        const assembler = new BlockAssembler()
        for (const item of data.stream) if (item.type === 'chunk') assembler.push(item.chunk)
        content = assembler.blocks()
      }
      const called = content?.some(block => block.type === 'tool-call')
      for (const [index, block] of (content ?? []).entries()) {
        const blockKey = `${prefix}:${data.step}:${block.type}:${index}`
        if (block.type === 'reasoning' || (block.type === 'text' && (called || data.live))) {
          put(rows, { key: blockKey, kind: block.type, text: block.text, status: data.live ? 'running' : 'completed', time: event.time })
        } else if (block.type === 'text') {
          const at = rows.findIndex(row => row.key === blockKey)
          if (at !== -1) rows.splice(at, 1)
        }
      }
      break
    }
    case 'tool/call':
    case 'tool/ptc-dispatch-start':
      if (!callId) break
      put(rows, { key, kind: 'tool', callId, sessionId, turn, name: data.name, arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}), status: 'running', time: event.time })
      break
    case 'tool/result':
    case 'tool/ptc-dispatch': {
      const message = data.message ?? data
      const error = message.isError || data.error
      if (!callId) break
      put(rows, { key, kind: 'tool', result: textOf(message.content), content: message.content, meta: data.meta, error: data.error, status: error ? 'failed' : 'completed', ended: event.time })
      break
    }
    case 'llm/retry-started':
      put(rows, { key: `${prefix}:retry:${event.seq}`, kind: 'retry', text: String(data.retry ?? ''), time: event.time, status: 'completed' })
      break
    case 'turn/end':
      for (const row of rows) if (row.key.startsWith(`${prefix}:`) && row.status === 'running') row.status = data.reason?.kind === 'completed' ? 'completed' : 'interrupted'
      if (data.reason?.kind === 'error') {
        const error = data.reason.error ?? {}
        put(rows, { key: `${prefix}:error:${event.seq}`, kind: 'error', text: error.code === 'AUTH' ? 'AUTH' : [error.code, error.message].filter(Boolean).join(': '), status: 'failed', time: event.time })
      }
      break
  }
}

export function install(rt) {
  const { ctx } = rt
  const active = new Map()
  const starts = new Map()
  const cache = new Map()
  const hydrated = new Set()
  const snapshots = new Map()
  const rowsOf = id => {
    if (!cache.has(id)) cache.set(id, [])
    return cache.get(id)
  }
  const find = id => Object.values(rt.state.rooms).flatMap(room => room.processes ?? []).find(work => work.id === id)
  rt.beginGroupProcess = (room, member, sessionId, exchangeId, callId) => {
    const work = { id: exchangeId, callId, botId: member.id, name: member.name, color: member.color, since: Date.now(), status: 'queued', turns: [] }
    ;(room.processes ??= []).push(work)
    rowsOf(exchangeId)
    hydrated.add(exchangeId)
    return work
  }
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    const owner = rt.groupOwners.get(id)
    if (!owner) return
    if (event.type === 'turn/start') starts.set(id, event.seq)
    if (event.type === 'user/message') {
      const source = event.data?.source
      const room = rt.roomOf(owner.roomId)
      const belongs = source?.kind === SOURCE_KIND && source.roomId === owner.roomId
      const work = belongs ? find(source.exchangeId) ?? (source.resumed ? room?.processes?.findLast(item => item.botId === owner.botId && ['running', 'interrupted'].includes(item.status)) : undefined) : undefined
      if (work && work.botId === owner.botId && rt.live.get(id)?.info?.exchangeId === source.exchangeId) {
        active.set(id, work.id)
        const turn = rt.live.get(id)?.turn
        if (Number.isInteger(turn) && !work.turns.some(ref => ref.sessionId === id && ref.turn === turn)) {
          work.turns.push({ sessionId: id, turn, fromSeq: starts.get(id) ?? event.seq })
          work.status = 'running'
          void rt.save().catch(() => {})
        }
      }
    }
    const work = find(active.get(id))
    if (!work) return
    foldProcess(rowsOf(work.id), id, event)
    if (event.type === 'turn/end') {
      const ref = work.turns.findLast(item => item.sessionId === id)
      if (ref) ref.toSeq = event.seq
      const kind = event.data?.reason?.kind
      work.status = kind === 'completed' ? 'completed' : kind === 'error' || kind === 'failed' ? 'failed' : 'interrupted'
      work.ended = event.time ?? Date.now()
      active.delete(id)
      void rt.save().catch(() => {})
    }
  })
  ctx.on('llm/stream', (options, next) => {
    if (!active.has(options.sessionId) || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* follow() {
      const assembler = new BlockAssembler()
      const workId = active.get(options.sessionId)
      const live = rt.live.get(options.sessionId)
      const turn = live?.turn
      // Session events settle this preview; no extra request or model-visible text.
      const step = live?.currentStep ?? 0
      for await (const chunk of next()) {
        assembler.push(chunk)
        snapshots.set(options.sessionId, { workId, turn, step, content: assembler.blocks() })
        yield chunk
      }
    })()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      const entry = rt.live.get(session.id)
      if (entry) entry.currentStep = event.data.step
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'turn/end') snapshots.delete(session.id)
  })

  async function replay(work) {
    const rows = []
    let ending
    for (const ref of work.turns) {
      const through = ref.toSeq ?? (await ctx.sessionController.projections({ sessionId: ref.sessionId }, AbortSignal.timeout(15000)))?.asOfSeq
      if (!Number.isInteger(through)) continue
      const events = []
      let beforeSeq
      for (;;) {
        const page = await ctx.sessionController.page({ address: { kind: 'session', sessionId: ref.sessionId }, throughSeq: through, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 100 }, AbortSignal.timeout(15000))
        const got = page.records.map(record => record.event)
        events.unshift(...got.filter(event => event.seq >= ref.fromSeq && (event.data?.turn === ref.turn || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')))
        if (!page.hasMore || !got.length || got[0].seq <= ref.fromSeq) break
        beforeSeq = got[0].seq
      }
      ending = undefined
      for (const event of events) {
        foldProcess(rows, ref.sessionId, event)
        if (event.type === 'turn/end') ending = event
      }
    }
    if (ending && active.get(work.turns.at(-1)?.sessionId) !== work.id) {
      const kind = ending.data.reason?.kind
      work.status = kind === 'completed' ? 'completed' : kind === 'error' ? 'failed' : 'interrupted'
      work.ended = ending.time
    }
    return rows
  }
  rt.groupProcessView = async (roomId, callId) => {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (!room) throw Object.assign(new Error('Group not found'), { code: 'bot/not-found' })
    const works = (room.processes ?? []).filter(work => work.callId === callId)
    return Promise.all(works.map(async (work) => {
      if (!hydrated.has(work.id)) {
        const rows = await replay(work)
        for (const row of cache.get(work.id) ?? []) put(rows, row)
        cache.set(work.id, rows)
        hydrated.add(work.id)
      }
      const rows = rowsOf(work.id).map(row => ({ ...row }))
      for (const [id, preview] of snapshots) if (preview.workId === work.id) foldProcess(rows, id, { type: 'assistant/message', data: { ...preview, message: { content: preview.content }, live: true } })
      const clean = value => cleanText(value, { redact: rt.redactSecrets, home: '', max: Infinity })
      const cleanValue = value => typeof value === 'string' ? clean(value) : Array.isArray(value) ? value.map(cleanValue)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(api[_-]?key|authorization|password|secret|token)$/i.test(key) && typeof entry === 'string' ? '[hidden]' : cleanValue(entry)])) : value
      return { id: work.id, botId: work.botId, sessionId: work.turns.at(-1)?.sessionId, name: work.name, color: work.color, since: work.since, ended: work.ended, status: active.get(work.turns.at(-1)?.sessionId) === work.id ? 'running' : work.status, rows: rows.map(row => row.name === 'request_secret'
        ? { ...row, arguments: '[hidden]', result: row.result === undefined ? undefined : '[hidden]', content: [{ type: 'text', text: '[hidden]' }], meta: undefined, error: undefined }
        : cleanValue(row)) }
    }))
  }
}
