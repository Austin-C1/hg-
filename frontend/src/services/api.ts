import axios from 'axios'
import type { AxiosRequestConfig } from 'axios'

import type {
  AutoBetMode,
  AutoBettingRuleCard,
  AutoBettingSettingsResponse,
  AutoBettingSettingUpdate,
  BettingAccount,
  BettingHistory,
  BetBatch,
  BetChildOrder,
  BettingRule,
  BootstrapPayload,
  DefaultLeagueOverview,
  LeagueSummary,
  LoginDiagnostics,
  LoginResult,
  ManualLoginStatus,
  MonitorAccount,
  MonitorAlertSettingsResponse,
  MonitorAlertSettingUpdate,
  MonitorSettingsPayload,
  MonitorRule,
  OddsChange,
  OddsEvent,
  OddsSummary,
  RealBettingStatus,
  OperationsSummary,
  RuleCardMutation,
  RuleCardUpdate,
  RuntimeCleanupPreview,
  SystemUpdateCancelResult,
  SystemUpdateStatus,
  TelegramSettingsPayload,
  TrackedMatch,
  TodayBettingLeague,
} from '../types'

export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

export const DASHBOARD_AUTH_EXPIRED_EVENT = 'crown:dashboard-auth-expired'
export const DASHBOARD_AUTH_REQUIRED_MESSAGE = '请先登录 Dashboard 后再操作。'
export const APP_CONTRACT_VERSION = __APP_CONTRACT_VERSION__
export const CONTRACT_VERSION_MISMATCH_MESSAGE = 'contract-version-mismatch'
export const CONTRACT_COMPATIBILITY_EVENT = 'crown:contract-compatibility-changed'

export function isDashboardAuthenticationError(error: unknown) {
  return error instanceof Error && error.message === 'authentication-required'
}

let csrfToken: string | null = null
let securityRefresh: Promise<SecurityContext> | null = null
let contractCompatible = false

export function isContractCompatible() { return contractCompatible }

function setContractCompatible(value: boolean) {
  if (contractCompatible === value) return
  contractCompatible = value
  window.dispatchEvent(new Event(CONTRACT_COMPATIBILITY_EVENT))
}

type SecurityContext = Pick<BootstrapPayload, 'csrfToken' | 'dashboardAccessMode' | 'appContractVersion' | 'schemaVersion'>
type RetryableRequest = AxiosRequestConfig & { _csrfRetried?: boolean }

async function loadSecurityContext() {
  const payload = (await apiClient.get<SecurityContext>('/app/security-context')).data
  csrfToken = payload.csrfToken || null
  setContractCompatible(payload.appContractVersion === APP_CONTRACT_VERSION
    && payload.schemaVersion === APP_CONTRACT_VERSION)
  return payload
}

function refreshSecurityContext() {
  if (!securityRefresh) {
    securityRefresh = loadSecurityContext().finally(() => { securityRefresh = null })
  }
  return securityRefresh
}

async function loadBootstrap() {
  const payload = (await apiClient.get<BootstrapPayload>('/app/bootstrap')).data
  csrfToken = payload.csrfToken || null
  setContractCompatible(payload.appContractVersion === APP_CONTRACT_VERSION
    && payload.schemaVersion === APP_CONTRACT_VERSION)
  return payload
}

apiClient.interceptors.request.use((config) => {
  const method = String(config.method || 'get').toLowerCase()
  if (['post', 'put', 'patch', 'delete'].includes(method) && config.url !== '/app/session' && !contractCompatible) {
    return Promise.reject(new Error(CONTRACT_VERSION_MISMATCH_MESSAGE))
  }
  if (csrfToken && ['post', 'put', 'patch', 'delete'].includes(method) && config.url !== '/app/session') {
    config.headers.set('X-CSRF-Token', csrfToken)
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      csrfToken = null
      window.dispatchEvent(new Event(DASHBOARD_AUTH_EXPIRED_EVENT))
    }
    const payload = error.response?.data
    const original = error.config as RetryableRequest | undefined
    const method = String(original?.method || 'get').toLowerCase()
    if (error.response?.status === 403 && payload?.error === 'csrf-invalid' && original
      && ['post', 'put', 'patch', 'delete'].includes(method) && !original._csrfRetried) {
      original._csrfRetried = true
      await refreshSecurityContext()
      return apiClient.request(original)
    }
    const stableUpdateCode = typeof payload?.error === 'string' && /^update-[a-z0-9-]+$/.test(payload.error)
      ? payload.error
      : ''
    const message = stableUpdateCode || (error.response?.status === 409
      ? '配置已被其他页面更新，请刷新后重试'
      : (payload?.error || error.message || 'request-failed'))
    return Promise.reject(Object.assign(new Error(message), { payload, status: error.response?.status }))
  },
)

