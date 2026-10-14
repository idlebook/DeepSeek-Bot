import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, foldProcess } from '../src/host/group-process.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const event = (type, data, seq = 1) => ({ type, data, seq, time: seq * 100 })
const call = (turn = 1, callId = 'c') => event('tool/call', { turn, step: 0, callId, name: 'read', arguments: '{"path":"report.md"}' })
const result = (turn = 1, callId = 'c', isError = false) => event('tool/result', { turn, step: 0, message: { toolCallId: callId, source: { callId }, content: [{ type: 'text', text: 'report evidence' }], isError } }, 2)

test('a tool settles in place, keeps its arguments and result, and replay is idempotent', () => {
  const rows = []
  for (const item of [call(), result(), call(), result()]) foldProcess(rows, 's', item)
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].name, rows[0].status, rows[0].arguments, rows[0].result], ['read', 'completed', '{"path":"report.md"}', 'report evidence'])
})

test('PTC subcalls, errors, retries and interrupted calls remain distinct', () => {
  const rows = []
  foldProcess(rows, 's', call())
  foldProcess(rows, 's', event('tool/ptc-dispatch-start', { turn: 1, subCallId: 'sub', name: 'bash', arguments: { cmd: 'false' } }))
  foldProcess(rows, 's', event('tool/ptc-dispatch', { turn: 1, subCallId: 'sub', content: [{ type: 'text', text: 'exit 1' }], isError: true }))
  foldProcess(rows, 's', event('llm/retry-started', { turn: 1, retry: 2 }, 7))
  foldProcess(rows, 's', event('turn/end', { turn: 1, reason: { kind: 'cancelled' } }))
  assert.deepEqual(rows.map(row => row.status), ['interrupted', 'failed', 'completed'])
  foldProcess(rows, 'fresh', call())
  assert.equal(rows.length, 4)
})

test('native result source IDs and PTC events without turn fields settle their original rows', () => {
  const rows = []
  foldProcess(rows, 's', call(7, 'root'))
  foldProcess(rows, 's', event('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: { file_path: 'report.md' } }))
  foldProcess(rows, 's', event('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', arguments: {}, content: [{ type: 'text', text: 'Nested result' }], isError: false }))
  foldProcess(rows, 's', event('tool/result', { turn: 7, message: { source: { callId: 'root' }, toolCallId: 'root', content: [{ type: 'text', text: 'Root result' }] }, meta: { preserved: true } }))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => [row.callId, row.turn, row.status]), [['root', 7, 'completed'], ['sub', 7, 'completed']])
  assert.equal(rows[0].meta.preserved, true)
  assert.equal(rows[1].content[0].text, 'Nested result')
})

test('streamed thinking updates once; the final answer is not duplicated in the process', () => {
  const rows = []
  const message = (text, live) => event('assistant/message', { turn: 1, step: 0, live, message: { content: [{ type: 'reasoning', text }, { type: 'text', text: 'Final answer' }] } })
  foldProcess(rows, 's', message('Checking', true))
  foldProcess(rows, 's', message('Checking the note', false))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, 'Checking the note')
  assert.equal(rows[0].status, 'completed')
})

function runtime() {
  const ctx = fakeContext()
  const records = new Map()
  let pages = 0
  ctx.sessionController = {
    projections: async ({ sessionId }) => ({ asOfSeq: records.get(sessionId)?.at(-1)?.seq ?? -1 }),
    page: async ({ address, throughSeq, beforeSeq }) => {
      pages++
      const all = (records.get(address.sessionId) ?? []).filter(item => item.seq <= throughSeq && (beforeSeq === undefined || item.seq < beforeSeq))
      return { records: all.slice(-2).map(item => ({ event: item })), hasMore: all.length > 2 }
    },
  }
  const room = { id: 'r', processes: [] }
  const rt = { ctx, state: { rooms: { r: room } }, groupOwners: new Map([['s', { roomId: 'r', botId: 'b' }], ['fresh', { roomId: 'r', botId: 'b' }]]), live: new Map(), roomOf: id => id === 'r' ? room : undefined, load: async () => {}, save: async () => {}, ownRequest: () => false, redactSecrets: text => text.replaceAll('saved-test-secret', '[hidden]') }
  const emit = (id, item) => {
    const saved = records.get(id) ?? []
    records.set(id, [...saved, item])
    for (const listener of ctx.listeners.get('session/event')) listener({ id }, item)
  }
  const member = { id: 'b', name: 'Researcher', color: 'blue' }
  const begin = (id, work, turn = 1) => {
    rt.live.set(id, { turn, info: { exchangeId: work.id } })
    emit(id, event('turn/start', { turn }, 0))
    emit(id, event('user/message', { source: { kind: SOURCE_KIND, roomId: 'r', exchangeId: work.id }, turn }, 1))
  }
  install(rt)
  return { rt, ctx, room, records, emit, member, begin, pages: () => pages }
}

