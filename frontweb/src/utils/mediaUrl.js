/**
 * 后端可能返回写死的本机地址（如 http://localhost:5679/static/xxx.mp4），
 * 用外部 IP 访问时浏览器会去请求自己的 localhost 而失败，这里改为同源相对路径。
 */
export function normalizeMediaUrl(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s, window.location.origin)
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname)) {
      return u.pathname + u.search + u.hash
    }
  } catch (_) {}
  return s
}

/**
 * 把 storage 相对路径统一成可访问的 URL。
 * 已带 /static/ 前缀或已是 http(s) 地址时原样返回，避免出现 /static/static/。
 */
export function staticUrl(path) {
  const s = normalizeMediaUrl(path)
  if (!s) return ''
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  if (s.startsWith('/static/')) return s
  return '/static/' + s.replace(/^\//, '')
}

/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return item.image_url || ''
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return normalizeMediaUrl(sb.video_url)
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  return '/static/' + p.replace(/^\//, '')
}
