import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({ entryPoints: ['src/client/native-process.js'], bundle: true, format: 'cjs', external: ['react'], write: false })
const h = (type, props) => ({ type, props })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({
  createElement: h, useEffect: () => {}, useMemo: make => make(), useState: initial => [initial, () => {}],
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}) })
const { nativeProcess, sourceProps } = module.exports
const source = value => ({ getSnapshot: () => value, subscribe: () => () => {} })
const nativeTool = () => {}
const nativeRead = () => {}
const nativeAssistant = () => {}
const nativeTurn = () => {}
const nativeEntry = (key, component, inject) => ({ options: { key }, component, inject, locale: 'native' })
const ctx = {
  slots: { entries: slot => slot === 'tool.call.toolview'
    ? [nativeEntry('read', nativeRead)]
    : [nativeEntry('tool-call', nativeTool, () => ({ hooks: { hostInfo: source({ home: '/home/test' }) } })), nativeEntry('assistant-step', nativeAssistant), nativeEntry('turn-process', nativeTurn)] },
  get: name => name === 'locale' ? { bind: namespace => key => `${namespace}:${key}` } : undefined,
}
const render = element => element.type(element.props)

test('tool bridge uses the registered native tree and atomic renderer, preserving the owner callbacks', () => {
  const openFile = () => {}
  const useDisclosure = () => ({ expanded: false })
  const call = { callId: 'read-1', phase: 'start', name: 'read', argsRaw: '{"file_path":"README.md"}', subCalls: [] }
  const tree = render(nativeProcess(ctx).tool(call, { sessionId: 's', nativeOwner: { openFile, useDisclosure, node: { location: { kind: 'turn' } } } }))
  assert.equal(tree.type, nativeTool)
  assert.equal(tree.props.openFile, openFile)
  assert.equal(tree.props.useDisclosure, useDisclosure)
  assert.equal(tree.props.node.data.root.argsRaw, call.argsRaw)
  assert.equal(tree.props.useHostInfo(info => info.home), '/home/test')
  const read = tree.props.renderSlot('tool.call.toolview', { block: call, phase: 'start', toolName: 'read' }, { entryKey: 'read' })
  assert.equal(read.type, nativeRead)
  assert.equal(read.props.t('tool.title.read'), 'native:tool.title.read')
  assert.equal(read.props.openFile, openFile)
  const fallback = {}
  assert.equal(tree.props.renderSlot('tool.call.toolview', {}, { entryKey: 'unknown', fallback }), fallback)
})

test('reasoning and completed-turn controls are native components; reasoning carries no answer text', () => {
  const process = nativeProcess(ctx)
  const owner = { sessionId: 's', nativeOwner: {} }
  const reasoning = render(process.reasoning('Returned reasoning', true, owner))
  assert.equal(reasoning.type, nativeAssistant)
  assert.equal(reasoning.props.groupPart, 'reasoning')
  assert.equal(reasoning.props.node.data.blocks.length, 1)
  assert.equal(reasoning.props.node.data.blocks[0].kind, 'reasoning')
  const turnProcess = { setOpen: () => {} }
  assert.equal(render(process.turn({ ...owner, turnProcess })).type, nativeTurn)
})

test('public standard-source selectors retain injected values and keyed subscriptions', () => {
  const props = sourceProps({ sessionId: 's', hooks: { session: source({ hasMore: true }) }, keyedHooks: { item: key => source({ key }) } })
  assert.equal(props.sessionId, 's')
  assert.equal(props.useSession(state => state.hasMore), true)
  assert.equal(props.useItem('t1', state => state.key), 't1')
})
