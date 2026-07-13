import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import MatchSelection from './MatchSelection'
import { api } from '../services/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

vi.mock('../services/api', () => ({
  api: {
    getLeagueSummaries: vi.fn(async () => ({
      oddsSummary: {
        readonly: true,
        source: 'xml-live',
        dataSource: { kind: 'xml-live', label: 'XML live', lastXmlAt: '2026-07-09T00:00:00.000Z', lastSnapshotAt: null },
        totals: { events: 1, leagues: 1, snapshots: 1, changes: 1 },
        lastCapturedAt: '2026-07-09T00:00:00.000Z',
      },
      defaultLeagues: { stats: { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 }, items: [], config: { version: 1, leagues: [] } },
      items: [{
        league: '英超',
        prematchEventCount: 1,
        liveEventCount: 0,
        totalOddsCount: 1,
        inDefaultWhitelist: false,
        defaultAutoTracked: false,
        tracked: false,
        trackingSource: 'none',
        lastCapturedAt: '2026-07-09T00:00:00.000Z',
        events: [{
          eventKey: 'event-1',
          league: '英超',
          homeTeam: '主队',
          awayTeam: '客队',
          mode: 'prematch',
          status: 'not_started',
          recordCount: 1,
          marketCount: 1,
          selectionCount: 1,
          lastCapturedAt: '2026-07-09T00:00:00.000Z',
          dataQuality: { complete: false, reasons: ['start_time_missing'] },
          markets: [{
            marketKey: 'market-1',
            marketType: 'asian_handicap',
            period: 'full_time',
            handicapRaw: '0 / 0.5',
            selections: [{ selectionKey: 'selection-1', side: 'home', oddsRaw: '0.97', odds: 0.97, capturedAt: '2026-07-09T00:00:00.000Z' }],
          }],
        }],
      }],
    })),
    changes: vi.fn(async () => ({
      items: [{
        type: 'odds-change',
        key: 'change-1',
        capturedAt: '2026-07-09T00:01:00.000Z',
        eventKey: 'event-1',
        mode: 'prematch',
        league: '英超',
        homeTeam: '主队',
        awayTeam: '客队',
        marketType: 'asian_handicap',
        period: 'full_time',
        side: 'home',
        oldHandicapRaw: '0 / 0.5',
        newHandicapRaw: '0 / 0.5',
        oldOddsRaw: '0.94',
        newOddsRaw: '0.97',
        direction: 'up',
      }, {
        type: 'odds-change',
        key: 'change-2',
        capturedAt: '2026-07-09T00:02:00',
        eventKey: 'event-1',
        mode: 'prematch',
        league: '英超',
        homeTeam: '主队',
        awayTeam: '客队',
        marketType: 'moneyline',
        period: 'full_time',
        side: 'home',
        oldHandicapRaw: null,
        newHandicapRaw: null,
        oldOddsRaw: '7.60',
        newOddsRaw: '8.00',
        direction: 'up',
      }],
    })),
    trackLeague: vi.fn(async () => ({ ok: true })),
    untrackLeague: vi.fn(async () => ({ ok: true })),
  },
}))

const defaultGetLeagueSummaries = vi.mocked(api.getLeagueSummaries).getMockImplementation()!
const defaultChanges = vi.mocked(api.changes).getMockImplementation()!

