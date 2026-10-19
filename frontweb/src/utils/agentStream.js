export function parseSseBlock(block) {
  const events = []
  const chunks = String(block || '').split(/\n\n/)
  for (const chunk of chunks) {
    const line = chunk.split('\n').find((row) => row.startsWith('data:'))
    if (!line) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      events.push(JSON.parse(raw))
    } catch (_) {
      /* 半包留给下一次拼接 */
    }
  }
  return events
}
