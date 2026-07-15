import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import App from './App'
import { api } from './services/api'

vi.mock('./services/api', () => ({
  APP_CONTRACT_VERSION: 'dynamic-betting-cards-v1',
  CONTRACT_COMPATIBILITY_EVENT: 'crown:contract-compatibility-changed',
  isContractCompatible: vi.fn(() => true),
  DASHBOARD_AUTH_EXPIRED_EVENT: 'crown:dashboard-auth-expired',
  DASHBOARD_AUTH_REQUIRED_MESSAGE: '请先登录 Dashboard 后再操作。',
  isDashboardAuthenticationError: (error: unknown) => error instanceof Error && error.message === 'authentication-required',
  api: {
    bootstrap: vi.fn(async () => ({
      trackedMatches: [],
      monitorAccounts: [],
      monitorRules: [],
      bettingRules: [],
      bettingAccounts: [],
      bettingHistory: [],
      defaultLeagues: {
        stats: { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 },
        items: [],
        config: { version: 1, leagues: [] },
      },
      monitorSettings: {
        version: 2,
        prematch: {},
        live: {},
      },
      oddsSummary: {
        readonly: true,
        source: 'test',
        dataOrigin: { kind: 'fixture-fallback', isRuntime: false, runtime: { exists: true, empty: true, lineCount: 0, updatedAt: null }, fallback: { exists: true, lineCount: 1, updatedAt: null } },
        dataSource: { kind: 'fixture-replay', label: 'fixture replay', lastXmlAt: null, xmlResponses: 0, getGameListCount: 0, getGameMoreCount: 0, xmlEvents: 0, normalizedRecords: 0, snapshotWrites: 0, changeWrites: 0, parseErrors: 0, emptyXmlResponses: 0, loginExpiredResponses: 0, lastSnapshotAt: null, eventCount: 0, recordCount: 0, changeCount: 0, oddsIdAvailable: false, oddsIdStatus: 'null-not-available', bettingExecution: 'not-connected' },
        totals: { events: 0, leagues: 0, snapshots: 0, changes: 0 },
        lastCapturedAt: null,
      },
      events: { items: [] },
      changes: { items: [] },
    })),
    getBettingAccountOverview: vi.fn(async () => ({ bettingAccounts: [], bettingHistory: [] })),
    getOperationsSummary: vi.fn(async () => { throw new Error('operations-unavailable-in-app-contract-test') }),
    openBettingManualLogin: vi.fn(),
    getBettingManualLoginStatus: vi.fn(),
    confirmBettingManualLogin: vi.fn(),
    cancelBettingManualLogin: vi.fn(),
    login: vi.fn(async () => ({ authenticated: true })),
    sessionBootstrap: vi.fn(async () => ({ csrfToken: undefined, appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })),
    getLeagueSummaries: vi.fn(async () => ({
      items: [],
      defaultLeagues: { stats: { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 }, items: [], config: { version: 1, leagues: [] } },
      oddsSummary: {
        readonly: true,
        source: 'fixture-replay',
        dataOrigin: { kind: 'fixture-fallback', isRuntime: false, runtime: { exists: true, empty: true, lineCount: 0, updatedAt: null }, fallback: { exists: true, lineCount: 1, updatedAt: null } },
        dataSource: { kind: 'fixture-replay', label: 'fixture replay', lastXmlAt: null, xmlResponses: 0, getGameListCount: 0, getGameMoreCount: 0, xmlEvents: 0, normalizedRecords: 0, snapshotWrites: 0, changeWrites: 0, parseErrors: 0, emptyXmlResponses: 0, loginExpiredResponses: 0, lastSnapshotAt: null, eventCount: 0, recordCount: 0, changeCount: 0, oddsIdAvailable: false, oddsIdStatus: 'null-not-available', bettingExecution: 'not-connected' },
        totals: { events: 0, leagues: 0, snapshots: 0, changes: 0 },
        lastCapturedAt: null,
      },
    })),
    getLeagueOptions: vi.fn(async () => ({ items: [] })),
    changes: vi.fn(async () => ({ items: [] })),
    getBetBatches: vi.fn(async () => ({ items: [] })),
    getBetTargetHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    getBetBatchChildren: vi.fn(async () => ({ items: [] })),
    getDefaultLeagues: vi.fn(async () => ({ stats: { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 }, items: [], config: { version: 1, leagues: [] } })),
    updateDefaultLeagues: vi.fn(async () => ({ stats: { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 }, items: [], config: { version: 1, leagues: [] } })),
    getMonitorAccount: vi.fn(async () => ({
      item: {
        id: 'mon_primary',
        label: '',
        username: '',
        loginUrl: '',
        enabled: false,
        status: 'disabled',
        hasSecret: true,
        notes: '',
        loginStatus: '未启动',
        currentMonitorStatus: '未启动',
        lastLoginAt: null,
        lastOnlineCheckAt: null,
        lastXmlResponseAt: null,
        lastOddsParsedAt: null,
        consecutiveFailures: 0,
        oddsScanIntervalSeconds: 10,
        autoReloginCount: 0,
        maxAutoReloginCount: 3,
        lastLoginResult: {
          ok: true,
          accountId: 'mon_primary',
          status: '已登录',
          loginMethod: 'cookies',
          cookieStatus: '已加载',
          storageStateStatus: '已加载',
          xmlVerified: true,
          sessionVerified: true,
          diagnosticPath: 'data/runtime/login-diagnostics/20260709-000000-mon_primary',
          debugSnapshot: null,
          startedAt: '2026-07-09T00:00:00.000Z',
          finishedAt: '2026-07-09T00:00:02.000Z',
          message: '',
        },
        lastLoginResultAt: '2026-07-09T00:00:02.000Z',
        lastLoginDiagnosticsPath: 'data/runtime/login-diagnostics/20260709-000000-mon_primary',
        updatedAt: '',
      },
    })),
    saveMonitorAccount: vi.fn(async (payload) => ({ item: { ...payload, id: 'mon_primary', hasSecret: Boolean(payload.secret), updatedAt: '' } })),
    monitorAccountAction: vi.fn(async () => {
      const loginResult = {
        ok: true,
        accountId: 'mon_primary',
        status: '已登录',
        loginMethod: 'cookies',
        cookieStatus: '已加载',
        storageStateStatus: '已加载',
        xmlVerified: true,
        sessionVerified: true,
        diagnosticPath: 'data/runtime/login-diagnostics/20260709-000000-mon_primary',
        debugSnapshot: null,
        startedAt: '2026-07-09T00:00:00.000Z',
        finishedAt: '2026-07-09T00:00:02.000Z',
        message: '',
      }
      return {
        item: {
        id: 'mon_primary',
        label: '',
        username: '',
        loginUrl: '',
        enabled: false,
        status: 'disabled',
        hasSecret: false,
        notes: '',
        loginStatus: '未启动',
        currentMonitorStatus: '未启动',
        lastLoginAt: null,
        lastOnlineCheckAt: null,
        lastXmlResponseAt: null,
        lastOddsParsedAt: null,
        consecutiveFailures: 0,
        oddsScanIntervalSeconds: 10,
        autoReloginCount: 0,
        maxAutoReloginCount: 3,
        lastLoginResult: loginResult,
        lastLoginResultAt: '2026-07-09T00:00:02.000Z',
        lastLoginDiagnosticsPath: 'data/runtime/login-diagnostics/20260709-000000-mon_primary',
        updatedAt: '',
      },
        loginResult,
      }
    }),
    getLoginDiagnostics: vi.fn(async () => ({
      item: {
        title: 'Welcome',
        inputs: [{ name: 'username', value: 'monitor-user' }],
        cookies: [{ name: 'uid', value: 'cookie-uid' }],
        account: { username: 'monitor-user', password: 'monitor-password' },
      },
    })),
    trackLeague: vi.fn(async () => ({ ok: true })),
    untrackLeague: vi.fn(async () => ({ ok: true })),
    getMonitorSettings: vi.fn(async () => ({
      settings: { version: 2, prematch: {}, live: {} },
      cards: {
        prematch: { status: 'closed', effectiveLeagueCount: 0, trackedEventCount: 0, trackedSelectionCount: 0 },
        live: { status: 'closed', effectiveLeagueCount: 0, trackedEventCount: 0, trackedSelectionCount: 0 },
      },
    })),
    updateMonitorSettings: vi.fn(async (payload) => ({ settings: payload, cards: {} })),
    startMonitor: vi.fn(async () => ({ settings: {}, cards: {} })),
    stopMonitor: vi.fn(async () => ({ settings: {}, cards: {} })),
    getMonitorAlertSettings: vi.fn(async () => ({ items: {
      prematch: { mode: 'prematch', enabled: false, asianHandicapEnabled: true, totalEnabled: true, monitorOddsMin: null, monitorOddsMax: null, waterMoveThreshold: .03, cooldownSeconds: 60, startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5, remark: '', migrationReviewRequired: false, migrationReviewReason: '', version: 1, createdAt: '', updatedAt: '' },
      live: { mode: 'live', enabled: false, asianHandicapEnabled: true, totalEnabled: true, monitorOddsMin: null, monitorOddsMax: null, waterMoveThreshold: .03, cooldownSeconds: 60, liveMinuteFrom: 0, liveMinuteTo: 90, includeFirstHalf: true, includeHalfTime: true, includeSecondHalf: true, remark: '', migrationReviewRequired: false, migrationReviewReason: '', version: 1, createdAt: '', updatedAt: '' },
    }, summary: { enabledCount: 0, enabledModes: [], migrationReviewRequiredCount: 0 } })),
    updateMonitorAlertSetting: vi.fn(),
    getAutoBettingSettings: vi.fn(async () => ({ items: {
      prematch: { mode: 'prematch', enabled: false, targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100, currency: 'CNY', amountScale: 0, remark: '', realEligible: false, realEligibilityVersion: 1, realEligibilityUpdatedAt: null, migrationReviewRequired: false, migrationReviewReason: '', version: 1, createdAt: '', updatedAt: '' },
      live: { mode: 'live', enabled: false, targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100, currency: 'CNY', amountScale: 0, remark: '', realEligible: false, realEligibilityVersion: 1, realEligibilityUpdatedAt: null, migrationReviewRequired: false, migrationReviewReason: '', version: 1, createdAt: '', updatedAt: '' },
    }, summary: { enabledCount: 0, enabledModes: [], realEligibleCount: 0, migrationReviewRequiredCount: 0 } })),
    updateAutoBettingSetting: vi.fn(),
    getAutoBettingRuleCards: vi.fn(async () => ({ items: [{
      cardId: 'card-contract', name: '英超主规则', enabled: true, leagueNames: ['英超'],
      targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100,
      currency: 'CNY', amountScale: 0, remark: '', realEligible: false,
      realEligibilityVersion: 1, migrationReviewRequired: false, migrationReviewReason: '',
      version: 1, createdAt: '', updatedAt: '',
    }] })),
    getTodayBettingLeagues: vi.fn(async () => ({ items: [] })),
    createAutoBettingRuleCard: vi.fn(),
    updateAutoBettingRuleCard: vi.fn(),
    deleteAutoBettingRuleCard: vi.fn(),
    getRealBettingStatus: vi.fn(async () => ({ item: { requested: false, state: 'off', reasonCode: '', updatedAt: '', preflight: [], blockingReasons: [] } })),
    startRealBetting: vi.fn(),
    stopRealBetting: vi.fn(),
    getTelegramSettings: vi.fn(async () => ({
      oddsAlert: { enabled: false, botName: '赔率波动报警机器人', botTokenMasked: '', hasBotToken: false, chatId: '', chatIds: [], parseMode: 'HTML', testMessage: '' },
      betSuccess: { enabled: false, botName: '投注成功通知机器人', botTokenMasked: '', hasBotToken: false, chatId: '', chatIds: [], parseMode: 'HTML', testMessage: '' },
    })),
    updateTelegramSettings: vi.fn(async (payload) => payload),
    testTelegram: vi.fn(async () => ({ sent: false, reason: 'disabled' })),
    getTelegramChatIds: vi.fn(async () => ({ chatIds: [] })),
  },
}))