test('group work is scoped to a round, excludes private sessions, and redacts credentials', async () => {
  const { rt, room, member, begin, emit } = runtime()
  const work = rt.beginGroupProcess(room, member, 's', 'exchange', 'round')
  begin('s', work)
  emit('private', call())
  emit('s', call())
  emit('s', event('tool/result', { turn: 1, message: { toolCallId: 'c', source: { callId: 'c' }, content: [{ type: 'text', text: 'saved-test-secret sk-example123456 authorization: secret-value' }] } }, 3))
  emit('s', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
  const [view] = await rt.groupProcessView('r', 'round')
  assert.equal(view.rows.length, 1)
  assert.equal(view.status, 'completed')
  assert.ok(!JSON.stringify(view).includes('saved-test-secret'))
  assert.ok(!JSON.stringify(view).includes('example123456'))
  assert.deepEqual(await rt.groupProcessView('r', 'another-round'), [])
  await assert.rejects(rt.groupProcessView('private', 'round'), { code: 'bot/not-found' })
})

test('restart replays paginated Session logs, including old parts and same-numbered turns', async () => {
  const host = runtime()
  const work = { id: 'old', callId: 'round', botId: 'b', name: 'Researcher', status: 'completed', turns: [{ sessionId: 's', turn: 1, fromSeq: 0, toSeq: 4 }, { sessionId: 'fresh', turn: 1, fromSeq: 0, toSeq: 4 }] }
  host.room.processes.push(work)
  for (const id of ['s', 'fresh']) host.records.set(id, [event('turn/start', { turn: 1 }, 0), call(), result(), event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4), call(99)])
  const [view] = await host.rt.groupProcessView('r', 'round')
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].status, 'completed')
  assert.ok(host.pages() >= 4)
  const pages = host.pages()
  await host.rt.groupProcessView('r', 'round')
  assert.equal(host.pages(), pages)
})

test('a queued mid-turn request cannot steal the running work; a handoff joins the original process', async () => {
  const host = runtime()
  const work = host.rt.beginGroupProcess(host.room, host.member, 's', 'one', 'round')
  host.begin('s', work)
  const queued = host.rt.beginGroupProcess(host.room, host.member, 's', 'two', 'round')
  host.emit('s', event('user/message', { source: { kind: SOURCE_KIND, roomId: 'r', exchangeId: queued.id } }, 2))
  host.emit('s', call())
  host.emit('s', event('turn/end', { turn: 1, reason: { kind: 'cancelled' } }, 4))
  host.begin('fresh', work)
  host.emit('fresh', call())
  const views = await host.rt.groupProcessView('r', 'round')
  assert.equal(views[0].rows.length, 2)
  assert.equal(views[0].status, 'running')
  assert.equal(views[1].rows.length, 0)
  assert.equal(work.turns.length, 2)
})

