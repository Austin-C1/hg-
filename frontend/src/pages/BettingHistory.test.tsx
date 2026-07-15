import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import BettingHistory from './BettingHistory'
import { api } from '../services/api'

const first = {
  historyKey: 'history-1', createdAt: '2026-07-15T01:02:03.000Z', finishedAt: '2026-07-15T01:03:03.000Z',
  match: { leagueName: '英超', homeTeam: '阿森纳', awayTeam: '切尔西' },
  direction: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', side: 'away', handicapRaw: '-0.5' },
  status: 'partial', finishReason: 'capacity_exhausted', acceptedBetCount: 2, averageAcceptedOdds: '1.05',
  completedAmount: '400', targetAmount: '1000', unknownAmount: '200', currency: 'CNY',
}

vi.mock('../services/api', () => ({
  api: { getBetTargetHistory: vi.fn() },
}))

describe('BettingHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getBetTargetHistory).mockResolvedValue({ items: [first], nextCursor: 'cursor-next' })
  })

  test('shows immutable target history, accepted odds, amounts, unknown risk, status and time', async () => {
    render(<BettingHistory />)
    const table = await screen.findByRole('table', { name: '投注历史列表' })
    expect(within(table).getByText('英超')).toBeInTheDocument()
    expect(within(table).getByText('阿森纳 vs 切尔西')).toBeInTheDocument()
    expect(within(table).getByText(/赛前 · 全场 · 让球 · 客 · -0.5/)).toBeInTheDocument()
    expect(within(table).getByText('1.05')).toBeInTheDocument()
    expect(within(table).getByText(/400 \/ 1000 CNY/)).toBeInTheDocument()
    expect(within(table).getByText('待确认 200 CNY')).toBeInTheDocument()
    expect(within(table).getByText('部分完成')).toBeInTheDocument()
    expect(within(table).getAllByText(/2026/)).toHaveLength(2)
  })

  test('loads more with the cursor and appends rows', async () => {
    vi.mocked(api.getBetTargetHistory)
      .mockResolvedValueOnce({ items: [first], nextCursor: 'cursor-next' })
      .mockResolvedValueOnce({
        items: [{ ...first, historyKey: 'history-2', match: { ...first.match, homeTeam: '利物浦', awayTeam: '曼城' } }],
        nextCursor: null,
      })
    render(<BettingHistory />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('利物浦 vs 曼城')).toBeInTheDocument()
    expect(api.getBetTargetHistory).toHaveBeenLastCalledWith({ limit: 20, cursor: 'cursor-next', status: 'all', mode: 'all' })
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  test('changing a filter clears old rows and cursor before loading the new result', async () => {
    render(<BettingHistory />)
    expect(await screen.findByText('阿森纳 vs 切尔西')).toBeInTheDocument()
    vi.mocked(api.getBetTargetHistory).mockResolvedValueOnce({
      items: [{ ...first, historyKey: 'live-1', direction: { ...first.direction, mode: 'live' }, match: { ...first.match, homeTeam: '皇马' } }],
      nextCursor: null,
    })
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '比赛模式' }))
    fireEvent.click(await screen.findByText('滚球', { selector: '.ant-select-item-option-content' }))
    expect(await screen.findByText('皇马 vs 切尔西')).toBeInTheDocument()
    expect(screen.queryByText('阿森纳 vs 切尔西')).not.toBeInTheDocument()
    expect(api.getBetTargetHistory).toHaveBeenLastCalledWith({ limit: 20, cursor: undefined, status: 'all', mode: 'live' })
  })

  test('shows empty and API-failure states', async () => {
    vi.mocked(api.getBetTargetHistory).mockResolvedValueOnce({ items: [], nextCursor: null })
    const empty = render(<BettingHistory />)
    expect(await screen.findByText('暂无真实投注历史')).toBeInTheDocument()
    empty.unmount()

    vi.mocked(api.getBetTargetHistory).mockRejectedValueOnce(new Error('network-down'))
    render(<BettingHistory />)
    expect(await screen.findByText('投注历史读取失败，请稍后重试。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('阿森纳 vs 切尔西')).not.toBeInTheDocument())
  })
})