describe('Crown React app contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
  })

  test('renders the Blackcat-style shell with five required nav pages', async () => {
    render(<App />)

    expect(await screen.findByText('皇冠抓水投注')).toBeInTheDocument()
    expect(screen.getAllByText('比赛选择').length).toBeGreaterThan(0)
    expect(screen.getByText('监控报警')).toBeInTheDocument()
    expect(screen.getByText('投注规则')).toBeInTheDocument()
    expect(screen.getByText('投注账号配置')).toBeInTheDocument()
    expect(screen.getByText('投注历史')).toBeInTheDocument()
    expect(screen.getByText('设置')).toBeInTheDocument()
  })

  test('routes the betting history navigation to the real-batch ledger page', async () => {
    window.history.pushState({}, '', '/betting-history')
    render(<App />)
    expect(await screen.findByRole('heading', { name: '投注历史' })).toBeInTheDocument()
    expect(screen.getByText('暂无真实投注历史')).toBeInTheDocument()
    expect(api.getBetTargetHistory).toHaveBeenCalledWith({ limit: 20, cursor: undefined, status: 'all', mode: 'all' })
  })

  test('removes system update navigation and redirects the retired route', async () => {
    render(<App />)
    expect(await screen.findByText('皇冠抓水投注')).toBeInTheDocument()
    expect(screen.queryByText('系统更新')).not.toBeInTheDocument()

    window.history.pushState({}, '', '/system-update')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await waitFor(() => expect(window.location.pathname).toBe('/matches'))
    expect(screen.queryByText('只在此页面手动检查和安装经过签名验证的 Windows 版本。')).not.toBeInTheDocument()
  })

  test('offers an in-memory Dashboard login and refreshes authenticated bootstrap', async () => {
    const anonymous = await vi.mocked(api.bootstrap)()
    vi.mocked(api.sessionBootstrap)
      .mockResolvedValueOnce(anonymous)
      .mockResolvedValueOnce({ ...anonymous, csrfToken: 'csrf-after-login' })
    const localSet = vi.spyOn(Storage.prototype, 'setItem')

    render(<App />)
    expect(await screen.findByText('Dashboard 未登录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard 登录' }))
    fireEvent.change(screen.getByLabelText('Dashboard 密码'), { target: { value: 'one-use-password' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登录' }))

    await waitFor(() => expect(api.login).toHaveBeenCalledWith('one-use-password'))
    expect(await screen.findByText('Dashboard 已登录')).toBeInTheDocument()
    expect(api.sessionBootstrap).toHaveBeenCalledTimes(2)
    expect(localSet).not.toHaveBeenCalled()
  })

  test('shows passwordless local access without offering a login button', async () => {
    const anonymous = await vi.mocked(api.bootstrap)()
    vi.mocked(api.sessionBootstrap).mockResolvedValueOnce({
      ...anonymous,
      csrfToken: 'local-csrf-token',
      dashboardAccessMode: 'local-trust',
    })

    render(<App />)

    expect(await screen.findByText('Dashboard 本机免密')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dashboard 登录' })).not.toBeInTheDocument()
  })

  test('shows Dashboard logged out immediately when an API 401 expires the in-memory session', async () => {
    const authenticated = await vi.mocked(api.bootstrap)()
    vi.mocked(api.sessionBootstrap).mockResolvedValueOnce({ ...authenticated, csrfToken: 'csrf-active' })

    render(<App />)
    expect(await screen.findByText('Dashboard 已登录')).toBeInTheDocument()
    const bootstrapCalls = vi.mocked(api.sessionBootstrap).mock.calls.length

    act(() => window.dispatchEvent(new Event('crown:dashboard-auth-expired')))

    expect(screen.getByText('Dashboard 未登录')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Dashboard 登录' })).toBeInTheDocument()
    expect(api.sessionBootstrap).toHaveBeenCalledTimes(bootstrapCalls)
  })

  test.each([
    ['/matches', '上方是今日正在追踪的比赛，下方是今日全部比赛。'],
    ['/monitor-alerts', '赛前与滚球报警分别保存，可同时启用。'],
    ['/betting-rules', '报警命中后，按所选联赛独立创建同盘口线对面盘投注任务'],
    ['/betting-accounts', '暂无投注账号'],
    ['/settings', 'Telegram 机器人配置独立保存，不混入投注账号。'],
  ])('renders page content for %s', async (path, text) => {
    window.history.pushState({}, '', path)
    render(<App />)

    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  test('matches page marks fixture fallback as non-runtime data', async () => {
    window.history.pushState({}, '', '/matches')
    render(<App />)

    expect(await screen.findByText('离线样本')).toBeInTheDocument()
    expect(screen.queryByText(/source=/)).not.toBeInTheDocument()
    expect(screen.queryByText(/oddsId=null/)).not.toBeInTheDocument()
    expect(screen.queryByText(/disabled-preview-only/)).not.toBeInTheDocument()
    expect(screen.queryByText(/not-connected/)).not.toBeInTheDocument()
  })

  test.each([
    ['/monitor-settings', '/monitor-alerts', '监控报警'],
    ['/auto-bet-rules', '/betting-rules', '投注规则'],
  ])('redirects legacy route %s to %s with replace semantics', async (from, target, heading) => {
    window.history.pushState({}, '', from)
    render(<App />)
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(window.location.pathname).toBe(target)
  })

  test('betting accounts page counts accepted bets and shows history status', async () => {
    const today = new Date()
    today.setHours(10, 15, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    vi.mocked(api.getBetBatches).mockResolvedValueOnce({ items: [{
      batchId: 'batch_today', signalId: 'signal_today', ruleId: 'rule_today', eventKey: 'event_today',
      lockedSelectionIdentity: 'selection_today', ruleVersion: 1, sourceLeague: '英超', sourceOdds: '0.88',
      currency: 'CNY', amountScale: 2, targetAmount: '50.00', reservedAmount: '0.00', acceptedAmount: '50.00',
      unknownAmount: '0.00', unfilledAmount: '0.00', status: 'completed', finishReason: 'target_filled',
      createdAt: today.toISOString(), finishedAt: today.toISOString(),
    }] } as any)
    vi.mocked(api.getBetBatchChildren).mockResolvedValueOnce({ items: [{
      childOrderId: 'child_today', batchId: 'batch_today', accountId: 'bet_1', attempt: 1,
      currency: 'CNY', amountScale: 2, requestedAmount: '50.00', previewMinStake: '1.00',
      previewMaxStake: '50.00', previewBalance: '100.00', previewStakeStep: '1.00', previewOdds: '0.88',
      providerReference: '[masked]', submitAttemptId: 'submit_today', status: 'accepted', errorCode: '', errorMessage: '',
      createdAt: today.toISOString(), submitPreparedAt: '', submitDispatchedAt: '', submittedAt: today.toISOString(), resolvedAt: today.toISOString(),
    }] } as any)
    vi.mocked(api.getBettingAccountOverview).mockResolvedValueOnce({
      bettingRules: [],
      bettingAccounts: [{
        id: 'bet_1',
        label: 'bet-user',
        username: 'bet-user',
        websiteUrl: 'https://bet.example.test',
        archived: false,
        betOrder: 1,
        status: 'enabled',
        perBetLimit: '100.00',
        currency: 'CNY',
        amountScale: 2,
        stakeStep: '1.00',
        balance: '500.00',
        balanceUpdatedAt: today.toISOString(),
        executionStatus: 'idle',
        acceptedTodayCount: 1,
        acceptedTodayAmount: '50.00',
        hasSecret: true,
        createdAt: today.toISOString(),
        updatedAt: today.toISOString(),
      }],
      bettingHistory: [
        {
          id: 'bhist_today',
          accountId: 'bet_1',
          bettingAccountId: 'bet_1',
          leagueName: '英超',
          teams: '主队 vs 客队',
          market: '让球 0',
          status: 'accepted',
          amount: 50,
          betTime: today.toISOString(),
          createdAt: today.toISOString(),
        },
        {
          id: 'bhist_rejected',
          accountId: 'bet_1',
          bettingAccountId: 'bet_1',
          leagueName: '世界杯2026(美加墨)',
          teams: '法国 vs 摩洛哥',
          market: 'total 2.5',
          status: 'preview-rejected',
          amount: 70,
          betTime: today.toISOString(),
          createdAt: today.toISOString(),
          details: {
            result: {
              preview: {
                code: '555',
                errorMessage: '1X001',
                fastCheck: 'ROUC',
              },
            },
          },
        },
        {
          id: 'bhist_old',
          accountId: 'bet_1',
          bettingAccountId: 'bet_1',
          leagueName: '西甲',
          teams: '旧主队 vs 旧客队',
          market: '大小球',
          status: 'accepted',
          amount: 80,
          betTime: yesterday.toISOString(),
          createdAt: yesterday.toISOString(),
        },
      ],
      trackedMatches: [],
      monitorAccounts: [],
      monitorRules: [],
      oddsSummary: { totals: { events: 0, leagues: 0, snapshots: 0, changes: 0 } },
      events: { items: [] },
      changes: { items: [] },
    } as any)
    window.history.pushState({}, '', '/betting-accounts')
    render(<App />)

    expect(await screen.findByText('bet-user')).toBeInTheDocument()
    expect(screen.getByText('https://bet.example.test')).toBeInTheDocument()
    expect(screen.getByText('1 次')).toBeInTheDocument()
    expect(screen.getByText('50.00 CNY')).toBeInTheDocument()
    expect(screen.queryByText(/bet-password/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /展开账号 bet-user/ }))

    expect(await screen.findByText('英超')).toBeInTheDocument()
    expect(screen.getByText('主队 vs 客队')).toBeInTheDocument()
    expect(screen.getByText('让球 0')).toBeInTheDocument()
    expect(screen.getAllByText('已确认').length).toBeGreaterThan(0)
    expect(screen.getByText('预览失败 code=555 / 1X001')).toBeInTheDocument()
  })

  test('monitor account page displays login result and loads diagnostics on demand', async () => {
    window.history.pushState({}, '', '/monitor-account')
    render(<App />)

    expect(await screen.findByText('登录结果：已登录')).toBeInTheDocument()
    expect(screen.getByText('登录方式：cookies')).toBeInTheDocument()
    expect(screen.getByText('XML 验证：成功')).toBeInTheDocument()
    expect(screen.queryByText(/monitor-password/)).not.toBeInTheDocument()

    screen.getByRole('button', { name: '查看诊断' }).click()

    expect(await screen.findByText(/monitor-password/)).toBeInTheDocument()
    expect(screen.getByText(/cookie-uid/)).toBeInTheDocument()
  })

  test('monitor account page refreshes runtime status after watcher starts', async () => {
    const pollRef: { current?: () => void } = {}
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5000 && typeof handler === 'function') pollRef.current = handler as () => void
      return 1
    })
    const clearSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const openingAccount = {
      id: 'mon_primary',
      label: '',
      username: 'monitor-user',
      loginUrl: 'https://m407.mos077.com',
      enabled: true,
      status: 'enabled',
      hasSecret: true,
      notes: '',
      loginStatus: '已登录',
      currentMonitorStatus: '打开网站中',
      lastLoginAt: '2026-07-09T09:05:50.000Z',
      lastOnlineCheckAt: null,
      lastXmlResponseAt: null,
      lastOddsParsedAt: null,
      consecutiveFailures: 0,
      oddsScanIntervalSeconds: 30,
      autoReloginCount: 0,
      maxAutoReloginCount: 3,
      lastLoginResult: null,
      lastLoginResultAt: null,
      lastLoginDiagnosticsPath: null,
      updatedAt: '2026-07-09T09:05:51.000Z',
    }
    vi.mocked(api.getMonitorAccount)
      .mockResolvedValueOnce({ item: openingAccount } as any)
      .mockResolvedValueOnce({
        item: {
          ...openingAccount,
          currentMonitorStatus: '正在监控赔率',
          lastOnlineCheckAt: '2026-07-09T09:05:58.000Z',
          lastXmlResponseAt: '2026-07-09T09:05:58.000Z',
          lastOddsParsedAt: '2026-07-09T09:05:58.000Z',
          updatedAt: '2026-07-09T09:05:58.000Z',
        },
      } as any)

    window.history.pushState({}, '', '/monitor-account')
    render(<App />)

    try {
      expect(await screen.findByText('当前监控状态：打开网站中')).toBeInTheDocument()
      expect(intervalSpy).toHaveBeenCalled()
      const runPoll = pollRef.current
      expect(runPoll).toBeTypeOf('function')
      if (!runPoll) throw new Error('monitor status poll was not registered')

      runPoll()

      await waitFor(() => expect(screen.getByText('当前监控状态：正在监控赔率')).toBeInTheDocument())
      expect(screen.getAllByText('2026-07-09T09:05:58.000Z').length).toBeGreaterThan(0)
    } finally {
      intervalSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  test('monitor account page shows saved password state instead of an empty password input', async () => {
    window.history.pushState({}, '', '/monitor-account')
    render(<App />)

    expect(await screen.findByDisplayValue('已保存')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('已保存，留空不修改')).not.toBeInTheDocument()
  })

  test.each([
    ['/default-leagues', '默认联赛'],
    ['/monitor-account', '皇冠监控账号'],
  ])('renders new page content for %s', async (path, text) => {
    window.history.pushState({}, '', path)
    render(<App />)

    expect(await screen.findByRole('heading', { name: text })).toBeInTheDocument()
  })

  test('canonical monitor alerts route exposes both mode cards', async () => {
    window.history.pushState({}, '', '/monitor-alerts')
    render(<App />)
    expect(await screen.findByText('赛前报警')).toBeInTheDocument()
    expect(screen.getByText('滚球报警')).toBeInTheDocument()
  })

  test('settings page masks telegram token fields', async () => {
    window.history.pushState({}, '', '/settings')
    render(<App />)

    expect(await screen.findByText('赔率波动报警机器人')).toBeInTheDocument()
    expect(screen.getByText('投注成功通知机器人')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('未设置').length).toBe(2)
    expect(screen.getAllByPlaceholderText('未设置，获取 Chat ID 后会填入这里').length).toBe(2)
  })
})
