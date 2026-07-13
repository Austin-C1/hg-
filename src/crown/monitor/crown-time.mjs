const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'
const MAX_INFERRED_YEAR_DISTANCE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SOURCE_OFFSET_MINUTES = 14 * 60
const MAX_SYSTEM_TIME_SKEW_MS = 2 * 60 * 1000
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function pad(value) {
  return String(value).padStart(2, '0')
}

function fullDateTimeParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
  return match ? match.slice(1).map(Number) : null
}

function validDateParts(year, month, day, hour, minute, second = 0) {
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
}

function offsetTimeZone(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function crownSourceContext(systemTime, capturedAt) {
  const parts = fullDateTimeParts(systemTime)
  const captured = Date.parse(String(capturedAt || ''))
  if (!parts || !validDateParts(...parts) || !Number.isFinite(captured)) return null
  const [year, month, day, hour, minute, second] = parts
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const offsetMinutes = Math.round((wallAsUtc - captured) / (15 * 60 * 1000)) * 15
  if (Math.abs(offsetMinutes) > MAX_SOURCE_OFFSET_MINUTES) return null
  if (Math.abs(wallAsUtc - (captured + offsetMinutes * 60_000)) > MAX_SYSTEM_TIME_SKEW_MS) return null
  return { offsetMinutes, localYear: year, timeZone: offsetTimeZone(offsetMinutes) }
}

function dateFromOffsetParts(year, month, day, hour, minute, second, offsetMinutes) {
  if (!validDateParts(year, month, day, hour, minute, second)) return null
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000
  return {
    milliseconds,
    utc: new Date(milliseconds).toISOString(),
    local: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
  }
}

function shanghaiParts(milliseconds) {
  return Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  )
}

function matchesParts(actual, expected) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second']
    .every((key) => actual[key] === expected[key])
}

function dateFromShanghaiParts(year, month, day, hour, minute, second = 0) {
  const expected = { year, month, day, hour, minute, second }
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null

  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const sampleTimes = [localAsUtc - 24 * 60 * 60 * 1000, localAsUtc, localAsUtc + 24 * 60 * 60 * 1000]
  const offsets = new Set(sampleTimes.map((sample) => {
    const parts = shanghaiParts(sample)
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - sample
  }))
  const candidates = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((milliseconds) => matchesParts(shanghaiParts(milliseconds), expected))
    .sort((left, right) => left - right)
  if (!candidates.length) return null
  const utcMilliseconds = candidates[0]
  return {
    milliseconds: utcMilliseconds,
    utc: new Date(utcMilliseconds).toISOString(),
    local: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
  }
}

function unparsedKickoff(raw, timeZone = SHANGHAI_TIME_ZONE) {
  return {
    raw: raw || null,
    utc: null,
    local: null,
    timeZone,
    source: null,
    confidence: 'none',
    warnings: ['kickoff-unparsed'],
  }
}

export function parseCrownKickoff(input = {}) {
  const { gameDateTime = '', datetime = '', capturedAt = '', systemTime = '' } = input && typeof input === 'object' ? input : {}
  const fullRaw = String(gameDateTime || '').trim()
  const shortRaw = String(datetime || '').trim()
  const sourceContext = systemTime ? crownSourceContext(systemTime, capturedAt) : null
  if (systemTime && !sourceContext) return unparsedKickoff(fullRaw || shortRaw, null)
  const fullGameDateTime = fullDateTimeParts(fullRaw)
  const fullDatetime = fullDateTimeParts(shortRaw)
  const full = fullGameDateTime || fullDatetime
  if (full) {
    const parsed = sourceContext
      ? dateFromOffsetParts(...full, sourceContext.offsetMinutes)
      : dateFromShanghaiParts(...full)
    if (parsed) {
      return {
        raw: fullGameDateTime ? fullRaw : shortRaw,
        utc: parsed.utc,
        local: parsed.local,
        timeZone: sourceContext?.timeZone || SHANGHAI_TIME_ZONE,
        source: fullGameDateTime ? 'GAME_DATE_TIME' : 'DATETIME',
        confidence: 'high',
        warnings: [],
      }
    }
  }

  const short = shortRaw.match(/^(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})([ap])(?:m)?$/i)
  const capturedMilliseconds = Date.parse(String(capturedAt || ''))
  if (short && Number.isFinite(capturedMilliseconds)) {
    const [, monthText, dayText, hourText, minuteText, meridiem] = short
    const month = Number(monthText)
    const day = Number(dayText)
    const hour12 = Number(hourText)
    const minute = Number(minuteText)
    const hour = hour12 % 12 + (meridiem.toLowerCase() === 'p' ? 12 : 0)
    const capturedYear = sourceContext?.localYear ?? shanghaiParts(capturedMilliseconds).year

    if (hour12 >= 1 && hour12 <= 12 && minute <= 59) {
      const candidates = [capturedYear - 1, capturedYear, capturedYear + 1]
        .map((year) => sourceContext
          ? dateFromOffsetParts(year, month, day, hour, minute, 0, sourceContext.offsetMinutes)
          : dateFromShanghaiParts(year, month, day, hour, minute))
        .filter(Boolean)
        .map((candidate) => ({
          ...candidate,
          distance: Math.abs(candidate.milliseconds - capturedMilliseconds),
        }))
        .filter((candidate) => candidate.distance <= MAX_INFERRED_YEAR_DISTANCE_MS)
        .sort((left, right) => left.distance - right.distance)
      if (candidates.length) {
        return {
          raw: shortRaw,
          utc: candidates[0].utc,
          local: candidates[0].local,
          timeZone: sourceContext?.timeZone || SHANGHAI_TIME_ZONE,
          source: 'DATETIME',
          confidence: 'medium',
          warnings: ['kickoff-year-inferred'],
        }
      }
    }
  }

  return unparsedKickoff(fullRaw || shortRaw)
}

export function parseCrownLiveClock(value) {
  const raw = String(value || '').trim()
  if (/^(?:HT|HALF[ _-]?TIME|中场(?:休息)?)$/i.test(raw)) {
    return { raw, phase: 'half_time', elapsedMinute: null, seconds: 0, warnings: [] }
  }

  const match = raw.match(/^([12])H\^(\d{1,3}):(\d{2})$/i)
  if (!match || Number(match[3]) > 59) {
    return {
      raw: raw || null,
      phase: null,
      elapsedMinute: null,
      seconds: null,
      warnings: ['live-clock-unparsed'],
    }
  }

  const phase = match[1] === '1' ? 'first_half' : 'second_half'
  const elapsedMinute = Number(match[2])
  const seconds = Number(match[3])
  if (phase === 'second_half' && elapsedMinute < 45) {
    return { raw, phase, elapsedMinute: null, seconds, warnings: ['ambiguous-live-clock'] }
  }
  return { raw, phase, elapsedMinute, seconds, warnings: [] }
}
