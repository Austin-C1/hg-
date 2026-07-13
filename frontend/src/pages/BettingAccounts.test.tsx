import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import BettingAccounts from './BettingAccounts'
import { api } from '../services/api'

vi.mock('../services/api', () => ({
  isDashboardAuthenticationError: (error: unknown) => error instanceof Error && error.message === 'authentication-required',
  api: {
    getBettingAccountOverview: vi.fn(async () => ({
      bettingAccounts: [
        {
          id: 'bet_2',
          username: 'second-user',
          websiteUrl: 'https://example.test',
          betOrder: 2,
          status: 'enabled', archived: false, perBetLimit: '100.00', currency: 'CNY', amountScale: 2,
          stakeStep: '0.50', balance: '200.00', balanceUpdatedAt: '2026-07-11T02:00:00.000Z', executionStatus: 'idle',
          acceptedTodayCount: 3, acceptedTodayAmount: '12.00',
          hasSecret: true,
          createdAt: '2026-07-09T00:00:02.000Z',
          updatedAt: '2026-07-09T00:00:02.000Z',
        },
        {
          id: 'bet_1',
          username: 'first-user',
          websiteUrl: 'https://example.test',
          betOrder: 1,
          status: 'enabled', archived: false, perBetLimit: '100.00', currency: 'CNY', amountScale: 2,
          stakeStep: '0.50', balance: '200.00', balanceUpdatedAt: '2026-07-11T02:00:00.000Z', executionStatus: 'idle',
          acceptedTodayCount: 1, acceptedTodayAmount: '50.00',
          hasSecret: true,
          createdAt: '2026-07-09T00:00:01.000Z',
          updatedAt: '2026-07-09T00:00:01.000Z',
        },
        {
          id: 'bet_unset',
          username: 'unset-user',
          websiteUrl: 'https://example.test',
          betOrder: 0,
          status: 'disabled', archived: false, perBetLimit: '100.00', currency: 'CNY', amountScale: 2,
          stakeStep: '0.50', balance: null, balanceUpdatedAt: null, executionStatus: 'idle',
          acceptedTodayCount: 0, acceptedTodayAmount: '0.00',
          hasSecret: true,
          createdAt: '2026-07-09T00:00:03.000Z',
          updatedAt: '2026-07-09T00:00:03.000Z',
        },
      ],
      bettingHistory: [
        { id: 'legacy-1', accountId: 'bet_1', bettingAccountId: 'bet_1', leagueName: '英超', teams: '旧主队 vs 旧客队', market: '旧盘口', status: 'accepted', amount: 999, betTime: new Date().toISOString(), createdAt: new Date().toISOString() },
        { id: 'legacy-2', accountId: 'bet_1', bettingAccountId: 'bet_1', leagueName: '西甲', teams: '旧主队2 vs 旧客队2', market: '旧盘口2', status: 'accepted', amount: 1, betTime: new Date().toISOString(), createdAt: new Date().toISOString() },
      ],
      trackedMatches: [],
      monitorAccounts: [],
      monitorRules: [],
      bettingRules: [],
      oddsSummary: {},
      events: { items: [] },
      changes: { items: [] },
    })),
    createBettingAccount: vi.fn(async (payload) => ({
      id: 'bet_new',
      username: payload.username,
      websiteUrl: payload.websiteUrl,
      betOrder: payload.betOrder,
      hasSecret: true,
      createdAt: '2026-07-09T00:00:04.000Z',
      updatedAt: '2026-07-09T00:00:04.000Z',
    })),
    updateBettingAccount: vi.fn(async (_id, payload) => payload),
    deleteBettingAccount: vi.fn(async () => ({ ok: true })),
    checkBettingAccountAccess: vi.fn(async (id) => ({
      item: {
        id, username: 'first-user', websiteUrl: 'https://example.test', betOrder: 1,
        status: 'enabled', archived: false, perBetLimit: '100.00', currency: 'CNY', amountScale: 2,
        stakeStep: '0.50', balance: null, balanceUpdatedAt: null, executionStatus: 'idle',
        accessStatus: 'available', accessCheckedAt: '2026-07-11T08:00:00.000Z', accessErrorCode: '',
        reportedBalance: '1950', reportedCurrency: 'CNY', reportedBalanceUpdatedAt: '2026-07-11T08:00:00.000Z',
        acceptedTodayCount: 1, acceptedTodayAmount: '50.00', hasSecret: true,
      },
      result: { ok: true, status: 'available', errorCode: '', reportedBalance: '1950', reportedCurrency: 'CNY', balanceSource: 'account-summary' },
    })),
    pauseBettingAccount: vi.fn(async (id) => ({ item: { id, username: 'first-user', allocationStatus: 'pause_pending' } })),
    enableBettingAccount: vi.fn(async (id) => ({ item: { id, username: 'unset-user', allocationStatus: 'enabled' }, result: { ok: true } })),
    getBetBatches: vi.fn(async () => ({ items: [{
      batchId: 'batch-1', signalId: 'signal-1', ruleId: 'rule-1', eventKey: '', lockedSelectionIdentity: '',
      ruleVersion: 1, sourceLeague: '英超', sourceOdds: '0.91', currency: 'CNY', amountScale: 2,
      targetAmount: '100.00', reservedAmount: '0.00', acceptedAmount: '50.00', unknownAmount: '0.00',
      unfilledAmount: '50.00', status: 'partial', finishReason: '', createdAt: '2026-07-11T02:00:00.000Z', finishedAt: '',
    }] })),
    getBetBatchChildren: vi.fn(async () => ({ items: [
      {
        childOrderId: 'child-1', batchId: 'batch-1', accountId: 'bet_1', attempt: 1,
        currency: 'CNY', amountScale: 2, requestedAmount: '50.00', previewMinStake: '1.00',
        previewMaxStake: '100.00', previewBalance: '200.00', previewStakeStep: '0.50', previewOdds: '0.88',
        providerReference: '[masked]', submitAttemptId: 'attempt-1', status: 'accepted', errorCode: '', errorMessage: '',
        createdAt: new Date().toISOString(), submitPreparedAt: '', submitDispatchedAt: '', submittedAt: '', resolvedAt: new Date().toISOString(),
      },
      {
        childOrderId: 'child-old', batchId: 'batch-1', accountId: 'bet_1', attempt: 2,
        currency: 'CNY', amountScale: 2, requestedAmount: '20.00', previewMinStake: '1.00',
        previewMaxStake: '100.00', previewBalance: '150.00', previewStakeStep: '0.50', previewOdds: '0.87',
        providerReference: null, submitAttemptId: 'attempt-old', status: 'accepted', errorCode: '', errorMessage: '',
        createdAt: '2020-01-01T00:00:00.000Z', submitPreparedAt: '', submitDispatchedAt: '', submittedAt: '', resolvedAt: '2020-01-01T00:00:00.000Z',
      },
      {
        childOrderId: 'child-rejected', batchId: 'batch-1', accountId: 'bet_1', attempt: 3,
        currency: 'CNY', amountScale: 2, requestedAmount: '30.00', previewMinStake: '2.00',
        previewMaxStake: '80.00', previewBalance: '180.00', previewStakeStep: '1.00', previewOdds: '0.86',
        providerReference: null, submitAttemptId: '', status: 'rejected', errorCode: 'E_LIMIT', errorMessage: '超出范围',
        createdAt: new Date().toISOString(), submitPreparedAt: '', submitDispatchedAt: '', submittedAt: '', resolvedAt: new Date().toISOString(),
      },
    ] })),
  },
}))

