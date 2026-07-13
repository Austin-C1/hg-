import iconv from 'iconv-lite'

export function repairCrownText(value) {
  const text = String(value ?? '')
  if (!text || !/[^\x00-\x7F]/.test(text)) return text

  const candidate = iconv.decode(iconv.encode(text, 'gb18030'), 'utf8')
  if (!candidate || candidate === text || candidate.includes('\uFFFD')) return text

  const roundTrip = iconv.decode(Buffer.from(candidate, 'utf8'), 'gb18030')
  return roundTrip === text ? candidate : text
}