describe('MatchSelection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(api.getLeagueSummaries).mockImplementation(defaultGetLeagueSummaries)
    vi.mocked(api.changes).mockImplementation(defaultChanges)
  })

  test('event detail drawer shows recorded odds changes instead of current market rows', async () => {
    render(<MatchSelection />)

    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    expect((await screen.findAllByText('变化时间')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('变化前').length).toBeGreaterThan(0)
    expect(screen.getAllByText('变化后').length).toBeGreaterThan(0)
    expect(screen.getByText('2026-07-09 08:01:00')).toBeInTheDocument()
    expect(screen.getByText('0 / 0.5 · 主队 0.94')).toBeInTheDocument()
    expect(screen.getByText('0 / 0.5 · 主队 0.97')).toBeInTheDocument()
    expect(screen.queryByText('独赢 / 全场 / 主队')).not.toBeInTheDocument()
    expect(screen.queryByText('主队 7.60')).not.toBeInTheDocument()
    expect(screen.queryByText('- · 主队 7.60')).not.toBeInTheDocument()
    expect(screen.queryByText('盘口值')).not.toBeInTheDocument()
    expect(screen.queryByText('投注候选')).not.toBeInTheDocument()
  })

  test('shows normalized event data-quality reasons without calling raw changes candidates', async () => {
    render(<MatchSelection />)

    expect(await screen.findByText('数据不完整：缺少开赛时间')).toBeInTheDocument()
    expect(screen.queryByText('投注候选')).not.toBeInTheDocument()
  })

  test('shows Beijing kickoff quality diagnostics and sorts UTC ascending with missing times last', async () => {
    const current = await api.getLeagueSummaries()
    const template = current.items[0].events[0]
    vi.mocked(api.getLeagueSummaries).mockResolvedValueOnce({
      ...current,
      items: [{
        ...current.items[0],
        events: [{
          ...template,
          eventKey: 'event-missing', homeTeam: '未定主队', awayTeam: '未定客队',
          startTimeRaw: null, startTimeUtc: null, startTimeBeijing: null,
          timeQuality: 'missing', timeWarnings: ['kickoff-unparsed'],
        }, {
          ...template,
          eventKey: 'event-later', homeTeam: '晚场主队', awayTeam: '晚场客队',
          startTimeRaw: '07-10 21:00', startTimeUtc: '2026-07-10T13:00:00.000Z', startTimeBeijing: '2026-07-10 21:00:00',
          timeQuality: 'high', timeWarnings: [],
        }, {
          ...template,
          eventKey: 'event-earlier', homeTeam: '早场主队', awayTeam: '早场客队',
          startTimeRaw: '07-10 20:00', startTimeUtc: '2026-07-10T12:00:00.000Z', startTimeBeijing: '2026-07-10 20:00:00',
          timeQuality: 'inferred', timeWarnings: ['kickoff-year-inferred'],
        }],
      }],
    })

    render(<MatchSelection />)

    expect(await screen.findByText('早场主队 vs 早场客队')).toBeInTheDocument()
    const matches = screen.getAllByText(/(?:早场|晚场|未定)主队 vs (?:早场|晚场|未定)客队/)
    expect(matches.map((node) => node.textContent)).toEqual([
      '早场主队 vs 早场客队',
      '晚场主队 vs 晚场客队',
      '未定主队 vs 未定客队',
    ])
    const earlyRow = screen.getByText('早场主队 vs 早场客队').closest('tr')
    const missingRow = screen.getByText('未定主队 vs 未定客队').closest('tr')
    expect(earlyRow).not.toBeNull()
    expect(missingRow).not.toBeNull()
    expect(within(earlyRow!).getByText('2026-07-10 20:00:00')).toBeInTheDocument()
    expect(within(earlyRow!).getByText('inferred')).toBeInTheDocument()
    expect(within(earlyRow!).getByText('kickoff-year-inferred')).toBeInTheDocument()
    expect(within(missingRow!).getByText('missing')).toBeInTheDocument()
    expect(within(missingRow!).getAllByText('-').length).toBeGreaterThan(0)
  })

  test('loads only league summaries on first screen and every 30 seconds', async () => {
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      intervalCallbacks.push(handler as () => void)
      return 1
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)

    try {
      render(<MatchSelection />)

      expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
      expect(api.getLeagueSummaries).toHaveBeenCalledTimes(1)
      expect(api.changes).not.toHaveBeenCalled()
      expect(intervalCallbacks.length).toBeGreaterThan(0)

      await act(async () => {
        intervalCallbacks.forEach((callback) => callback())
      })

      await waitFor(() => expect(api.getLeagueSummaries).toHaveBeenCalledTimes(2))
      expect(api.changes).not.toHaveBeenCalled()
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('loads event-specific change history when global recent changes do not include the match', async () => {
    vi.mocked(api.changes).mockImplementation(async (params?: { eventKey?: string; limit?: number }) => {
      if (params?.eventKey === 'event-1') {
        return {
          items: [{
            type: 'odds-change',
            key: 'event-change-1',
            capturedAt: '2026-07-09T00:03:00',
            eventKey: 'event-1',
            provider: 'crown',
            mode: 'prematch',
            league: '英超',
            homeTeam: '主队',
            awayTeam: '客队',
            marketType: 'asian_handicap',
            period: 'full_time',
            handicapRaw: '0 / 0.5',
            side: 'home',
            oldHandicapRaw: '0 / 0.5',
            newHandicapRaw: '0 / 0.5',
            oldOddsRaw: '0.91',
            newOddsRaw: '0.96',
            direction: 'up',
          }],
        }
      }
      return { items: [] }
    })

    render(<MatchSelection />)

    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    expect(await screen.findByText('0 / 0.5 · 主队 0.91')).toBeInTheDocument()
    expect(screen.getByText('0 / 0.5 · 主队 0.96')).toBeInTheDocument()
    expect(api.changes).toHaveBeenCalledTimes(1)
    expect(api.changes).toHaveBeenCalledWith({ eventKey: 'event-1', limit: 1000 })
  })

  test('keeps existing list and detail visible without spin blur during background refresh', async () => {
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      intervalCallbacks.push(handler as () => void)
      return 1
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)

    const summary = await api.getLeagueSummaries()
    vi.mocked(api.getLeagueSummaries).mockClear()

    try {
      render(<MatchSelection />)
      expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '详情' }))
      expect(await screen.findByText('0 / 0.5 · 主队 0.94')).toBeInTheDocument()

      const listRefresh = deferred<Awaited<ReturnType<typeof api.getLeagueSummaries>>>()
      const detailRefresh = deferred<Awaited<ReturnType<typeof api.changes>>>()
      vi.mocked(api.getLeagueSummaries).mockReturnValueOnce(listRefresh.promise)
      vi.mocked(api.changes).mockReturnValueOnce(detailRefresh.promise)

      act(() => intervalCallbacks.forEach((callback) => callback()))

      expect(document.querySelector('.ant-spin-blur')).not.toBeInTheDocument()
      expect(screen.getAllByText('主队 vs 客队').length).toBeGreaterThan(0)
      expect(screen.getByText('0 / 0.5 · 主队 0.94')).toBeInTheDocument()

      await act(async () => {
        listRefresh.resolve(summary)
        detailRefresh.resolve({ items: [] })
      })
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('coalesces overlapping list requests and same-event detail requests', async () => {
    const intervalCallbacks: Array<() => void> = []
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      intervalCallbacks.push(handler as () => void)
      return 1
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const initialSummary = await api.getLeagueSummaries()
    vi.mocked(api.getLeagueSummaries).mockClear()
    const listRequest = deferred<typeof initialSummary>()
    vi.mocked(api.getLeagueSummaries).mockReturnValueOnce(listRequest.promise)

    try {
      render(<MatchSelection />)
      act(() => intervalCallbacks.forEach((callback) => {
        callback()
        callback()
      }))
      expect(api.getLeagueSummaries).toHaveBeenCalledTimes(1)

      await act(async () => listRequest.resolve(initialSummary))
      expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()

      const detailRequest = deferred<Awaited<ReturnType<typeof api.changes>>>()
      vi.mocked(api.changes).mockReturnValueOnce(detailRequest.promise)
      fireEvent.click(screen.getByRole('button', { name: '详情' }))
      act(() => intervalCallbacks.forEach((callback) => {
        callback()
        callback()
      }))
      expect(api.changes).toHaveBeenCalledTimes(1)

      await act(async () => detailRequest.resolve({ items: [] }))
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('does not let a late response from the previous event pollute the current drawer', async () => {
    const current = await api.getLeagueSummaries()
    const first = current.items[0].events[0]
    vi.mocked(api.getLeagueSummaries).mockResolvedValueOnce({
      ...current,
      items: [{
        ...current.items[0],
        events: [first, {
          ...first,
          eventKey: 'event-2',
          homeTeam: '次场主队',
          awayTeam: '次场客队',
        }],
      }],
    })
    const firstChanges = deferred<Awaited<ReturnType<typeof api.changes>>>()
    const secondChanges = deferred<Awaited<ReturnType<typeof api.changes>>>()
    vi.mocked(api.changes).mockImplementation((params?: { eventKey?: string }) => (
      params?.eventKey === 'event-1' ? firstChanges.promise : secondChanges.promise
    ))

    render(<MatchSelection />)
    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    const detailButtons = screen.getAllByRole('button', { name: '详情' })
    fireEvent.click(detailButtons[0])
    fireEvent.click(detailButtons[1])

    await act(async () => secondChanges.resolve({
      items: [{
        type: 'odds-change', key: 'event-2-change', capturedAt: '2026-07-09T00:04:00.000Z',
        eventKey: 'event-2', mode: 'prematch', league: '英超', homeTeam: '次场主队', awayTeam: '次场客队',
        provider: 'crown', marketType: 'asian_handicap', period: 'full_time', handicapRaw: '0', side: 'home', oldHandicapRaw: '0',
        newHandicapRaw: '0', oldOddsRaw: '0.80', newOddsRaw: '0.81', direction: 'up',
      }],
    }))
    expect(await screen.findByText('0 · 主队 0.80')).toBeInTheDocument()

    await act(async () => firstChanges.resolve({
      items: [{
        type: 'odds-change', key: 'event-1-late', capturedAt: '2026-07-09T00:05:00.000Z',
        eventKey: 'event-1', mode: 'prematch', league: '英超', homeTeam: '主队', awayTeam: '客队',
        provider: 'crown', marketType: 'asian_handicap', period: 'full_time', handicapRaw: '0.5', side: 'home', oldHandicapRaw: '0.5',
        newHandicapRaw: '0.5', oldOddsRaw: '0.70', newOddsRaw: '0.71', direction: 'up',
      }],
    }))
    expect(screen.getByText('0 · 主队 0.80')).toBeInTheDocument()
    expect(screen.queryByText('0.5 · 主队 0.70')).not.toBeInTheDocument()
  })

  test('shows cached event changes without spin after closing before the request completes', async () => {
    const detailRequest = deferred<Awaited<ReturnType<typeof api.changes>>>()
    vi.mocked(api.changes).mockReturnValueOnce(detailRequest.promise)

    render(<MatchSelection />)
    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    await waitFor(() => expect(document.querySelector('.ant-spin-blur')).toBeInTheDocument())
    fireEvent.click(document.querySelector('.ant-drawer-close')!)

    await act(async () => detailRequest.resolve({
      items: [{
        type: 'odds-change', key: 'cached-after-close', capturedAt: '2026-07-09T00:06:00.000Z',
        eventKey: 'event-1', provider: 'crown', mode: 'prematch', league: '英超', homeTeam: '主队', awayTeam: '客队',
        marketType: 'asian_handicap', period: 'full_time', handicapRaw: '0', side: 'home', oldHandicapRaw: '0',
        newHandicapRaw: '0', oldOddsRaw: '0.82', newOddsRaw: '0.83', direction: 'up',
      }],
    }))

    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    expect(await screen.findByText('0 · 主队 0.82')).toBeInTheDocument()
    expect(document.querySelector('.ant-spin-blur')).not.toBeInTheDocument()
  })

  test('keeps event B loading when event A completes first', async () => {
    const current = await api.getLeagueSummaries()
    const first = current.items[0].events[0]
    vi.mocked(api.getLeagueSummaries).mockResolvedValueOnce({
      ...current,
      items: [{
        ...current.items[0],
        events: [first, { ...first, eventKey: 'event-2', homeTeam: '次场主队', awayTeam: '次场客队' }],
      }],
    })
    const firstChanges = deferred<Awaited<ReturnType<typeof api.changes>>>()
    const secondChanges = deferred<Awaited<ReturnType<typeof api.changes>>>()
    vi.mocked(api.changes).mockImplementation((params?: { eventKey?: string }) => (
      params?.eventKey === 'event-1' ? firstChanges.promise : secondChanges.promise
    ))

    render(<MatchSelection />)
    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    const detailButtons = screen.getAllByRole('button', { name: '详情' })
    fireEvent.click(detailButtons[0])
    fireEvent.click(detailButtons[1])
    await waitFor(() => expect(document.querySelector('.ant-spin-blur')).toBeInTheDocument())

    await act(async () => firstChanges.resolve({ items: [] }))
    expect(document.querySelector('.ant-spin-blur')).toBeInTheDocument()

    await act(async () => secondChanges.resolve({ items: [] }))
    expect(document.querySelector('.ant-spin-blur')).not.toBeInTheDocument()
  })

  test('shows loading while the first uncached detail request is pending', async () => {
    const detailRequest = deferred<Awaited<ReturnType<typeof api.changes>>>()
    vi.mocked(api.changes).mockReturnValueOnce(detailRequest.promise)

    render(<MatchSelection />)
    expect(await screen.findByText('主队 vs 客队')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    await waitFor(() => expect(document.querySelector('.ant-spin-blur')).toBeInTheDocument())
    await act(async () => detailRequest.resolve({ items: [] }))
  })

  test('clears the refresh interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(<MatchSelection />)

    unmount()

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    clearIntervalSpy.mockRestore()
  })
})
