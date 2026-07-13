import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api, apiClient } from './api'
import type { RuleCardMutation } from '../types'

const originalAdapter = apiClient.defaults.adapter

function response(config: AxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    config: config as InternalAxiosRequestConfig,
    data,
    headers: {},
    status: 200,
    statusText: 'OK',
  }
}

function csrfHeader(config: AxiosRequestConfig) {
  const headers = config.headers as { get?: (name: string) => unknown } | undefined
  return headers?.get?.('X-CSRF-Token')
}

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  vi.restoreAllMocks()
})

describe('Dashboard API session contract', () => {
  const ruleCard: RuleCardMutation = {
    name: 'A', enabled: true, leagueNames: ['Premier League'], targetOddsMin: '0.8',
    targetOddsMax: '1.05', targetAmountMinor: 100, remark: '',
  }

  test.each([
    ['different', { appContractVersion: 'fixed-settings-v1', schemaVersion: 'fixed-settings-v1' }],
    ['missing', {}],
  ])('blocks mutation before transport when backend contract is %s', async (_label, contract) => {
    const requests: AxiosRequestConfig[] = []
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') {
        return response(config, { csrfToken: 'csrf-old-backend', dashboardAccessMode: 'local-trust', ...contract })
      }
      return response(config, { item: {} })
    }

    await api.sessionBootstrap()

    await expect(api.startMonitor('prematch')).rejects.toThrow('contract-version-mismatch')
    expect(requests.map((request) => request.url)).toEqual(['/app/security-context'])
  })

  test('csrf retry cannot bypass a contract mismatch discovered during token refresh', async () => {
    const requests: AxiosRequestConfig[] = []
    let refresh = false
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') {
        return response(config, refresh
          ? { csrfToken: 'csrf-new', dashboardAccessMode: 'local-trust', appContractVersion: 'old-v1', schemaVersion: 'old-v1' }
          : { csrfToken: 'csrf-old', dashboardAccessMode: 'local-trust', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      }
      refresh = true
      return Promise.reject({ config, response: { status: 403, data: { error: 'csrf-invalid' } }, message: 'forbidden' })
    }

    await api.sessionBootstrap()
    await expect(api.startMonitor('prematch')).rejects.toThrow('contract-version-mismatch')

    expect(requests.map((request) => request.url)).toEqual([
      '/app/security-context', '/monitor/start', '/app/security-context',
    ])
  })

  test('session bootstrap uses the lightweight security context endpoint', async () => {
    const requests: AxiosRequestConfig[] = []
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      return response(config, { csrfToken: 'csrf-lightweight', dashboardAccessMode: 'local-trust', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
    }

    const payload = await api.sessionBootstrap()

    expect(payload.csrfToken).toBe('csrf-lightweight')
    expect(requests.map((request) => request.url)).toEqual(['/app/security-context'])
  })

  test('a csrf-invalid mutation refreshes the token once and retries safely', async () => {
    const requests: AxiosRequestConfig[] = []
    let rejected = false
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') {
        return response(config, { csrfToken: rejected ? 'csrf-after-restart' : 'csrf-before-restart', dashboardAccessMode: 'local-trust', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      }
      if (!rejected) {
        rejected = true
        return Promise.reject({
          config,
          response: { status: 403, data: { error: 'csrf-invalid' } },
          message: 'forbidden',
        })
      }
      return response(config, { item: {} })
    }

    await api.sessionBootstrap()
    await api.startMonitor('prematch')

    expect(requests.map((request) => request.url)).toEqual([
      '/app/security-context',
      '/monitor/start',
      '/app/security-context',
      '/monitor/start',
    ])
    expect(csrfHeader(requests[1])).toBe('csrf-before-restart')
    expect(csrfHeader(requests[3])).toBe('csrf-after-restart')
  })

  test.each([
    ['monitor alert', () => api.updateMonitorAlertSetting('prematch', { expectedVersion: 1, acknowledgeMigrationReview: false, enabled: true, asianHandicapEnabled: true, totalEnabled: false, monitorOddsMin: 0, monitorOddsMax: 1, waterMoveThreshold: .03, cooldownSeconds: 60, remark: '', startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5 }), '/app/monitor-alert-settings/prematch', { expectedVersion: 1, acknowledgeMigrationReview: false, enabled: true, asianHandicapEnabled: true, totalEnabled: false, monitorOddsMin: 0, monitorOddsMax: 1, waterMoveThreshold: .03, cooldownSeconds: 60, remark: '', startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5 }],
    ['rule card', () => api.updateAutoBettingRuleCard('card/unsafe ?', { ...ruleCard, expectedVersion: 2 }), '/app/auto-betting-rule-cards/card%2Funsafe%20%3F', { ...ruleCard, expectedVersion: 2 }],
  ])('%s PUT sends CSRF and retries one invalid token exactly once', async (_name, mutate, path, body) => {
    const requests: AxiosRequestConfig[] = []
    let rejected = false
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') return response(config, { csrfToken: rejected ? 'csrf-new' : 'csrf-old', dashboardAccessMode: 'local-trust', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      if (!rejected) {
        rejected = true
        return Promise.reject({ config, response: { status: 403, data: { error: 'csrf-invalid' } }, message: 'forbidden' })
      }
      return response(config, { item: {} })
    }
    await api.sessionBootstrap()
    await mutate()
    const puts = requests.filter((request) => request.url === path)
    expect(puts).toHaveLength(2)
    expect(puts.map((request) => request.method)).toEqual(['put', 'put'])
    expect(puts.map(csrfHeader)).toEqual(['csrf-old', 'csrf-new'])
    expect(puts.map((request) => JSON.parse(String(request.data)))).toEqual([body, body])
  })

  test('rule card services use canonical paths and DELETE sends expectedVersion in the body', async () => {
    const requests: AxiosRequestConfig[] = []
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') return response(config, { csrfToken: 'csrf-card', dashboardAccessMode: 'local-trust', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      if (config.url === '/app/today-betting-leagues') return response(config, { items: [] })
      if (config.method === 'get') return response(config, { items: [] })
      if (config.method === 'delete') return response(config, { ok: true })
      return response(config, { item: {} })
    }
    await api.sessionBootstrap()
    await api.getAutoBettingRuleCards()
    await api.createAutoBettingRuleCard(ruleCard)
    await api.getTodayBettingLeagues('card-1')
    await api.deleteAutoBettingRuleCard('card/unsafe ?', 3)

    expect(requests.slice(1).map((request) => request.url)).toEqual([
      '/app/auto-betting-rule-cards',
      '/app/auto-betting-rule-cards',
      '/app/today-betting-leagues',
      '/app/auto-betting-rule-cards/card%2Funsafe%20%3F',
    ])
    expect(requests[3].params).toEqual({ cardId: 'card-1' })
    expect(JSON.parse(String(requests[4].data))).toEqual({ expectedVersion: 3 })
    expect(csrfHeader(requests[2])).toBe('csrf-card')
    expect(csrfHeader(requests[4])).toBe('csrf-card')
  })

  test('maps settings CAS conflicts to one stable operator message', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/app/security-context') return response(config, { appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      return Promise.reject({ config, response: { status: 409, data: { error: 'auto-betting-settings-version-conflict' } }, message: 'conflict' })
    }
    await api.sessionBootstrap()
    await expect(api.updateAutoBettingSetting('prematch', { expectedVersion: 1 } as any)).rejects.toThrow('配置已被其他页面更新，请刷新后重试')
  })

  test('bootstrap keeps CSRF only in memory and every representative mutation sends it', async () => {
    const requests: AxiosRequestConfig[] = []
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/bootstrap') return response(config, { csrfToken: 'csrf-memory-only', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      if (config.url?.includes('/betting-rules')) return response(config, { item: {} })
      if (config.url?.includes('/betting-accounts')) return response(config, { item: {} })
      return response(config, {})
    }

    await api.bootstrap()
    await api.createBettingRule({ name: 'rule' })
    await api.createBettingAccount({ username: 'account' })
    await api.startMonitor('prematch')

    const mutations = requests.filter((request) => request.method !== 'get')
    expect(mutations).toHaveLength(3)
    expect(mutations.map(csrfHeader)).toEqual(['csrf-memory-only', 'csrf-memory-only', 'csrf-memory-only'])
    expect(storageSet).not.toHaveBeenCalled()
  })

  test('login posts the password without writing browser storage', async () => {
    const requests: AxiosRequestConfig[] = []
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      return response(config, { authenticated: true })
    }

    await api.login('one-use-password')

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/app/session')
    expect(requests[0].method).toBe('post')
    expect(JSON.parse(String(requests[0].data))).toEqual({ password: 'one-use-password' })
    expect(localSet).not.toHaveBeenCalled()
  })

  test('a 401 response clears in-memory CSRF before the next mutation', async () => {
    const requests: AxiosRequestConfig[] = []
    const authExpired = vi.fn()
    let rejectMutation = true
    window.addEventListener('crown:dashboard-auth-expired', authExpired)
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/bootstrap') return response(config, { csrfToken: 'csrf-before-401', appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
      if (rejectMutation) {
        rejectMutation = false
        return Promise.reject({ response: { status: 401, data: { error: 'authentication-required' } }, message: 'unauthorized' })
      }
      return response(config, {})
    }

    await api.bootstrap()
    await expect(api.startMonitor('prematch')).rejects.toThrow('authentication-required')
    await api.startMonitor('prematch')

    const mutations = requests.filter((request) => request.url === '/monitor/start')
    expect(csrfHeader(mutations[0])).toBe('csrf-before-401')
    expect(csrfHeader(mutations[1])).toBeUndefined()
    expect(authExpired).toHaveBeenCalledTimes(1)
    window.removeEventListener('crown:dashboard-auth-expired', authExpired)
  })

  test('system update services use canonical paths, exact version body and in-memory CSRF only', async () => {
    const requests: AxiosRequestConfig[] = []
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    apiClient.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/app/security-context') {
        return response(config, {
          csrfToken: 'csrf-update',
          dashboardAccessMode: 'local-trust',
          appContractVersion: 'dynamic-betting-cards-v1',
          schemaVersion: 'dynamic-betting-cards-v1',
        })
      }
      if (config.url?.endsWith('/cancel')) return response(config, { item: { cancelled: true, code: 'update-cancelled' } })
      return response(config, { item: { state: 'idle', currentVersion: '0.1.0', availableVersion: '', progress: 0, errorCode: '', cancellable: false, releaseNotes: '', rollbackReason: '' } })
    }

    await api.sessionBootstrap()
    await api.getSystemUpdate()
    await api.checkSystemUpdate()
    await api.installSystemUpdate('0.2.0')
    await api.cancelSystemUpdate()

    expect(requests.slice(1).map((request) => [request.method, request.url])).toEqual([
      ['get', '/app/system-update'],
      ['post', '/app/system-update/check'],
      ['post', '/app/system-update/install'],
      ['post', '/app/system-update/cancel'],
    ])
    expect(JSON.parse(String(requests[3].data))).toEqual({ expectedVersion: '0.2.0' })
    expect(requests.slice(1).map((request) => request.timeout)).toEqual([10000, 0, 0, 10000])
    expect(csrfHeader(requests[1])).toBeUndefined()
    expect(requests.slice(2).map(csrfHeader)).toEqual(['csrf-update', 'csrf-update', 'csrf-update'])
    expect(storageSet).not.toHaveBeenCalled()
  })

  test('preserves a stable update conflict code instead of rewriting it as a settings conflict', async () => {
    apiClient.defaults.adapter = async (config) => {
      if (config.url === '/app/security-context') {
        return response(config, {
          csrfToken: 'csrf-update-conflict',
          dashboardAccessMode: 'local-trust',
          appContractVersion: 'dynamic-betting-cards-v1',
          schemaVersion: 'dynamic-betting-cards-v1',
        })
      }
      return Promise.reject({
        config,
        response: { status: 409, data: { error: 'update-operation-in-progress' } },
        message: 'conflict',
      })
    }

    await api.sessionBootstrap()
    await expect(api.checkSystemUpdate()).rejects.toThrow('update-operation-in-progress')
  })
})
