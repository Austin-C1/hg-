import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import SystemUpdate from './SystemUpdate'
import { api } from '../services/api'
import type { SystemUpdateStatus } from '../types'

vi.mock('../services/api', () => ({
  api: {
    getSystemUpdate: vi.fn(),
    checkSystemUpdate: vi.fn(),
    installSystemUpdate: vi.fn(),
    cancelSystemUpdate: vi.fn(),
  },
}))

const available: SystemUpdateStatus = {
  state: 'available',
  currentVersion: '0.1.0',
  availableVersion: '0.2.0',
  progress: 0,
  errorCode: '',
  cancellable: false,
  releaseNotes: '修复更新流程\n<script>alert(1)</script>',
  rollbackReason: '',
}

describe('SystemUpdate', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(api.getSystemUpdate).mockResolvedValue({ item: available })
    vi.mocked(api.checkSystemUpdate).mockResolvedValue({ item: available })
    vi.mocked(api.installSystemUpdate).mockResolvedValue({ item: { ...available, state: 'applying', progress: 100 } })
    vi.mocked(api.cancelSystemUpdate).mockResolvedValue({ item: { cancelled: true, code: 'update-cancelled' } })
  })

  test('loads status without checking automatically and renders release notes as plain text', async () => {
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    const { container } = render(<SystemUpdate />)

    expect(await screen.findByRole('heading', { name: '系统更新' })).toBeInTheDocument()
    expect(screen.getByText('0.1.0')).toBeInTheDocument()
    expect(screen.getByText('0.2.0')).toBeInTheDocument()
    expect(screen.getByText('修复更新流程', { exact: false })).toHaveTextContent('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(api.getSystemUpdate).toHaveBeenCalledTimes(1)
    expect(api.checkSystemUpdate).not.toHaveBeenCalled()
    expect(storageSet).not.toHaveBeenCalled()
  })

  test('checks only after a manual action', async () => {
    vi.mocked(api.getSystemUpdate).mockResolvedValueOnce({ item: { ...available, state: 'idle', availableVersion: '', releaseNotes: '' } })
    render(<SystemUpdate />)

    const button = await screen.findByRole('button', { name: '检查更新' })
    expect(api.checkSystemUpdate).not.toHaveBeenCalled()
    fireEvent.click(button)

    await waitFor(() => expect(api.checkSystemUpdate).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('0.2.0')).toBeInTheDocument()
  })

  test('warns about stopped processes and installs only the displayed exact version after confirmation', async () => {
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    render(<SystemUpdate />)

    expect(await screen.findByText('安装会停止 Watcher 和投注 worker；更新完成或回滚后都不会自动恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '安装 0.2.0' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认安装' }))

    await waitFor(() => expect(api.installSystemUpdate).toHaveBeenCalledWith('0.2.0'))
    expect(storageSet).not.toHaveBeenCalled()
    expect(await screen.findByText('正在交给外部更新程序，当前阶段不可取消。')).toBeInTheDocument()
  })

  test('offers cancel only while the service reports a cancellable operation', async () => {
    vi.mocked(api.getSystemUpdate).mockResolvedValueOnce({
      item: { ...available, state: 'downloading', progress: 42, cancellable: true },
    })
    render(<SystemUpdate />)

    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }))
    await waitFor(() => expect(api.cancelSystemUpdate).toHaveBeenCalledTimes(1))
  })

  test('can cancel an in-flight install without turning expected cancellation into an error', async () => {
    let rejectInstall: ((error: Error) => void) | undefined
    vi.mocked(api.installSystemUpdate).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectInstall = reject
    }))
    vi.mocked(api.cancelSystemUpdate).mockImplementationOnce(async () => {
      rejectInstall?.(new Error('update-cancelled'))
      return { item: { cancelled: true, code: 'update-cancelled' } }
    })
    vi.mocked(api.getSystemUpdate)
      .mockResolvedValueOnce({ item: available })
      .mockResolvedValueOnce({ item: available })
      .mockResolvedValue({ item: available })
    render(<SystemUpdate />)

    fireEvent.click(await screen.findByRole('button', { name: '安装 0.2.0' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认安装' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消下载' }))

    await waitFor(() => expect(api.cancelSystemUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.getSystemUpdate).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('update-cancelled')).not.toBeInTheDocument()
    expect(screen.getByText('有可用更新')).toBeInTheDocument()
  })

  test('can cancel an in-flight manual check without turning expected cancellation into an error', async () => {
    let rejectCheck: ((error: Error) => void) | undefined
    vi.mocked(api.getSystemUpdate)
      .mockResolvedValueOnce({ item: { ...available, state: 'idle', availableVersion: '', releaseNotes: '' } })
      .mockResolvedValueOnce({ item: { ...available, state: 'idle', availableVersion: '', releaseNotes: '' } })
    vi.mocked(api.checkSystemUpdate).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectCheck = reject
    }))
    vi.mocked(api.cancelSystemUpdate).mockImplementationOnce(async () => {
      rejectCheck?.(new Error('update-cancelled'))
      return { item: { cancelled: true, code: 'update-cancelled' } }
    })
    render(<SystemUpdate />)

    const checkButton = await screen.findByRole('button', { name: /\u68c0\u67e5\u66f4\u65b0/ })
    fireEvent.click(checkButton)
    fireEvent.click(await screen.findByRole('button', { name: /\u53d6\u6d88\u4e0b\u8f7d/ }))

    await waitFor(() => expect(api.cancelSystemUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.getSystemUpdate).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('update-cancelled')).not.toBeInTheDocument()
  })

  test('apply is never cancellable and error plus rollback reason stay visible', async () => {
    vi.mocked(api.getSystemUpdate).mockResolvedValueOnce({
      item: {
        ...available,
        state: 'applying',
        progress: 100,
        cancellable: false,
        errorCode: 'update-apply-failed',
        rollbackReason: 'update-health-check-failed',
      },
    })
    render(<SystemUpdate />)

    expect(await screen.findByText('update-apply-failed')).toBeInTheDocument()
    expect(screen.getByText('update-health-check-failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消下载' })).not.toBeInTheDocument()
    expect(screen.getByText('正在交给外部更新程序，当前阶段不可取消。')).toBeInTheDocument()
  })

  test('unavailable configuration disables network actions', async () => {
    vi.mocked(api.getSystemUpdate).mockResolvedValueOnce({
      item: { ...available, state: 'unavailable', availableVersion: '', errorCode: 'update-unavailable', releaseNotes: '' },
    })
    render(<SystemUpdate />)

    expect(await screen.findByText('当前版本未配置可信更新签名密钥，更新功能不可用。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
  })

  test('initial status failure is visible without exposing arbitrary transport text', async () => {
    vi.mocked(api.getSystemUpdate).mockRejectedValueOnce(new Error('request failed password=secret'))
    render(<SystemUpdate />)

    expect(await screen.findByText('update-request-failed')).toBeInTheDocument()
    expect(screen.queryByText(/password=secret/)).not.toBeInTheDocument()
  })
})
