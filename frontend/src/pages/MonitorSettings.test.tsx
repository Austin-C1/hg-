import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import MonitorSettings from './MonitorSettings'
import { api } from '../services/api'

const prematch = { mode: 'prematch' as const, enabled: true, asianHandicapEnabled: true, totalEnabled: true, monitorOddsMin: 0, monitorOddsMax: 1.2, waterMoveThreshold: 0.03, cooldownSeconds: 60, startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5, remark: '赛前', migrationReviewRequired: false, migrationReviewReason: '', version: 3, createdAt: '', updatedAt: '2026-07-12T00:00:00Z' }
const live = { mode: 'live' as const, enabled: true, asianHandicapEnabled: true, totalEnabled: false, monitorOddsMin: 0.5, monitorOddsMax: 1.1, waterMoveThreshold: 0.02, cooldownSeconds: 30, liveMinuteFrom: 0, liveMinuteTo: 90, includeFirstHalf: true, includeHalfTime: false, includeSecondHalf: true, remark: '滚球', migrationReviewRequired: false, migrationReviewReason: '', version: 4, createdAt: '', updatedAt: '2026-07-12T00:00:00Z' }

vi.mock('../services/api', () => ({
  APP_CONTRACT_VERSION: 'dynamic-betting-cards-v1',
  isDashboardAuthenticationError: (error: unknown) => error instanceof Error && error.message === 'authentication-required',
  api: {
    sessionBootstrap: vi.fn(async () => ({ appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })),
    getMonitorAlertSettings: vi.fn(async () => ({ items: { prematch, live }, summary: { enabledCount: 2, enabledModes: ['prematch', 'live'], migrationReviewRequiredCount: 0 } })),
    updateMonitorAlertSetting: vi.fn(async (_mode, payload) => ({ ...prematch, ...payload, version: payload.expectedVersion + 1 })),
    startMonitor: vi.fn(), stopMonitor: vi.fn(),
  },
}))

