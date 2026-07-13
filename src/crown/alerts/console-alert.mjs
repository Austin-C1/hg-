export function formatOddsChangeAlert(change) {
  const event = change?.event || {}
  const market = change?.market || {}
  const oldOdds = change?.old?.oddsRaw ?? 'unknown'
  const nextOdds = change?.next?.oddsRaw ?? 'unknown'

  return [
    '[crown odds change]',
    `${event.league || 'unknown league'}`,
    `${event.homeTeam || 'home'} vs ${event.awayTeam || 'away'}`,
    `${market.marketType || 'unknown'} ${market.handicapRaw || ''}`.trim(),
    `${oldOdds} -> ${nextOdds}`,
    change?.capturedAt || 'unknown time',
  ].join(' | ')
}

export function sendConsoleAlert(change, consoleLike = console) {
  const message = formatOddsChangeAlert(change)
  consoleLike.log(message)
  return { sent: true, channel: 'console', message }
}

export function formatSignalAlert(signal = {}) {
  return [
    '[crown signal]',
    `${signal.strategyId || 'unknown'}@${signal.strategyVersion || 'unknown'}`,
    String(signal.signalId || '').slice(0, 12) || 'unknown',
    signal.target?.eventIdentity || 'unknown event',
    `${signal.evidence?.marketType || 'unknown'} ${signal.target?.side || ''}`.trim(),
    `${signal.evidence?.oldOdds ?? 'unknown'} -> ${signal.evidence?.nextOdds ?? 'unknown'}`,
    `${signal.trigger?.direction || 'unknown'} delta=${signal.trigger?.delta ?? 'unknown'} threshold=${signal.trigger?.threshold ?? 'unknown'}`,
    signal.observedAt || 'unknown time',
  ].join(' | ')
}

export function sendConsoleSignalAlert(signal, consoleLike = console) {
  const message = formatSignalAlert(signal)
  consoleLike.log(message)
  return { sent: true, channel: 'console', message }
}