test('live model reasoning is a preview, not an additional request, and settled events replace it', async () => {
  const host = runtime()
  const work = host.rt.beginGroupProcess(host.room, host.member, 's', 'one', 'round')
  host.begin('s', work)
  host.emit('s', event('step/start', { turn: 1, step: 2 }, 2))
  const stream = host.ctx.listeners.get('llm/stream')[0]
  let requests = 0
  const next = async function* () {
    requests++
    yield { type: 'reasoning-delta', index: 0, text: 'checking the annual report' }
  }
  const iterator = stream({ sessionId: 's' }, next)[Symbol.asyncIterator]()
  await iterator.next()
  const [live] = await host.rt.groupProcessView('r', 'round')
  assert.equal(live.rows[0].text, 'checking the annual report')
  assert.equal(live.rows[0].status, 'running')
  assert.ok(live.rows[0].key.includes(':2:'))
  await iterator.next()
  host.emit('s', event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: 'checked' }] } }, 3))
  const [settled] = await host.rt.groupProcessView('r', 'round')
  assert.equal(settled.rows.length, 1)
  assert.equal(settled.rows[0].text, 'checked')
  assert.equal(requests, 1)
})

test('a completed round is not marked running when the same member starts another round', async () => {
  const host = runtime()
  const first = host.rt.beginGroupProcess(host.room, host.member, 's', 'one', 'round-1')
  host.begin('s', first)
  host.emit('s', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
  const next = host.rt.beginGroupProcess(host.room, host.member, 's', 'two', 'round-2')
  host.begin('s', next, 2)
  assert.equal((await host.rt.groupProcessView('r', 'round-1'))[0].status, 'completed')
  assert.equal((await host.rt.groupProcessView('r', 'round-2'))[0].status, 'running')
})

test('a model failure is shown and AUTH never echoes the provider message', async () => {
  const host = runtime()
  const work = host.rt.beginGroupProcess(host.room, host.member, 's', 'one', 'round')
  host.begin('s', work)
  host.emit('s', event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'unknown-secret-shape' } } }, 4))
  const [view] = await host.rt.groupProcessView('r', 'round')
  assert.equal(view.status, 'failed')
  assert.equal(view.rows[0].text, 'AUTH')
  assert.ok(!JSON.stringify(view).includes('unknown-secret-shape'))
})

test('a restart resume with a new delivery id continues the interrupted process', async () => {
  const host = runtime()
  const work = { id: 'original', callId: 'round', botId: 'b', name: 'Researcher', status: 'interrupted', turns: [] }
  host.room.processes.push(work)
  host.rt.live.set('fresh', { turn: 1, info: { exchangeId: 'resume-delivery' } })
  host.emit('fresh', event('turn/start', { turn: 1 }, 0))
  host.emit('fresh', event('user/message', { turn: 1, source: { kind: SOURCE_KIND, role: 'room', roomId: 'r', exchangeId: 'resume-delivery', resumed: true } }, 1))
  host.emit('fresh', call())
  const [view] = await host.rt.groupProcessView('r', 'round')
  assert.equal(view.id, 'original')
  assert.equal(view.status, 'running')
  assert.equal(view.rows.length, 1)
})

test('an unreadable replay is an explicit error and can be retried', async () => {
  const host = runtime()
  host.room.processes.push({ id: 'old', callId: 'round', botId: 'b', status: 'completed', turns: [{ sessionId: 's', turn: 1, fromSeq: 0, toSeq: 4 }] })
  const page = host.ctx.sessionController.page
  host.ctx.sessionController.page = async () => { throw new Error('temporarily unavailable') }
  await assert.rejects(host.rt.groupProcessView('r', 'round'), /temporarily unavailable/)
  host.ctx.sessionController.page = page
  host.records.set('s', [call(), result()])
  assert.equal((await host.rt.groupProcessView('r', 'round'))[0].rows.length, 1)
})

test('a crash closer in the Session log corrects stale running metadata', async () => {
  const host = runtime()
  host.room.processes.push({ id: 'crash', callId: 'round', botId: 'b', status: 'running', turns: [{ sessionId: 's', turn: 1, fromSeq: 0 }] })
  host.records.set('s', [call(), event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 4)])
  const [view] = await host.rt.groupProcessView('r', 'round')
  assert.equal(view.status, 'interrupted')
  assert.equal(view.rows[0].status, 'interrupted')
})