describe('MonitorSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  test('shows a stable blocker and sends no mutation when backend contract differs', async () => {
    vi.mocked(api.sessionBootstrap).mockResolvedValueOnce({
      appContractVersion: 'fixed-settings-v1',
      schemaVersion: 'fixed-settings-v1',
    } as Awaited<ReturnType<typeof api.sessionBootstrap>>)

    render(<MonitorSettings />)

    expect(await screen.findByText('Dashboard 已升级，请重启')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存赛前报警' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(api.updateMonitorAlertSetting).not.toHaveBeenCalled()
  })

  test('renders allowlisted field validation details returned by the API', async () => {
    vi.mocked(api.updateMonitorAlertSetting).mockRejectedValueOnce(Object.assign(new Error('validation-error'), {
      status: 400,
      payload: { error: 'validation-error', fields: { waterMoveThreshold: 'waterMoveThreshold must be finite and non-negative' } },
    }))
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))

    expect(await within(before).findByText('动水阈值不能为空且必须大于等于 0。')).toBeInTheDocument()
  })

  test('renders two simultaneously enabled mode cards and all mode-specific controls', async () => {
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    const inPlay = screen.getByRole('region', { name: '滚球报警' })
    expect(within(before).getByRole('switch', { name: '启用赛前报警' })).toBeChecked()
    expect(within(inPlay).getByRole('switch', { name: '启用滚球报警' })).toBeChecked()
    expect(within(before).getByLabelText('开始监控（开赛前分钟）')).toBeInTheDocument()
    expect(within(inPlay).getByRole('checkbox', { name: '上半场' })).toBeChecked()
    expect(screen.queryByRole('button', { name: /启动监控|停止监控/ })).not.toBeInTheDocument()
  })

  test('saves one complete canonical row without opposite-mode fields', async () => {
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))
    await waitFor(() => expect(api.updateMonitorAlertSetting).toHaveBeenCalledWith('prematch', expect.objectContaining({ expectedVersion: 3, enabled: true, asianHandicapEnabled: true, totalEnabled: true, monitorOddsMin: 0, startMinutesBeforeKickoff: 180 })))
    const sent = vi.mocked(api.updateMonitorAlertSetting).mock.calls[0][1] as Record<string, unknown>
    expect(sent).not.toHaveProperty('liveMinuteFrom')
    expect(sent).not.toHaveProperty('includeFirstHalf')
  })

  test('validates market, live phases and ordered windows before PUT', async () => {
    render(<MonitorSettings />)
    const inPlay = await screen.findByRole('region', { name: '滚球报警' })
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '让球' }))
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '上半场' }))
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '下半场' }))
    fireEvent.click(within(inPlay).getByRole('button', { name: '保存滚球报警' }))
    expect(await within(inPlay).findByText(/至少选择一个监控盘口/)).toBeInTheDocument()
    expect(api.updateMonitorAlertSetting).not.toHaveBeenCalled()
  })

  test('rejects enabled live with no phase and reversed live window', async () => {
    render(<MonitorSettings />)
    const inPlay = await screen.findByRole('region', { name: '滚球报警' })
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '上半场' }))
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '下半场' }))
    fireEvent.click(within(inPlay).getByRole('button', { name: '保存滚球报警' }))
    expect(await within(inPlay).findByText(/至少选择一个比赛阶段/)).toBeInTheDocument()
    fireEvent.click(within(inPlay).getByRole('checkbox', { name: '上半场' }))
    fireEvent.change(within(inPlay).getByLabelText('滚球起始分钟'), { target: { value: '91' } })
    fireEvent.click(within(inPlay).getByRole('button', { name: '保存滚球报警' }))
    expect(await within(inPlay).findByText(/起始分钟不得大于结束分钟/)).toBeInTheDocument()
    expect(api.updateMonitorAlertSetting).not.toHaveBeenCalled()
  })

  test('rejects values outside safe range and sends exact live fields', async () => {
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    expect(within(before).getByLabelText('动水阈值')).toBeInTheDocument()
    expect(within(before).getByText('上涨、下降达到阈值都会报警')).toBeInTheDocument()
    expect(within(before).queryByLabelText('升水阈值')).not.toBeInTheDocument()
    fireEvent.change(within(before).getByLabelText('动水阈值'), { target: { value: '9007199254740992' } })
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))
    expect(await within(before).findByText(/安全范围/)).toBeInTheDocument()
    const inPlay = screen.getByRole('region', { name: '滚球报警' })
    fireEvent.click(within(inPlay).getByRole('button', { name: '保存滚球报警' }))
    await waitFor(() => expect(api.updateMonitorAlertSetting).toHaveBeenCalledWith('live', {
      expectedVersion: 4, acknowledgeMigrationReview: false, enabled: true, asianHandicapEnabled: true, totalEnabled: false,
      monitorOddsMin: 0.5, monitorOddsMax: 1.1, waterMoveThreshold: 0.02, cooldownSeconds: 30,
      liveMinuteFrom: 0, liveMinuteTo: 90, includeFirstHalf: true, includeHalfTime: false,
      includeSecondHalf: true, remark: '滚球',
    }))
  })

  test('only sends explicit migration acknowledgement for a reviewed server row', async () => {
    vi.mocked(api.getMonitorAlertSettings).mockResolvedValueOnce({
      items: { prematch: { ...prematch, migrationReviewRequired: true }, live },
      summary: { enabledCount: 2, enabledModes: ['prematch', 'live'], migrationReviewRequiredCount: 1 },
    })
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))

    await waitFor(() => expect(api.updateMonitorAlertSetting).toHaveBeenCalledWith('prematch', expect.objectContaining({
      expectedVersion: 3,
      acknowledgeMigrationReview: true,
    })))
  })

  test.each([new Error('authentication-required'), new Error('network-down')])('rolls back draft after %s save failure', async (failure) => {
    vi.mocked(api.updateMonitorAlertSetting).mockRejectedValueOnce(failure)
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    fireEvent.click(within(before).getByRole('switch', { name: '启用赛前报警' }))
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))
    await waitFor(() => expect(within(before).getByRole('switch', { name: '启用赛前报警' })).toBeChecked())
  })

  test('keeps server state and shows the stable CAS message when save conflicts', async () => {
    vi.mocked(api.updateMonitorAlertSetting).mockRejectedValueOnce(Object.assign(new Error('monitor-alert-settings-version-conflict'), { status: 409 }))
    render(<MonitorSettings />)
    const before = await screen.findByRole('region', { name: '赛前报警' })
    fireEvent.click(within(before).getByRole('switch', { name: '启用赛前报警' }))
    fireEvent.click(within(before).getByRole('button', { name: '保存赛前报警' }))
    expect(await within(before).findByText('配置已被其他页面更新，请刷新后重试')).toBeInTheDocument()
    expect(within(before).getByRole('switch', { name: '启用赛前报警' })).toBeChecked()
  })
})
