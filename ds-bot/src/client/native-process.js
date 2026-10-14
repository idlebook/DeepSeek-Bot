import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'

const hookName = name => `use${name[0].toUpperCase()}${name.slice(1)}`
const selectSource = source => (select = value => value) => select(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => setExpanded(value => !value) }
}

export function sourceProps(face = {}) {
  const props = { ...face }
  delete props.hooks
  delete props.keyedHooks
  for (const [name, source] of Object.entries(face.hooks ?? {})) if (source) props[hookName(name)] = selectSource(source)
  for (const [name, family] of Object.entries(face.keyedHooks ?? {})) props[hookName(name)] = (key, select) => selectSource(family(key))(select)
  return props
}

// Use the public Slot registry's registered components, including their locale and
// injected sources. No private DSH imports or copied tool/reasoning renderers.
export function nativeProcess(ctx) {
  const entryOf = (slot, key) => ctx.slots.entries(slot).find(entry => entry.options.key === key && entry.registrant !== 'ds-bot' && (entry.options.priority ?? 0) >= 0)
  const faceOf = (entry, sessionId) => ({ ...sourceProps(entry.inject?.(sessionId)), t: ctx.get('locale').bind(entry.locale) })
  const renderAtomic = (sessionId, base) => (slot, owner, options = {}) => {
    const entry = entryOf(slot, options.entryKey)
    if (!entry) return options.fallback ?? null
    return h(entry.component, {
      ...base, ...owner, ...faceOf(entry, sessionId),
      useToolCallArgumentsPartial: () => owner.block?.argsRaw ?? '',
      renderSlot: renderAtomic(sessionId, base),
    })
  }
  function NativeView({ kind, owner }) {
    const entry = entryOf('conversation.chat.node', kind)
    if (!entry) throw new Error(`DSH native process renderer is unavailable: ${kind}`)
    return h(entry.component, { ...owner, ...faceOf(entry, owner.sessionId), renderSlot: renderAtomic(owner.sessionId, owner) })
  }
  function SessionView({ kind, sessionId, owner }) {
    const [state, setState] = useState(null)
    const [retry, setRetry] = useState(0)
    useEffect(() => {
      let stopped = false
      let timer
      const ref = ctx.sessions.retain(sessionId, { source: 'dsBotProcess' })
      ref.ready.then(() => { if (!stopped) setState({ sessionId, source: ctx.uiSession.bindingSource(ref) }) })
        .catch(() => {
          if (stopped) return
          setState({ sessionId, error: true })
          timer = setTimeout(() => setRetry(value => value + 1), 1500)
        })
      return () => { stopped = true; clearTimeout(timer); ref.release() }
    }, [sessionId, retry])
    if (state?.sessionId !== sessionId) return null
    if (state.error) return h('div', { className: 'bt-event bt-event-error', role: 'status' }, t('Could not load execution process. Retrying…'))
    return h(BoundView, { kind, sessionId, owner, source: state.source })
  }
  function BoundView({ kind, sessionId, owner, source }) {
    const binding = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    const base = useMemo(() => {
      const chat = ctx.slots.entries('conversation.view').find(entry => entry.options.id === 'chat')
      return { ...sourceProps({ ...binding.props, hooks: binding.hooks, keyedHooks: binding.keyedHooks }), ...sourceProps(chat?.inject?.(sessionId)), useDisclosure, useTurnData: () => undefined }
    }, [binding, sessionId])
    return h(NativeView, { kind, owner: { ...base, ...owner, sessionId } })
  }
  const render = (kind, owner) => owner.nativeOwner
    ? h(NativeView, { kind, owner: { ...owner.nativeOwner, ...owner } })
    : h(SessionView, { kind, sessionId: owner.sessionId, owner })
  return {
    tool: (call, owner) => render('tool-call', {
      ...owner,
      node: { ...owner.nativeOwner?.node, location: owner.nativeOwner?.node?.location ?? { kind: 'turn' }, data: { root: { ...call, subCalls: [] } } },
    }),
    reasoning: (text, running, owner) => render('assistant-step', {
      ...owner, groupPart: 'reasoning', turnProcess: undefined,
      node: { location: { kind: 'turn' }, data: { blocks: [{ kind: 'reasoning', text }], status: running ? 'running' : 'settled' } },
      useTurnData: () => undefined,
    }),
    turn: owner => render('turn-process', owner),
  }
}
