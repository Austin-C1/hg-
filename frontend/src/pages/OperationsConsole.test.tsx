import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import OperationsConsole from './OperationsConsole'
import { api } from '../services/api'
import type { OperationsSummary } from '../types'
import { browserBettingSummary } from '../test/browserBettingFixture'

const summary = {
  serverTime: '2026-07-11T12:00:00.000Z',
  freshness: { lastOddsAt: '2026-07-11T11:59:50.000Z', ageMs: 10_000, state: 'fresh', staleAfterMs: 60_000 },
  watcher: { active: true, unique: true, activeCount: 1, heartbeatAt: '2026-07-11T11:59:58.000Z', expiresAt: '2026-07-11T12:00:28.000Z', fencingToken: 7 },
  readiness: {
    monitor: { state: 'ready', ready: true, reason: '' },
    rules: { state: 'ready', ready: true, reason: '' },
    accounts: { state: 'ready', ready: true, reason: '' },
    realBetting: { state: 'off', ready: false, reason: 'global-real-betting-off' },
  },
  runtime: { requested: false, state: 'off', reasonCode: '', updatedAt: '2026-07-11T11:59:55.000Z' },
  monitorAlerts: {
    prematch: { enabled: true, reviewRequired: false, markets: { asianHandicap: true, total: true } },
    live: { enabled: true, reviewRequired: false, markets: { asianHandicap: true, total: false } },
  },
  ruleCards: { total: 3, enabled: 2, reviewRequired: 1, ownedLeagues: 5 },
  rules: { total: 3, monitorEnabled: 2, realEnabled: 1, hitCount: 14, recentHitCount: 4 },
  accounts: { total: 3, enabled: 1, pausePending: 1, paused: 1, checking: 0, locked: 1, unknown: 1 },
  batches: { recentLimit: 20, recentCount: 6, active: 1, completed: 2, partial: 1, failed: 1, cancelled: 1, acceptedAmountMinor: 180, unknownAmountMinor: 40 },
  reconciliation: { due: 2, manualReview: 1, deadLetter: 1, open: 4 },
  notifications: { backlog: 3, pending: 2, delivering: 1, deadLetter: 0 },
  recentBatches: [{ batchId: 'batch-safe', status: 'waiting_result', acceptedAmountMinor: 20, unknownAmountMinor: 40, createdAt: '2026-07-11T11:56:00.000Z' }],
  browserBetting: browserBettingSummary,
} as unknown as OperationsSummary

vi.mock('../services/api', () => ({
  api: {
    getOperationsSummary: vi.fn(),
    getRuntimeCleanupPreview: vi.fn(),
    runRuntimeCleanup: vi.fn(),
    monitorAccountAction: vi.fn(async () => ({ item: {} })),
    startRealBetting: vi.fn(async () => ({ item: { ...summary.runtime, requested: true, state: 'armed_waiting' } })),
    stopRealBetting: vi.fn(async () => ({ item: { ...summary.runtime, requested: false, state: 'stopping' } })),
  },
}))

