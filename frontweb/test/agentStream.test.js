import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSseBlock } from '../src/utils/agentStream.js'

test('parses assistant stream events', () => {
  const events = parseSseBlock('data: {"type":"text-delta","text":"你"}\n\ndata: {"type":"done"}\n\n')
  assert.equal(events.length, 2)
  assert.equal(events[0].text, '你')
  assert.equal(events[1].type, 'done')
})

test('ignores a partial json line', () => {
  assert.deepEqual(parseSseBlock('data: {"type":"text-delta"'), [])
})