describe('BettingAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('does not report an empty account list while bootstrap is still loading', async () => {
    let release!: (value: Awaited<ReturnType<typeof api.getBettingAccountOverview>>) => void
    const delayed = new Promise<Awaited<ReturnType<typeof api.getBettingAccountOverview>>>((resolve) => { release = resolve })
    vi.mocked(api.getBettingAccountOverview).mockReturnValueOnce(delayed)

    render(<BettingAccounts />)

    expect(screen.getByText('正在读取投注账号…')).toBeInTheDocument()
    expect(screen.queryByText('暂无投注账号')).not.toBeInTheDocument()
    release(await api.getBettingAccountOverview())
    expect(await screen.findByText('first-user')).toBeInTheDocument()
  })

  test('shows betting accounts in manual order and displays order labels', async () => {
    render(<BettingAccounts />)

    const first = await screen.findByText('first-user')
    const second = screen.getByText('second-user')
    const unset = screen.getByText('unset-user')

    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(second.compareDocumentPosition(unset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByLabelText('账号卡片 first-user')).toHaveTextContent('投注顺序：1')
    expect(screen.getByLabelText('账号卡片 second-user')).toHaveTextContent('投注顺序：2')
    expect(screen.getByLabelText('账号卡片 unset-user')).toHaveTextContent('投注顺序：未设置')
  })

  test('saves manual betting order when creating an account', async () => {
    render(<BettingAccounts />)

    const createButton = (await screen.findByText('新增投注账号')).closest('button')
    expect(createButton).not.toBeNull()
    fireEvent.click(createButton!)
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'new-user' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('网址'), { target: { value: 'https://example.test' } })
    fireEvent.change(screen.getByLabelText('投注顺序'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('单笔上限（CNY 整数）'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(api.createBettingAccount).toHaveBeenCalled())
    expect(api.createBettingAccount).toHaveBeenCalledWith(expect.objectContaining({
      username: 'new-user',
      websiteUrl: 'https://example.test',
      betOrder: 4,
      perBetLimit: '100',
      currency: 'CNY',
      status: 'enabled',
    }))
  })

  test('edits an account with an integer CNY per-bet limit', async () => {
    render(<BettingAccounts />)

    await screen.findByText('first-user')
    fireEvent.click(screen.getAllByRole('button', { name: 'edit 编辑' })[0])
    fireEvent.change(screen.getByLabelText('单笔上限（CNY 整数）'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(api.updateBettingAccount).toHaveBeenCalled())
    expect(api.updateBettingAccount).toHaveBeenCalledWith('bet_1', expect.objectContaining({
      perBetLimit: '50',
      currency: 'CNY',
    }))
  })

  test('shows account limits and expands masked child-order details', async () => {
    render(<BettingAccounts />)

    const firstCard = await screen.findByLabelText('账号卡片 first-user')
    await waitFor(() => expect(api.getBetBatchChildren).toHaveBeenCalledWith('batch-1'))
    expect(firstCard).toHaveTextContent('单笔上限：100.00 CNY')
    expect(firstCard).toHaveTextContent('分配状态：已启用')
    expect(firstCard).toHaveTextContent('执行锁：空闲')

    fireEvent.click(screen.getByRole('button', { name: '展开账号 first-user' }))
    expect(await screen.findByText('child-1')).toBeInTheDocument()
    expect(screen.getAllByText('50.00 CNY').length).toBeGreaterThan(0)
    expect(screen.getByText('0.88')).toBeInTheDocument()
    expect(screen.getByText('[masked]')).toBeInTheDocument()
    expect(screen.getAllByText('已接受').length).toBeGreaterThan(0)
    expect(screen.getAllByText('最低 1.00 CNY').length).toBeGreaterThan(0)
    expect(screen.getAllByText('最高 100.00 CNY').length).toBeGreaterThan(0)
    expect(screen.getByText('余额 200.00 CNY')).toBeInTheDocument()
    expect(screen.getAllByText('步进 0.50 CNY').length).toBeGreaterThan(0)
    expect(screen.getByText('E_LIMIT / 超出范围')).toBeInTheDocument()
  })

  test('manually checks Crown account access and displays the reported balance without treating it as execution balance', async () => {
    render(<BettingAccounts />)

    const button = await screen.findByRole('button', { name: '检测账号 first-user' })
    fireEvent.click(button)

    await waitFor(() => expect((api as any).checkBettingAccountAccess).toHaveBeenCalledWith('bet_1'))
    const card = screen.getByLabelText('账号卡片 first-user')
    expect(card).toHaveTextContent('登录访问：可用')
    expect(card).toHaveTextContent('Crown 返回余额：1950 CNY')
    expect(card).toHaveTextContent('执行锁：空闲')
    expect(api.enableBettingAccount).not.toHaveBeenCalled()
  })

  test('uses accepted child-order ledger instead of legacy history for daily statistics', async () => {
    render(<BettingAccounts />)

    const firstCard = await screen.findByLabelText('账号卡片 first-user')
    await waitFor(() => expect(api.getBetBatchChildren).toHaveBeenCalledWith('batch-1'))
    expect(firstCard).toHaveTextContent('今日 accepted 次数1 次')
    expect(firstCard).toHaveTextContent('今日 accepted 金额50.00 CNY')
    expect(firstCard).not.toHaveTextContent('1000.00 CNY')
  })

  test('uses backend full-ledger statistics instead of the recent child batch window', async () => {
    const payload = await api.getBettingAccountOverview()
    vi.mocked(api.getBettingAccountOverview).mockResolvedValueOnce({
      ...payload,
      bettingAccounts: payload.bettingAccounts.map((account) => account.id === 'bet_1'
        ? { ...account, acceptedTodayCount: 59, acceptedTodayAmount: '180143985094860.00' }
        : account),
    })

    render(<BettingAccounts />)

    const username = await screen.findByText('first-user')
    const card = username.closest('[role="button"]')
    expect(card).not.toBeNull()
    expect(card).toHaveTextContent('59')
    expect(card).toHaveTextContent('180143985094860.00 CNY')
  })

  test('shows unavailable statistics as unknown instead of fake zero', async () => {
    const payload = await api.getBettingAccountOverview()
    vi.mocked(api.getBettingAccountOverview).mockResolvedValueOnce({
      ...payload,
      bettingAccounts: payload.bettingAccounts.map((account) => account.id === 'bet_1'
        ? { ...account, acceptedTodayCount: undefined, acceptedTodayAmount: undefined } as any
        : account),
    })

    render(<BettingAccounts />)

    const username = await screen.findByText('first-user')
    const metrics = username.closest('[role="button"]')?.querySelector('.config-card-metrics')
    expect(metrics).not.toBeNull()
    expect(metrics).toHaveTextContent('今日 accepted 次数-')
    expect(metrics).toHaveTextContent('今日 accepted 金额-')
    expect(metrics).not.toHaveTextContent('0 次')
    expect(metrics).not.toHaveTextContent('0.00 CNY')
  })

  test('does not turn child-ledger loading errors into zero account statistics', async () => {
    vi.mocked(api.getBetBatchChildren).mockRejectedValueOnce(new Error('child ledger unavailable'))

    render(<BettingAccounts />)

    const username = await screen.findByText('first-user')
    const card = username.closest('[role="button"]')
    await waitFor(() => expect(api.getBetBatchChildren).toHaveBeenCalledWith('batch-1'))
    expect(card).not.toBeNull()
    expect(card).toHaveTextContent('1')
    expect(card).toHaveTextContent('50.00 CNY')
  })

  test('shows one Chinese allocation action per account, disables repeats, and removes precision and step configuration', async () => {
    const payload = await api.getBettingAccountOverview()
    vi.mocked(api.getBettingAccountOverview).mockResolvedValueOnce({
      ...payload,
      bettingAccounts: payload.bettingAccounts.map((account) => ({
        ...account,
        allocationStatus: account.id === 'bet_unset' ? 'paused' : account.id === 'bet_2' ? 'pause_pending' : 'enabled',
      })),
    })
    let release!: () => void
    const firstAccount = payload.bettingAccounts.find((account) => account.id === 'bet_1')!
    vi.mocked((api as any).pauseBettingAccount).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ item: { ...firstAccount, allocationStatus: 'pause_pending' } }) }))

    render(<BettingAccounts />)

    const firstCard = await screen.findByLabelText('账号卡片 first-user')
    expect(screen.getByText('启用账号只会加入订单分配，不会开启全局真实投注。')).toBeInTheDocument()
    expect(firstCard).toHaveTextContent('分配状态：已启用')
    expect(firstCard).toHaveTextContent('暂停账号')
    expect(screen.getAllByRole('button', { name: /暂停账号 first-user|启用账号 first-user/ })).toHaveLength(1)
    expect(screen.getByLabelText('账号卡片 second-user')).toHaveTextContent('暂停中')
    expect(screen.getByRole('button', { name: '启用账号 unset-user' })).toBeEnabled()
    expect(screen.getByLabelText('账号卡片 unset-user')).toHaveTextContent('启用账号')
    expect(screen.queryByLabelText('金额精度')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('投注步进')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('投注步进')

    const pause = screen.getByRole('button', { name: '暂停账号 first-user' })
    fireEvent.click(pause)
    expect(pause).toBeDisabled()
    fireEvent.click(pause)
    expect((api as any).pauseBettingAccount).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(firstCard).toHaveTextContent('暂停中'))
  })

  test('explains that a zero legacy limit must be edited before enabling', async () => {
    const payload = await api.getBettingAccountOverview()
    vi.mocked(api.getBettingAccountOverview).mockResolvedValueOnce({
      ...payload,
      bettingAccounts: payload.bettingAccounts.map((account) => account.id === 'bet_unset'
        ? { ...account, allocationStatus: 'paused', perBetLimit: '0' }
        : account),
    })

    render(<BettingAccounts />)

    const button = await screen.findByRole('button', { name: '先设置单笔上限 unset-user' })
    expect(button).toBeDisabled()
    expect(screen.getByLabelText('账号卡片 unset-user')).toHaveTextContent('单笔上限必须大于 0，编辑后才能启用')
  })

})
