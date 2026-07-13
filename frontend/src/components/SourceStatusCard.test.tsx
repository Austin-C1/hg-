import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { SourceStatusCard } from './SourceStatusCard'
import type { OddsSummary } from '../types'
import { formatDateTime } from '../utils/formatDateTime'

function makeSummary(lastXmlAt: string | null): OddsSummary {
  return {
    readonly: true,
    source: 'xml-live',
    dataOrigin: null,
    dataSource: {
      kind: 'xml-live',
      label: 'XML live',
      lastXmlAt,
      xmlResponses: 1,
      getGameListCount: 1,
      getGameMoreCount: 0,
      xmlEvents: 35,
      normalizedRecords: 100,
      snapshotWrites: 100,
      changeWrites: 0,
      parseErrors: 0,
      emptyXmlResponses: 0,
      loginExpiredResponses: 0,
      lastSnapshotAt: lastXmlAt,
      eventCount: 35,
      recordCount: 100,
      changeCount: 0,
      oddsIdAvailable: false,
      oddsIdStatus: 'null-not-available',
      bettingExecution: 'not-connected',
    },
    totals: { events: 35, leagues: 10, snapshots: 100, changes: 0 },
    lastCapturedAt: lastXmlAt,
  }
}

describe('SourceStatusCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T22:09:50.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('marks XML live data as abnormal when the last update is stale', () => {
    render(<SourceStatusCard summary={makeSummary('2026-07-08T21:57:21.007Z')} />)

    expect(screen.getByText('赔率更新异常')).toBeInTheDocument()
    expect(screen.getByText(/超过 2 分钟未更新/)).toBeInTheDocument()
    expect(screen.queryByText('实时赔率正常')).not.toBeInTheDocument()
  })

  test('keeps XML live data normal when the last update is fresh', () => {
    render(<SourceStatusCard summary={makeSummary('2026-07-08T22:09:20.000Z')} />)

    expect(screen.getByText('实时赔率正常')).toBeInTheDocument()
    expect(screen.queryByText('赔率更新异常')).not.toBeInTheDocument()
  })

  test('treats fresh monitor v2 data as realtime', () => {
    const summary = makeSummary('2026-07-08T22:09:20.000Z')
    summary.source = 'monitor-v2'
    summary.dataSource!.kind = 'monitor-v2'
    summary.dataSource!.label = 'monitor-v2'

    const { container } = render(<SourceStatusCard summary={summary} />)

    expect(container.querySelector('.ant-alert-success')).toBeTruthy()
    expect(container.querySelector('.ant-alert-warning')).toBeNull()
  })

  test('uses the latest live timestamp when runtime XML time lags behind snapshots', () => {
    const summary = makeSummary('2026-07-08T21:57:21.007Z')
    summary.dataSource!.lastSnapshotAt = '2026-07-08T22:09:20.000Z'
    summary.lastCapturedAt = '2026-07-08T22:09:20.000Z'

    const { container } = render(<SourceStatusCard summary={summary} />)

    expect(container.querySelector('.ant-alert-success')).toBeTruthy()
    expect(container.querySelector('.ant-alert-error')).toBeNull()
    expect(container.textContent).toContain(formatDateTime('2026-07-08T22:09:20.000Z'))
  })
})
