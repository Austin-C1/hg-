import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import CrownMonitorAccount from './CrownMonitorAccount'
import { api } from '../services/api'
import type { ManualLoginStatus, MonitorAccount } from '../types'

vi.mock('../services/api', () => ({
  api: {
    getMonitorAccount: vi.fn(),
    saveMonitorAccount: vi.fn(),
    monitorAccountAction: vi.fn(),
    getLoginDiagnostics: vi.fn(),
    openManualLogin: vi.fn(),
    getManualLoginStatus: vi.fn(),
    confirmManualLogin: vi.fn(),
    cancelManualLogin: vi.fn(),
  },
}))

const account = {
  id: 'mon_primary',
  label: '主监控账号',
  username: 'owner-user',
  loginUrl: 'https://crown.example.com',
  enabled: true,
  status: 'enabled',
  hasSecret: true,
  notes: '',
  loginStatus: '需要人工处理',
  currentMonitorStatus: '已停止',
  lastLoginAt: null,
  lastOnlineCheckAt: null,
  lastXmlResponseAt: null,
  lastOddsParsedAt: null,
  consecutiveFailures: 0,
  oddsScanIntervalSeconds: 10,
  autoReloginCount: 0,
  maxAutoReloginCount: 3,
  lastLoginResult: null,
  lastLoginResultAt: null,
  lastLoginDiagnosticsPath: null,
  updatedAt: '2026-07-13T00:00:00.000Z',
} satisfies MonitorAccount

function manualStatus(
  status: ManualLoginStatus['status'] = 'awaiting-user',
  errorCode = '',
): ManualLoginStatus {
  return {
    challengeId: 'challenge-safe',
    accountId: account.id,
    status,
    errorCode,
    expiresAt: Date.now() + 60_000,
  }
}

describe('CrownMonitorAccount manual login', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(api.getMonitorAccount).mockResolvedValue({ item: account })
    vi.mocked(api.openManualLogin).mockResolvedValue(manualStatus())
    vi.mocked(api.getManualLoginStatus).mockResolvedValue(manualStatus())
    vi.mocked(api.confirmManualLogin).mockResolvedValue(manualStatus('verified'))
    vi.mocked(api.cancelManualLogin).mockResolvedValue(manualStatus('failed', 'manual-login-cancelled'))
  })

  test('opens bundled Chromium and tells the user to handle CAPTCHA, slider, or OTP personally', async () => {
    render(<CrownMonitorAccount />)

    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))

    await waitFor(() => expect(api.openManualLogin).toHaveBeenCalledWith(
      account.id,
      expect.any(AbortSignal),
    ))
    expect((await screen.findAllByText(/验证码、滑块或 OTP/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '我已完成登录，开始验证' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '取消人工登录' })).toBeEnabled()
  })

  test('confirms the browser login, reports completion, and never starts Watcher', async () => {
    render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))
    fireEvent.click(await screen.findByRole('button', { name: '我已完成登录，开始验证' }))

    expect(await screen.findByText('人工登录验证完成')).toBeInTheDocument()
    expect(api.confirmManualLogin).toHaveBeenCalledWith(
      account.id,
      'challenge-safe',
      expect.any(AbortSignal),
    )
    expect(api.monitorAccountAction).not.toHaveBeenCalled()
  })

  test('lets the user cancel an active browser challenge', async () => {
    render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消人工登录' }))

    expect(await screen.findByText('已取消本次人工登录')).toBeInTheDocument()
    expect(api.cancelManualLogin).toHaveBeenCalledWith(
      account.id,
      'challenge-safe',
      expect.any(AbortSignal),
    )
  })

  test('shows a bounded error without persisting or rendering secret material', async () => {
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(api.openManualLogin).mockRejectedValue(new Error(
      'password=leaked cookie=SID nonce=challenge-internal',
    ))
    render(<CrownMonitorAccount />)

    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))

    expect(await screen.findByText('人工登录操作失败，请重试')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/leaked|SID|challenge-internal/)
    expect(storageSet).not.toHaveBeenCalled()
  })

  test('aborts an in-flight status poll when the page unmounts', async () => {
    let pollSignal: AbortSignal | undefined
    vi.mocked(api.getManualLoginStatus).mockImplementation((_accountId, _challengeId, signal) => {
      pollSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const view = render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))
    await waitFor(() => expect(api.getManualLoginStatus).toHaveBeenCalled())

    view.unmount()

    expect(pollSignal?.aborted).toBe(true)
  })

  test('turns a missing challenge poll into a recoverable terminal state', async () => {
    vi.mocked(api.getManualLoginStatus).mockRejectedValue(
      new Error('manual-login-challenge-not-found'),
    )
    render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))

    expect(await screen.findByText('本次人工登录已失效，请重新打开')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新打开人工登录' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '我已完成登录，开始验证' })).not.toBeInTheDocument()
  })

  test.each([
    ['confirm', 'manual-login-challenge-expired', '本次人工登录已过期，请重新打开'],
    ['cancel', 'manual-login-challenge-binding-mismatch', '本次人工登录已失效，请重新打开'],
  ])('%s moves an unrecoverable challenge error to a reopenable terminal state', async (action, code, text) => {
    if (action === 'confirm') vi.mocked(api.confirmManualLogin).mockRejectedValue(new Error(code))
    else vi.mocked(api.cancelManualLogin).mockRejectedValue(new Error(code))
    render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))
    fireEvent.click(await screen.findByRole('button', {
      name: action === 'confirm' ? '我已完成登录，开始验证' : '取消人工登录',
    }))

    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新打开人工登录' })).toBeEnabled()
  })

  test('retries transient status failures with a bound and then exposes reopen', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getManualLoginStatus).mockRejectedValue(new Error('temporary-network-error'))
    render(<CrownMonitorAccount />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '打开皇冠人工登录' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.getManualLoginStatus).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(1500); await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1500); await Promise.resolve() })

    expect(api.getManualLoginStatus).toHaveBeenCalledTimes(3)
    expect(screen.getByText('无法确认人工登录状态，请重新打开')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新打开人工登录' })).toBeEnabled()
  })

  test('synchronously blocks rapid duplicate open mutations', async () => {
    vi.mocked(api.openManualLogin).mockImplementation(() => new Promise(() => {}))
    render(<CrownMonitorAccount />)
    const open = await screen.findByRole('button', { name: '打开皇冠人工登录' })

    fireEvent.click(open)
    fireEvent.click(open)

    expect(api.openManualLogin).toHaveBeenCalledTimes(1)
  })

  test('keeps confirm and cancel mutually exclusive while either mutation is in flight', async () => {
    vi.mocked(api.confirmManualLogin).mockImplementation(() => new Promise(() => {}))
    render(<CrownMonitorAccount />)
    fireEvent.click(await screen.findByRole('button', { name: '打开皇冠人工登录' }))
    const confirm = await screen.findByRole('button', { name: '我已完成登录，开始验证' })
    const cancel = screen.getByRole('button', { name: '取消人工登录' })

    fireEvent.click(confirm)
    fireEvent.click(cancel)
    fireEvent.click(confirm)

    expect(api.confirmManualLogin).toHaveBeenCalledTimes(1)
    expect(api.cancelManualLogin).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '取消人工登录' })).toBeDisabled()
  })
})