describe('OperationsConsole', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(api.getOperationsSummary).mockResolvedValue({ item: summary })
    vi.mocked(api.getRuntimeCleanupPreview).mockResolvedValue({ item: { bytes: 2048, files: 6, records: 0, categories: { 'monitor-history': 1024 } } })
    vi.mocked(api.runRuntimeCleanup).mockResolvedValue({ item: { bytes: 2048, files: 6, records: 0, categories: { 'monitor-history': 1024 }, databaseRows: {}, restartedWatcher: true, cleanedAt: '2026-07-12T04:00:00.000Z' } })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  test('shows dynamic rule card totals instead of fixed prematch/live betting modes', async () => {
    render(<OperationsConsole />)
    expect(await screen.findByText(/卡片总数：3/)).toBeInTheDocument()
    expect(screen.getByText('已占用联赛：5')).toBeInTheDocument()
    expect(screen.queryByText('赛前投注')).not.toBeInTheDocument()
    expect(screen.queryByText('滚球投注')).not.toBeInTheDocument()
  })

  test.each([
    ['legacy autoBetting-only DTO', { autoBetting: { prematch: {}, live: {} } }],
    ['missing ruleCards DTO', {}],
  ])('renders safe zero card state and keeps start disabled for %s', async (_name, legacyFields) => {
    const oldDto = {
      ...summary,
      ...legacyFields,
      ruleCards: undefined,
      accounts: { ...summary.accounts, unknown: 0 },
      batches: { ...summary.batches, unknownAmountMinor: 0 },
      reconciliation: { due: 0, manualReview: 0, deadLetter: 0, open: 0 },
      notifications: { backlog: 0, pending: 0, delivering: 0, deadLetter: 0 },
    } as unknown as OperationsSummary
    vi.mocked(api.getOperationsSummary).mockResolvedValueOnce({ item: oldDto })
    render(<OperationsConsole />)
    expect(await screen.findByText(/卡片总数：0/)).toBeInTheDocument()
    expect(screen.getAllByText('动态卡片状态不可用，真实投注保持阻断').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '开启真实投注' })).toBeDisabled()
  })

  test('leads with unknown/reconciliation risk and never renders provider or secret material', async () => {
    vi.mocked(api.getOperationsSummary).mockResolvedValueOnce({ item: {
      ...summary,
      recentBatches: [{ ...summary.recentBatches[0], batchId: 'safe-public-id' }],
    } })
    render(<OperationsConsole />)

    expect(await screen.findByRole('heading', { name: '待确认投注' })).toBeInTheDocument()
    expect(screen.getByTestId('unknown-risk')).toHaveTextContent('40 CNY')
    expect(screen.getByTestId('reconciliation-risk')).toHaveTextContent('待处理 2')
    expect(screen.queryByText(/provider|reference|secret|cookie|password/i)).not.toBeInTheDocument()
    const table = screen.getByRole('table', { name: '最近投注批次' })
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)
    expect(within(table).getAllByRole('cell')).toHaveLength(4)
    expect(within(table).queryByText('safe-public-id')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看全部投注历史' })).toHaveAttribute('href', '/betting-history')
  })

  test('shows browser betting after the highest-priority unknown risk and keeps stop reachable', async () => {
    vi.mocked(api.getOperationsSummary).mockResolvedValueOnce({ item: {
      ...summary,
      runtime: { ...summary.runtime, requested: true, state: 'running' },
    } as OperationsSummary })
    render(<OperationsConsole />)
    const risk = await screen.findByTestId('unknown-risk')
    const browser = screen.getByRole('heading', { name: '浏览器内 API' })
    expect(risk.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('crown-protocol-capabilities-v2:test-safe')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '八方向能力矩阵' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止真实投注' })).toBeEnabled()
  })

  test('stale or offline keeps the last values, disables start and leaves stop reachable', async () => {
    const stale = {
      ...summary,
      freshness: { ...summary.freshness, ageMs: 70_000, state: 'stale' as const },
      runtime: { ...summary.runtime, requested: true, state: 'running' as const },
    }
    vi.mocked(api.getOperationsSummary)
      .mockResolvedValueOnce({ item: stale })
      .mockRejectedValueOnce(new Error('network-down'))
    render(<OperationsConsole />)

    expect(await screen.findByRole('table', { name: '最近投注批次' })).toBeInTheDocument()
    expect(screen.queryByText('batch-safe', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开启真实投注' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止真实投注' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '立即刷新' }))
    expect(await screen.findByText('连接中断，正在显示最后一次数据')).toBeInTheDocument()
    expect(screen.queryByText('batch-safe', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开启真实投注' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止真实投注' })).toBeEnabled()
  })

  test('polls at 5s/30s without overlap and refreshes immediately when visible again', async () => {
    vi.useFakeTimers()
    let resolveSecond: ((value: { item: OperationsSummary }) => void) | undefined
    vi.mocked(api.getOperationsSummary)
      .mockResolvedValueOnce({ item: summary })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
      .mockResolvedValue({ item: summary })
    render(<OperationsConsole />)
    await act(async () => { await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(20_000); await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(2)
    await act(async () => { resolveSecond?.({ item: summary }); await Promise.resolve() })

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { vi.advanceTimersByTime(29_999); await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(3)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.getOperationsSummary).toHaveBeenCalledTimes(4)
  })

  test('previews and runs manual cache cleanup only after confirmation', async () => {
    render(<OperationsConsole />)

    expect(await screen.findByText('可清理 2 KB / 6 个文件')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '每日开工完全重置' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认完全重置' }))

    await waitFor(() => expect(api.runRuntimeCleanup).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('当前没有可清理缓存')).toBeInTheDocument()
  })

  test('explains how to hand an unmanaged watcher back to the Dashboard before cleanup', async () => {
    vi.mocked(api.getRuntimeCleanupPreview).mockRejectedValueOnce(new Error('runtime-cleanup-watcher-unmanaged'))

    render(<OperationsConsole />)

    expect(await screen.findByText(/监控由其他程序启动/)).toHaveTextContent('停止程序')
    expect(screen.getByRole('button', { name: '每日开工完全重置' })).toBeDisabled()
  })

  test('reports a failed watcher recovery without claiming the reset left data untouched', async () => {
    vi.mocked(api.runRuntimeCleanup).mockRejectedValueOnce(new Error('runtime-cleanup-watcher-restart-unhealthy'))
    render(<OperationsConsole />)
    await screen.findByText('可清理 2 KB / 6 个文件')

    fireEvent.click(screen.getByRole('button', { name: '每日开工完全重置' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认完全重置' }))

    expect(await screen.findByText(/运行数据已重置，但监控未恢复/)).toBeInTheDocument()
    expect(screen.queryByText(/程序数据未被强制删除/)).not.toBeInTheDocument()
  })

  test('keeps the stop fail-safe visible in every runtime state and keeps zero risk neutral', async () => {
    vi.mocked(api.getOperationsSummary).mockResolvedValue({ item: {
      ...summary,
      accounts: { ...summary.accounts, unknown: 0 },
      batches: { ...summary.batches, unknownAmountMinor: 0 },
      reconciliation: { due: 0, manualReview: 0, deadLetter: 0, open: 0 },
      notifications: { backlog: 0, pending: 0, delivering: 0, deadLetter: 0 },
      browserBetting: { ...browserBettingSummary, campaign: null },
    } })
    render(<OperationsConsole />)

    expect(await screen.findByRole('button', { name: '停止监控' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '启动监控' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开启真实投注' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '停止真实投注' })).toBeEnabled()
    expect(screen.queryByTestId('unknown-risk')).not.toBeInTheDocument()
    expect(screen.getByText('当前无待处理风险')).toBeInTheDocument()
    expect(screen.getByText('赔率监控')).toBeInTheDocument()
    expect(screen.getByText('策略规则')).toBeInTheDocument()
    expect(screen.getByText('投注账号')).toBeInTheDocument()
    expect(screen.getByText('全局真实投注')).toBeInTheDocument()
  })

  test('treats a failed browser campaign with unknown cases as highest-priority risk and blocks start', async () => {
    vi.mocked(api.getOperationsSummary).mockResolvedValueOnce({ item: {
      ...summary,
      accounts: { ...summary.accounts, unknown: 0 },
      batches: { ...summary.batches, unknownAmountMinor: 0 },
      reconciliation: { due: 0, manualReview: 0, deadLetter: 0, open: 0 },
      notifications: { backlog: 0, pending: 0, delivering: 0, deadLetter: 0 },
      browserBetting: {
        ...browserBettingSummary,
        campaign: { ...browserBettingSummary.campaign!, state: 'failed', unknownCount: 1 },
      },
    } })
    render(<OperationsConsole />)

    const risk = await screen.findByTestId('unknown-risk')
    expect(within(risk).getByRole('heading', { name: '待确认投注' })).toBeInTheDocument()
    expect(risk).toHaveTextContent('验收 unknown 1')
    expect(screen.queryByText('当前无待处理风险')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开启真实投注' })).toBeDisabled()
  })

  test('shows alert modes, dynamic rule cards, canonical settings links and global controls', async () => {
    render(<OperationsConsole />)
    expect(await screen.findByText('赛前报警：已启用')).toBeInTheDocument()
    expect(screen.getByText('滚球报警：已启用')).toBeInTheDocument()
    expect(screen.getByText('赛前报警待复核：否')).toBeInTheDocument()
    expect(screen.getByText('赛前盘口：让球 已启用 · 大小球 已启用')).toBeInTheDocument()
    expect(screen.getByText('滚球盘口：让球 已启用 · 大小球 已关闭')).toBeInTheDocument()
    expect(screen.getByText('卡片总数：3', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('已占用联赛：5')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '监控报警' })).toHaveAttribute('href', '/monitor-alerts')
    expect(screen.getByRole('link', { name: '投注规则' })).toHaveAttribute('href', '/betting-rules')
    expect(screen.getByRole('button', { name: '停止监控' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开启真实投注' })).toBeInTheDocument()
  })

  test('shows Watcher bounded recovery state and last exit reason', async () => {
    vi.mocked(api.getOperationsSummary).mockResolvedValueOnce({ item: {
      ...summary,
      watcher: {
        ...summary.watcher,
        process: {
          desiredRunning: true,
          processState: 'waiting-restart',
          restartAttempt: 2,
          nextRestartAt: '2026-07-11T12:00:05.000Z',
          lastExit: {
            exitCode: 1,
            signal: null,
            exitedAt: '2026-07-11T12:00:00.000Z',
            stderrSummary: 'watcher transport failed',
          },
        },
      },
    } })
    render(<OperationsConsole />)

    expect(await screen.findByText('Watcher 正在等待第 2 次恢复')).toBeInTheDocument()
    expect(screen.getByText(/watcher transport failed/)).toBeInTheDocument()
  })
})
