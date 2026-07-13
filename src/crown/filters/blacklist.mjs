export const DEFAULT_EXCLUDE_KEYWORDS = [
  '电竞',
  '电子',
  '虚拟',
  'GT体育',
  '梦幻足球',
  'efootball',
  'esport',
  'virtual',
  'fantasy',
  'cyber',
  '2x6分钟',
  '鐢电珵',
  '鐢靛瓙',
  '铏氭嫙',
  'GT浣撹偛',
  '姊﹀够瓒崇悆',
]

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function findExcludedKeyword(value, exclude = DEFAULT_EXCLUDE_KEYWORDS) {
  const text = normalizeText(value)
  if (!text) return null

  for (const keyword of exclude || []) {
    const normalizedKeyword = normalizeText(keyword)
    if (normalizedKeyword && text.includes(normalizedKeyword)) return keyword
  }
  return null
}

export function isBlacklisted(value, exclude = DEFAULT_EXCLUDE_KEYWORDS) {
  return Boolean(findExcludedKeyword(value, exclude))
}
