import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n.js'

export function ProcessRow({ row, sessionId, actions }) {
  if (row.kind === 'text') return h('div', { className: 'bt-process-text' }, h(MarkdownText, { text: row.text, streaming: row.status === 'running', variant: 'compact' }))
  if (row.kind === 'error') return h('div', { className: 'bt-event bt-event-error', role: 'status' }, t('Model request failed'), ' · ', row.text)
  if (row.kind === 'retry') return h('div', { className: 'bt-process-text' }, t('Retrying model request'), row.text ? ` · ${row.text}` : '')
  const owner = { sessionId: row.sessionId ?? sessionId }
  if (!owner.sessionId) return null
  if (row.kind === 'reasoning') return actions.processReasoning(row.text, row.status === 'running', owner)
  const call = { callId: row.callId ?? row.key, name: row.name, argsRaw: row.arguments ?? '', phase: 'start', time: row.time, subCalls: [] }
  const settled = row.status !== 'running' && row.status !== 'queued'
  const block = settled ? { kind: 'tool-result', callId: call.callId, call, callTime: row.time, time: row.ended, meta: row.meta, content: row.content ?? [{ type: 'text', text: row.result ?? '' }], isError: row.status === 'failed', error: row.status === 'interrupted' ? { code: 'interrupted' } : row.error, subCalls: [] } : call
  return actions.processTool(block, owner)
}

function MemberProcess({ work, actions }) {
  const [open, setOpen] = useState(true)
  const running = ['queued', 'running'].includes(work.status)
  // Spoken progress already belongs to the group message stream.
  const rows = work.rows.filter(row => row.kind !== 'text')
  if (!running && rows.length === 0) return null
  const count = rows.filter(row => row.kind === 'tool').length
  const reason = work.status === 'failed' ? 'error' : work.status === 'interrupted' ? 'aborted' : 'completed'
  const node = { data: { turn: 1, toolCallCount: count, messageCount: 0, subagentCount: 0 }, location: { kind: 'turn', turn: {
    turn: 1, status: running ? 'open' : 'closed', start: { time: work.since }, end: running ? undefined : { time: work.ended ?? work.since, data: { reason: { kind: reason } } },
  } } }
  return h('div', { className: 'bt-process-member', 'data-work-id': work.id },
    h('div', { className: 'bt-process-head' }, h('strong', null, work.name), running ? h(TextShimmer, { active: true }, t('Execution process')) : null),
    work.sessionId && !running ? actions.processTurn({ sessionId: work.sessionId, node, turnProcess: { hasContent: rows.length > 0, foldable: true, open, setOpen } }) : null,
    running || open || reason !== 'completed' ? rows.map(row => h(ProcessRow, { key: row.key, row, sessionId: work.sessionId, actions })) : null)
}

export function GroupProcess({ roomId, callId, done, actions }) {
  const [state, setState] = useState({ works: [], error: false })
  useEffect(() => {
    if (!callId || !actions.roomProcess) return undefined
    let stopped = false
    let timer
    let settled = false
    const tick = async () => {
      try {
        const works = await actions.roomProcess(roomId, callId)
        if (stopped) return
        setState({ works, error: false })
        settled = done && works.every(work => !['queued', 'running'].includes(work.status))
      } catch {
        if (!stopped) setState(value => ({ ...value, error: true }))
      }
      if (!stopped && !settled) timer = setTimeout(tick, document.hidden ? 5000 : 750)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [roomId, callId, done, actions])
  if (!state.works.length && !state.error) return null
  return h('section', { className: 'bt-process', 'aria-label': t('Execution process') },
    state.error ? h('div', { className: 'bt-event bt-event-error', role: 'status' }, t('Could not load execution process. Retrying…')) : null,
    state.works.map(work => h(MemberProcess, { key: work.id, work, actions })))
}
