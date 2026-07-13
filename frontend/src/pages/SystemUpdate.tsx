import { Alert, Button, Descriptions, Popconfirm, Progress, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import { api } from '../services/api'
import type { SystemUpdateState, SystemUpdateStatus } from '../types'

const { Paragraph, Text } = Typography

const stateLabels: Record<SystemUpdateState, string> = {
  unavailable: '不可用',
  idle: '尚未检查',
  checking: '正在检查',
  available: '有可用更新',
  'up-to-date': '已是最新版本',
  downloading: '正在下载并验证',
  applying: '正在应用',
  error: '更新失败',
}

const stateColors: Partial<Record<SystemUpdateState, string>> = {
  available: 'blue',
  'up-to-date': 'green',
  downloading: 'processing',
  applying: 'processing',
  error: 'red',
}

function errorCode(error: unknown) {
  return error instanceof Error && /^update-[a-z0-9-]+$/.test(error.message)
    ? error.message
    : 'update-request-failed'
}

export default function SystemUpdate() {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [action, setAction] = useState<'check' | 'install' | 'cancel' | ''>('')

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await api.getSystemUpdate(signal)
    setLoadError('')
    setStatus(result.item)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(errorCode(error))
          setStatus((current) => current ? { ...current, state: 'error', errorCode: errorCode(error) } : null)
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!status || !['checking', 'downloading'].includes(status.state)) return
    const timer = window.setInterval(() => { void load().catch(() => {}) }, 1_000)
    return () => window.clearInterval(timer)
  }, [load, status])

  async function check() {
    if (!status || action) return
    setAction('check')
    setStatus({ ...status, state: 'checking', progress: 0, errorCode: '', cancellable: true })
    try {
      setStatus((await api.checkSystemUpdate()).item)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'update-cancelled') {
        setStatus((current) => current ? { ...current, state: 'error', errorCode: code, cancellable: false } : current)
      }
    } finally {
      setAction((current) => current === 'check' ? '' : current)
    }
  }

  async function install() {
    if (!status?.availableVersion || action) return
    const expectedVersion = status.availableVersion
    setAction('install')
    setStatus({ ...status, state: 'downloading', progress: 0, errorCode: '', cancellable: true })
    try {
      setStatus((await api.installSystemUpdate(expectedVersion)).item)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'update-cancelled') {
        setStatus((current) => current ? { ...current, state: 'error', errorCode: code, cancellable: false } : current)
      }
    } finally {
      setAction((current) => current === 'install' ? '' : current)
    }
  }

  async function cancel() {
    if (!status?.cancellable || status.state === 'applying' || action === 'cancel') return
    setAction('cancel')
    try {
      const result = await api.cancelSystemUpdate()
      if (result.item.cancelled) await load()
    } catch (error) {
      setStatus((current) => current ? { ...current, errorCode: errorCode(error) } : current)
    } finally {
      setAction((current) => current === 'cancel' ? '' : current)
    }
  }

  const unavailable = status?.state === 'unavailable'
  const busy = Boolean(status && ['checking', 'downloading', 'applying'].includes(status.state))
  const canInstall = status?.state === 'available' && Boolean(status.availableVersion) && !action

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h1>系统更新</h1>
          <p>只在此页面手动检查和安装经过签名验证的 Windows 版本。</p>
        </div>
      </div>

      {loading && !status ? <Spin aria-label="正在读取更新状态" /> : null}
      {loadError ? <Alert type="error" showIcon message="无法读取更新状态" description={loadError} /> : null}

      {status ? (
        <>
          {unavailable ? (
            <Alert type="warning" showIcon message="当前版本未配置可信更新签名密钥，更新功能不可用。" />
          ) : null}

          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label="当前版本"><Text copyable>{status.currentVersion}</Text></Descriptions.Item>
            <Descriptions.Item label="可用版本">{status.availableVersion || '—'}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={stateColors[status.state]}>{stateLabels[status.state]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="进度">{status.progress}%</Descriptions.Item>
          </Descriptions>

          {['checking', 'downloading', 'applying'].includes(status.state) ? (
            <Progress percent={status.progress} status={status.state === 'applying' ? 'active' : 'normal'} />
          ) : null}

          <Alert
            type="warning"
            showIcon
            message="安装会停止 Watcher 和投注 worker；更新完成或回滚后都不会自动恢复。"
          />

          {status.state === 'applying' ? (
            <Alert type="info" showIcon message="正在交给外部更新程序，当前阶段不可取消。" />
          ) : null}

          {status.errorCode ? <Alert type="error" showIcon message="更新错误" description={status.errorCode} /> : null}
          {status.rollbackReason ? <Alert type="warning" showIcon message="回滚原因" description={status.rollbackReason} /> : null}

          {status.releaseNotes ? (
            <section aria-labelledby="release-notes-heading">
              <h2 id="release-notes-heading">版本说明</h2>
              <Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{status.releaseNotes}</Paragraph>
            </section>
          ) : null}

          <Space wrap>
            <Button
              onClick={() => void check()}
              loading={action === 'check'}
              disabled={unavailable || busy || Boolean(action)}
            >
              检查更新
            </Button>
            <Popconfirm
              title={`安装 ${status.availableVersion || ''}`}
              description="确认停止 Watcher 和 worker，并安装已验证更新？"
              okText="确认安装"
              cancelText="取消"
              onConfirm={() => void install()}
              disabled={!canInstall}
            >
              <Button type="primary" disabled={!canInstall} loading={action === 'install'}>
                {status.availableVersion ? `安装 ${status.availableVersion}` : '安装更新'}
              </Button>
            </Popconfirm>
            {status.cancellable && status.state !== 'applying' ? (
              <Button danger onClick={() => void cancel()} loading={action === 'cancel'}>取消下载</Button>
            ) : null}
          </Space>
        </>
      ) : null}
    </div>
  )
}