export const api = {
  async summary() {
    return (await apiClient.get<OddsSummary>('/summary')).data
  },
  async events() {
    return (await apiClient.get<{ items: OddsEvent[] }>('/events')).data
  },
  async changes(params?: { eventKey?: string; limit?: number }) {
    return (await apiClient.get<{ items: OddsChange[] }>('/changes', { params })).data
  },
  async bootstrap() {
    return loadBootstrap()
  },
  async getBettingAccountOverview() {
    const [accounts, history] = await Promise.all([
      apiClient.get<{ items: BettingAccount[] }>('/app/betting-accounts'),
      apiClient.get<{ items: BettingHistory[] }>('/app/betting-history'),
    ])
    return { bettingAccounts: accounts.data.items, bettingHistory: history.data.items }
  },
  async sessionBootstrap() {
    return loadSecurityContext()
  },
  async login(password: string) {
    return (await apiClient.post<{ authenticated: true }>('/app/session', { password })).data
  },
  async getLeagueSummaries() {
    return (await apiClient.get<{ items: LeagueSummary[]; defaultLeagues: DefaultLeagueOverview; oddsSummary: OddsSummary }>('/matches/leagues')).data
  },
  async getLeagueOptions() {
    return (await apiClient.get<{ items: string[] }>('/app/league-options')).data
  },
  async trackLeague(league: string) {
    return (await apiClient.post<{ items: LeagueSummary[]; defaultLeagues: DefaultLeagueOverview }>('/matches/leagues/track', { league })).data
  },
  async untrackLeague(league: string) {
    return (await apiClient.post<{ items: LeagueSummary[]; defaultLeagues: DefaultLeagueOverview }>('/matches/leagues/untrack', { league })).data
  },
  async getDefaultLeagues() {
    return (await apiClient.get<DefaultLeagueOverview>('/default-leagues')).data
  },
  async updateDefaultLeagues(config: DefaultLeagueOverview['config']) {
    return (await apiClient.put<DefaultLeagueOverview>('/default-leagues', { config })).data
  },
  async getMonitorAccount(signal?: AbortSignal) {
    return (await apiClient.get<{ item: MonitorAccount }>('/app/monitor-account', { signal })).data
  },
  async saveMonitorAccount(payload: Partial<MonitorAccount> & { secret?: string }) {
    return (await apiClient.put<{ item: MonitorAccount }>('/app/monitor-account', payload)).data
  },
  async monitorAccountAction(action: 'test-login' | 'start' | 'stop' | 'relogin' | 'clear-state') {
    return (await apiClient.post<{ item: MonitorAccount; loginResult?: LoginResult | null }>('/app/monitor-account/actions', { action })).data
  },
  async getLoginDiagnostics() {
    return (await apiClient.get<LoginDiagnostics>('/app/monitor-account/login-diagnostics')).data
  },
  async openManualLogin(accountId: string, signal?: AbortSignal) {
    return (await apiClient.post<{ item: ManualLoginStatus }>(
      `/app/monitor-accounts/${encodeURIComponent(accountId)}/manual-login/open`,
      {},
      { signal },
    )).data.item
  },
  async getManualLoginStatus(accountId: string, challengeId: string, signal?: AbortSignal) {
    return (await apiClient.get<{ item: ManualLoginStatus }>(
      `/app/monitor-accounts/${encodeURIComponent(accountId)}/manual-login/${encodeURIComponent(challengeId)}`,
      { signal },
    )).data.item
  },
  async confirmManualLogin(accountId: string, challengeId: string, signal?: AbortSignal) {
    return (await apiClient.post<{ item: ManualLoginStatus }>(
      `/app/monitor-accounts/${encodeURIComponent(accountId)}/manual-login/${encodeURIComponent(challengeId)}/confirm`,
      {},
      { signal },
    )).data.item
  },
  async cancelManualLogin(accountId: string, challengeId: string, signal?: AbortSignal) {
    return (await apiClient.post<{ item: ManualLoginStatus }>(
      `/app/monitor-accounts/${encodeURIComponent(accountId)}/manual-login/${encodeURIComponent(challengeId)}/cancel`,
      {},
      { signal },
    )).data.item
  },
  async getMonitorSettings() {
    return (await apiClient.get<MonitorSettingsPayload>('/monitor-settings')).data
  },
  async updateMonitorSettings(settings: MonitorSettingsPayload['settings']) {
    return (await apiClient.put<MonitorSettingsPayload>('/monitor-settings', { settings })).data
  },
  async getMonitorAlertSettings() {
    return (await apiClient.get<MonitorAlertSettingsResponse>('/app/monitor-alert-settings')).data
  },
  async updateMonitorAlertSetting(mode: AutoBetMode, payload: MonitorAlertSettingUpdate) {
    return (await apiClient.put<{ item: MonitorAlertSettingsResponse['items'][AutoBetMode] }>(`/app/monitor-alert-settings/${mode}`, payload)).data.item
  },
  async startMonitor(mode: 'prematch' | 'live') {
    return (await apiClient.post<MonitorSettingsPayload>('/monitor/start', { mode })).data
  },
  async stopMonitor(mode: 'prematch' | 'live') {
    return (await apiClient.post<MonitorSettingsPayload>('/monitor/stop', { mode })).data
  },
  async getTelegramSettings() {
    return (await apiClient.get<TelegramSettingsPayload>('/settings/telegram')).data
  },
  async updateTelegramSettings(payload: Record<string, unknown>) {
    return (await apiClient.put<TelegramSettingsPayload>('/settings/telegram', payload)).data
  },
  async testTelegram(type: 'oddsAlert' | 'betSuccess') {
    return (await apiClient.post<{ sent: boolean; reason?: string; status?: number }>('/settings/telegram/test', { type })).data
  },
  async getTelegramChatIds(payload: { type: 'oddsAlert' | 'betSuccess'; botToken?: string }) {
    return (await apiClient.post<{ chatIds: string[] }>('/settings/telegram/chat-ids', payload)).data
  },
  async trackMatch(payload: {
    eventKey: string
    league: string
    homeTeam: string
    awayTeam: string
    mode: string
    sourceStatus: string
    tracked: boolean
  }) {
    return (await apiClient.post<{ item: TrackedMatch }>('/app/tracked-matches', payload)).data.item
  },
  async createMonitorAccount(payload: Partial<MonitorAccount> & { secret?: string }) {
    return (await apiClient.post<{ item: MonitorAccount }>('/app/monitor-accounts', payload)).data.item
  },
  async updateMonitorAccount(id: string, payload: Partial<MonitorAccount> & { secret?: string }) {
    return (await apiClient.put<{ item: MonitorAccount }>(`/app/monitor-accounts/${id}`, payload)).data.item
  },
  async deleteMonitorAccount(id: string) {
    return (await apiClient.delete<{ ok: true }>(`/app/monitor-accounts/${id}`)).data
  },
  async createMonitorRule(payload: Partial<MonitorRule>) {
    return (await apiClient.post<{ item: MonitorRule }>('/app/monitor-rules', payload)).data.item
  },
  async updateMonitorRule(id: string, payload: Partial<MonitorRule>) {
    return (await apiClient.put<{ item: MonitorRule }>(`/app/monitor-rules/${id}`, payload)).data.item
  },
  async deleteMonitorRule(id: string) {
    return (await apiClient.delete<{ ok: true }>(`/app/monitor-rules/${id}`)).data
  },
  async createBettingRule(payload: Partial<BettingRule>) {
    return (await apiClient.post<{ item: BettingRule }>('/app/betting-rules', payload)).data.item
  },
  async updateBettingRule(id: string, payload: Partial<BettingRule>) {
    return (await apiClient.put<{ item: BettingRule }>(`/app/betting-rules/${id}`, payload)).data.item
  },
  async deleteBettingRule(id: string) {
    return (await apiClient.delete<{ ok: true }>(`/app/betting-rules/${id}`)).data
  },
  async getAutoBettingSettings() {
    return (await apiClient.get<AutoBettingSettingsResponse>('/app/auto-betting-settings')).data
  },
  async updateAutoBettingSetting(mode: AutoBetMode, payload: AutoBettingSettingUpdate) {
    return (await apiClient.put<{ item: AutoBettingSettingsResponse['items'][AutoBetMode] }>(`/app/auto-betting-settings/${mode}`, payload)).data.item
  },
  async getAutoBettingRuleCards() {
    return (await apiClient.get<{ items: AutoBettingRuleCard[] }>('/app/auto-betting-rule-cards')).data
  },
  async createAutoBettingRuleCard(payload: RuleCardMutation) {
    return (await apiClient.post<{ item: AutoBettingRuleCard }>('/app/auto-betting-rule-cards', payload)).data.item
  },
  async updateAutoBettingRuleCard(cardId: string, payload: RuleCardUpdate) {
    return (await apiClient.put<{ item: AutoBettingRuleCard }>(`/app/auto-betting-rule-cards/${encodeURIComponent(cardId)}`, payload)).data.item
  },
  async deleteAutoBettingRuleCard(cardId: string, expectedVersion: number) {
    return (await apiClient.delete<{ ok: true }>(`/app/auto-betting-rule-cards/${encodeURIComponent(cardId)}`, {
      data: { expectedVersion },
    })).data
  },
  async getTodayBettingLeagues(cardId?: string) {
    return (await apiClient.get<{ items: TodayBettingLeague[] }>('/app/today-betting-leagues', {
      params: cardId ? { cardId } : {},
    })).data
  },
  async getRealBettingStatus() {
    return (await apiClient.get<{ item: RealBettingStatus }>('/app/real-betting-status')).data
  },
  async getOperationsSummary(signal?: AbortSignal) {
    return (await apiClient.get<{ item: OperationsSummary }>('/app/operations-summary', { signal })).data
  },
  async getRuntimeCleanupPreview() {
    return (await apiClient.get<{ item: RuntimeCleanupPreview }>('/app/runtime-cache-cleanup')).data
  },
  async runRuntimeCleanup() {
    return (await apiClient.post<{ item: RuntimeCleanupPreview }>('/app/runtime-cache-cleanup', {})).data
  },
  async getSystemUpdate(signal?: AbortSignal) {
    return (await apiClient.get<{ item: SystemUpdateStatus }>('/app/system-update', { signal })).data
  },
  async checkSystemUpdate() {
    return (await apiClient.post<{ item: SystemUpdateStatus }>('/app/system-update/check', {}, { timeout: 0 })).data
  },
  async installSystemUpdate(expectedVersion: string) {
    return (await apiClient.post<{ item: SystemUpdateStatus }>('/app/system-update/install', { expectedVersion }, { timeout: 0 })).data
  },
  async cancelSystemUpdate() {
    return (await apiClient.post<{ item: SystemUpdateCancelResult }>('/app/system-update/cancel', {})).data
  },
  async startRealBetting() {
    return (await apiClient.post<{ item: RealBettingStatus }>('/app/real-betting/start', {})).data
  },
  async stopRealBetting() {
    return (await apiClient.post<{ item: RealBettingStatus }>('/app/real-betting/stop', {})).data
  },
  async getBetBatches(limit = 50) {
    return (await apiClient.get<{ items: BetBatch[] }>('/app/bet-batches', { params: { limit } })).data
  },
  async getBetBatchChildren(batchId: string) {
    return (await apiClient.get<{ items: BetChildOrder[] }>(`/app/bet-batches/${encodeURIComponent(batchId)}/children`)).data
  },
  async createBettingAccount(payload: Partial<BettingAccount> & { secret?: string; password?: string }) {
    return (await apiClient.post<{ item: BettingAccount }>('/app/betting-accounts', payload)).data.item
  },
  async updateBettingAccount(id: string, payload: Partial<BettingAccount> & { secret?: string; password?: string }) {
    return (await apiClient.put<{ item: BettingAccount }>(`/app/betting-accounts/${id}`, payload)).data.item
  },
  async deleteBettingAccount(id: string) {
    return (await apiClient.delete<{ ok: true }>(`/app/betting-accounts/${id}`)).data
  },
  async checkBettingAccountAccess(id: string) {
    return (await apiClient.post<{
      item: BettingAccount
      result: {
        ok: boolean
        status: 'available' | 'failed'
        errorCode: string
        reportedBalance: string | null
        reportedCurrency: string
        balanceSource: 'account-summary' | 'login' | 'none'
      }
    }>(`/app/betting-accounts/${id}/actions`, { action: 'check-access' })).data
  },
  async pauseBettingAccount(id: string) {
    return (await apiClient.post<{ item: BettingAccount }>(`/app/betting-accounts/${id}/pause`, {})).data
  },
  async enableBettingAccount(id: string) {
    return (await apiClient.post<{
      item: BettingAccount
      result: { ok: boolean; status: 'available' | 'failed'; errorCode: string }
    }>(`/app/betting-accounts/${id}/enable`, {})).data
  },
}
