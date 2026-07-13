import { Alert, Button, Descriptions, Form, Input, InputNumber, Modal, Space, Switch, Tag, message } from 'antd'
import { useEffect, useRef, useState } from 'react'

import { api } from '../services/api'
import type { LoginResult, ManualLoginStatus, MonitorAccount } from '../types'
import { formatDateTime } from '../utils/formatDateTime'

const statusColors: Record<string, string> = {
  未启动: 'default',
  打开网站中: 'processing',
  填写账号密码中: 'processing',
  提交登录中: 'processing',
  等待人工验证码: 'warning',
  已登录: 'success',
  进入足球页面中: 'processing',
  正在监控赔率: 'success',
  'Welcome 页面': 'warning',
  登录失效: 'error',
  网络异常: 'error',
  'XML 无响应': 'error',
  赔率解析无数据: 'warning',
  自动重登中: 'processing',
  自动重登失败: 'error',
  需要人工处理: 'error',
  已停止: 'default',
}

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === '' ? '-' : value
}

function xmlVerificationText(result: LoginResult | null) {
  if (!result) return '-'
  if (result.xmlVerified) return '成功'
  if (result.sessionVerified) return '页面 session 已验证'
  return '未验证'
}

const manualLoginErrors: Record<string, string> = {
  'manual-login-unavailable': '当前版本无法使用内置 Chromium，请检查发行包是否完整',
  'manual-login-browser-open-failed': '无法打开内置 Chromium，请检查发行包后重试',
  'manual-login-busy': '已有人工登录窗口正在处理，请先完成或取消',
  'manual-login-account-not-found': '监控账号不存在，请先保存账号配置',
  'manual-login-account-binding-changed': '账号配置已变化，请重新打开人工登录',
  'manual-login-challenge-not-found': '本次人工登录已失效，请重新打开',
  'manual-login-challenge-expired': '本次人工登录已过期，请重新打开',
  'manual-login-challenge-state-invalid': '本次人工登录状态已变化，请重新打开',
  'manual-login-challenge-binding-mismatch': '本次人工登录已失效，请重新打开',
  'manual-login-verification-failed': '只读登录验证失败，请确认浏览器内已完成登录',
  'manual-login-session-evidence-missing': '未检测到完整登录结果，请在浏览器内完成登录后重试',
  'manual-login-security-violation': '登录页面离开了已配置的皇冠网站，本次登录已终止',
  'manual-login-controller-closing': '程序正在关闭，人工登录已停止',
  'manual-login-status-unavailable': '无法确认人工登录状态，请重新打开',
}

const unrecoverableChallengeErrors = new Set([
  'manual-login-account-binding-changed',
  'manual-login-challenge-not-found',
  'manual-login-challenge-expired',
  'manual-login-challenge-state-invalid',
  'manual-login-challenge-binding-mismatch',
  'manual-login-controller-closing',
])

function manualLoginErrorCode(error: unknown) {
  return error instanceof Error && /^manual-login-[a-z0-9-]+$/.test(error.message)
    ? error.message
    : ''
}

function manualLoginErrorText(error: unknown) {
  const code = manualLoginErrorCode(error)
  return manualLoginErrors[code] || '人工登录操作失败，请重试'
}

function manualLoginMessage(status: ManualLoginStatus) {
  if (status.status === 'opening') return '正在打开内置 Chromium'
  if (status.status === 'awaiting-user') return '等待您在内置 Chromium 中完成登录'
  if (status.status === 'verifying') return '正在进行只读登录验证'
  if (status.status === 'verified') return '人工登录验证完成'
  if (status.errorCode === 'manual-login-cancelled') return '已取消本次人工登录'
  return manualLoginErrors[status.errorCode] || '人工登录未完成，请重新打开'
}

export default function CrownMonitorAccount() {
  const [account, setAccount] = useState<MonitorAccount | null>(null)
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [editingSecret, setEditingSecret] = useState(false)
  const [manualLogin, setManualLogin] = useState<ManualLoginStatus | null>(null)
  const [manualLoginError, setManualLoginError] = useState('')
  const [manualActionLoading, setManualActionLoading] = useState<'open' | 'confirm' | 'cancel' | null>(null)
  const manualRequests = useRef(new Set<AbortController>())
  const manualActionInFlight = useRef(false)
  const [form] = Form.useForm<MonitorAccount & { secret?: string }>()

  function beginManualRequest() {
    const controller = new AbortController()
    manualRequests.current.add(controller)
    return controller
  }

  function finishManualRequest(controller: AbortController) {
    manualRequests.current.delete(controller)
  }

  function beginManualAction(action: 'open' | 'confirm' | 'cancel') {
    if (manualActionInFlight.current) return null
    manualActionInFlight.current = true
    setManualActionLoading(action)
    return beginManualRequest()
  }

  function finishManualAction(controller: AbortController) {
    finishManualRequest(controller)
    manualActionInFlight.current = false
    if (!controller.signal.aborted) setManualActionLoading(null)
  }

  function handleUnrecoverableChallenge(error: unknown) {
    const code = manualLoginErrorCode(error)
    if (!unrecoverableChallengeErrors.has(code)) return false
    setManualLogin((current) => current ? { ...current, status: 'failed', errorCode: code } : current)
    setManualLoginError('')
    return true
  }

  function syncForm(next: MonitorAccount) {
    form.setFieldsValue({
      id: next.id,
      label: next.label,
      username: next.username,
      loginUrl: next.loginUrl,
      enabled: next.enabled,
      status: next.status,
      notes: next.notes,
      secret: '',
      maxAutoReloginCount: next.maxAutoReloginCount ?? 3,
      oddsScanIntervalSeconds: next.oddsScanIntervalSeconds || 10,
      autoReloginCount: next.autoReloginCount || 0,
    })
    setEditingSecret(false)
  }

  async function load(options: { showLoading?: boolean; syncFormToAccount?: boolean } = {}) {
    const { showLoading = true, syncFormToAccount = true } = options
    if (showLoading) setLoading(true)
    try {
      const payload = await api.getMonitorAccount()
      setAccount(payload.item)
      setLoginResult(payload.item.lastLoginResult)
      if (syncFormToAccount) syncForm(payload.item)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load({ showLoading: false, syncFormToAccount: false })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => {
    for (const controller of manualRequests.current) controller.abort()
    manualRequests.current.clear()
  }, [])

  useEffect(() => {
    if (!account || !manualLogin || manualActionLoading
      || !['opening', 'awaiting-user', 'verifying'].includes(manualLogin.status)) return
    const controller = beginManualRequest()
    let timer: number | undefined
    let failures = 0
    const poll = async () => {
      try {
        const next = await api.getManualLoginStatus(account.id, manualLogin.challengeId, controller.signal)
        if (controller.signal.aborted) return
        failures = 0
        setManualLoginError('')
        setManualLogin(next)
        if (['opening', 'awaiting-user', 'verifying'].includes(next.status)) {
          timer = window.setTimeout(poll, 1500)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (handleUnrecoverableChallenge(error)) return
        failures += 1
        if (failures < 3) {
          setManualLoginError(`状态查询暂时失败，正在重试（${failures}/3）`)
          timer = window.setTimeout(poll, 1500)
          return
        }
        setManualLoginError('')
        setManualLogin((current) => current
          ? { ...current, status: 'failed', errorCode: 'manual-login-status-unavailable' }
          : current)
      }
    }
    void poll()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      controller.abort()
      finishManualRequest(controller)
    }
  }, [account?.id, manualLogin?.challengeId, manualLogin?.status, manualActionLoading])

  async function save(values: Partial<MonitorAccount> & { secret?: string }) {
    setSaving(true)
    try {
      const payload = { ...values }
      if (!payload.secret) delete payload.secret
      payload.status = payload.enabled ? 'enabled' : 'disabled'
      const next = await api.saveMonitorAccount(payload)
      setAccount(next.item)
      syncForm(next.item)
      message.success('监控账号已保存')
    } catch (error) {
      const text = error instanceof Error ? error.message : '保存失败'
      message.error(text)
    } finally {
      setSaving(false)
    }
  }

  async function runAction(action: 'test-login' | 'start' | 'stop' | 'relogin' | 'clear-state') {
    setActionLoading(action)
    try {
      const next = await api.monitorAccountAction(action)
      setAccount(next.item)
      setLoginResult(next.loginResult ?? next.item.lastLoginResult)
      syncForm(next.item)
      message.success('状态已更新')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setActionLoading(null)
    }
  }

  const currentStatus = account?.currentMonitorStatus || '未启动'
  const loginStatus = account?.loginStatus || '未启动'
  const latestLoginResult = loginResult ?? account?.lastLoginResult ?? null
  const diagnosticPath = latestLoginResult?.diagnosticPath || account?.lastLoginDiagnosticsPath || ''

  async function viewDiagnostics() {
    setDiagnosticsOpen(true)
    setDiagnosticsLoading(true)
    try {
      const payload = await api.getLoginDiagnostics()
      setDiagnostics(payload.item)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取诊断失败')
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  function editSecret() {
    setEditingSecret(true)
    form.setFieldValue('secret', '')
  }

  async function openManualLogin() {
    if (!account) return
    const controller = beginManualAction('open')
    if (!controller) return
    setManualLoginError('')
    try {
      setManualLogin(await api.openManualLogin(account.id, controller.signal))
    } catch (error) {
      if (!controller.signal.aborted) setManualLoginError(manualLoginErrorText(error))
    } finally {
      finishManualAction(controller)
    }
  }

  async function confirmManualLogin() {
    if (!account || !manualLogin) return
    const controller = beginManualAction('confirm')
    if (!controller) return
    setManualLoginError('')
    try {
      setManualLogin(await api.confirmManualLogin(account.id, manualLogin.challengeId, controller.signal))
    } catch (error) {
      if (!controller.signal.aborted && !handleUnrecoverableChallenge(error)) {
        setManualLoginError(manualLoginErrorText(error))
      }
    } finally {
      finishManualAction(controller)
    }
  }

  async function cancelManualLogin() {
    if (!account || !manualLogin) return
    const controller = beginManualAction('cancel')
    if (!controller) return
    setManualLoginError('')
    try {
      setManualLogin(await api.cancelManualLogin(account.id, manualLogin.challengeId, controller.signal))
    } catch (error) {
      if (!controller.signal.aborted && !handleUnrecoverableChallenge(error)) {
        setManualLoginError(manualLoginErrorText(error))
      }
    } finally {
      finishManualAction(controller)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h1>皇冠监控账号</h1>
          <p>第一版只启用一个皇冠赔率监控账号位置，自动登录和重登由 crown-watch 执行。</p>
        </div>
        <Tag color={account?.enabled ? 'green' : 'default'}>{account?.enabled ? '已启用' : '未启用'}</Tag>
      </div>

      <Alert
        type={currentStatus === '等待人工验证码' || currentStatus === '需要人工处理' ? 'warning' : 'info'}
        showIcon
        message={`当前监控状态：${currentStatus}`}
        description="遇到验证码、滑块或二次验证时，程序只暂停并等待人工处理，不会尝试绕过。"
      />

      <div className="panel">
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          initialValues={{ enabled: false, oddsScanIntervalSeconds: 10, autoReloginCount: 0, maxAutoReloginCount: 3 }}
        >
          <div className="form-grid">
            <Form.Item name="loginUrl" label="网站地址" rules={[{ required: true, message: '请输入皇冠网站地址' }]}><Input placeholder="https://..." /></Form.Item>
            <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input autoComplete="username" /></Form.Item>
            {account?.hasSecret && !editingSecret ? (
              <Form.Item label="密码">
                <Space.Compact style={{ width: '100%' }}>
                  <Input value="已保存" readOnly />
                  <Button onClick={editSecret}>修改</Button>
                </Space.Compact>
              </Form.Item>
            ) : (
              <Form.Item name="secret" label="密码"><Input.Password placeholder={account?.hasSecret ? '输入新密码' : '请输入密码'} autoComplete="new-password" /></Form.Item>
            )}
            <Form.Item name="label" label="账号备注 / 名称"><Input /></Form.Item>
            <Form.Item name="enabled" label="是否启用" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="oddsScanIntervalSeconds" label="赔率扫描间隔秒数"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="autoReloginCount" label="自动重登次数"><InputNumber min={0} style={{ width: '100%' }} disabled /></Form.Item>
            <Form.Item name="maxAutoReloginCount" label="最大自动重登次数"><InputNumber min={0} max={10} style={{ width: '100%' }} /></Form.Item>
          </div>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={saving}>保存账号</Button>
            <Button loading={actionLoading === 'test-login'} onClick={() => runAction('test-login')}>测试登录</Button>
            <Button type="primary" loading={actionLoading === 'start'} onClick={() => runAction('start')}>开始监控</Button>
            <Button loading={actionLoading === 'stop'} onClick={() => runAction('stop')}>停止监控</Button>
            <Button loading={actionLoading === 'relogin'} onClick={() => runAction('relogin')}>手动重新登录</Button>
            <Button danger loading={actionLoading === 'clear-state'} onClick={() => runAction('clear-state')}>清除状态</Button>
          </Space>
        </Form>
      </div>

      <div className="panel">
        <div className="section-header">
          <div>
            <h2>皇冠人工登录</h2>
            <p>使用发行包内置 Chromium；验证码、滑块或 OTP 必须由您本人在浏览器中处理。</p>
          </div>
          {manualLogin && <Tag>{manualLogin.status}</Tag>}
        </div>
        {manualLoginError && (
          <Alert type="error" showIcon message={manualLoginError} style={{ marginBottom: 12 }} />
        )}
        {manualLogin ? (
          <>
            <Alert
              type={manualLogin.status === 'verified' ? 'success'
                : manualLogin.status === 'failed' ? 'warning' : 'info'}
              showIcon
              message={manualLoginMessage(manualLogin)}
              description={manualLogin.status === 'verified'
                ? 'Session 已通过只读验证。Watcher 保持停止，如需监控请另行点击“开始监控”。'
                : '请只在内置 Chromium 中自行完成账号登录、验证码、滑块或 OTP；程序不会尝试绕过。'}
            />
            <Space wrap style={{ marginTop: 12 }}>
              {manualLogin.status === 'awaiting-user' && (
                <Button type="primary" disabled={manualActionLoading !== null} loading={manualActionLoading === 'confirm'} onClick={confirmManualLogin}>
                  我已完成登录，开始验证
                </Button>
              )}
              {['opening', 'awaiting-user', 'verifying'].includes(manualLogin.status) && (
                <Button disabled={manualActionLoading !== null} loading={manualActionLoading === 'cancel'} onClick={cancelManualLogin}>取消人工登录</Button>
              )}
              {['verified', 'failed'].includes(manualLogin.status) && (
                <Button disabled={manualActionLoading !== null} loading={manualActionLoading === 'open'} onClick={openManualLogin}>重新打开人工登录</Button>
              )}
            </Space>
          </>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              message="需要人工验证时，在内置 Chromium 中完成登录"
              description="打开后请自行处理验证码、滑块或 OTP，完成后返回本页确认验证。"
            />
            <Button
              type="primary"
              style={{ marginTop: 12 }}
              disabled={!account || manualActionLoading !== null}
              loading={manualActionLoading === 'open'}
              onClick={openManualLogin}
            >
              打开皇冠人工登录
            </Button>
          </>
        )}
      </div>

      <div className="panel">
        <Descriptions bordered column={{ xs: 1, sm: 2, lg: 3 }} size="small">
          <Descriptions.Item label="当前登录状态"><Tag color={statusColors[loginStatus] || 'default'}>{loginStatus}</Tag></Descriptions.Item>
          <Descriptions.Item label="当前监控状态"><Tag color={statusColors[currentStatus] || 'default'}>{currentStatus}</Tag></Descriptions.Item>
          <Descriptions.Item label="最近登录时间">{valueOrDash(account?.lastLoginAt)}</Descriptions.Item>
          <Descriptions.Item label="最近在线检测时间">{valueOrDash(account?.lastOnlineCheckAt)}</Descriptions.Item>
          <Descriptions.Item label="最近一次 XML 响应时间">{valueOrDash(account?.lastXmlResponseAt)}</Descriptions.Item>
          <Descriptions.Item label="最近一次成功解析赔率时间">{valueOrDash(account?.lastOddsParsedAt)}</Descriptions.Item>
          <Descriptions.Item label="连续失败次数">{account?.consecutiveFailures ?? 0}</Descriptions.Item>
          <Descriptions.Item label="自动重登次数">{account?.autoReloginCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="最大自动重登次数">{account?.maxAutoReloginCount ?? 3}</Descriptions.Item>
          <Descriptions.Item label="密码状态">{account?.hasSecret ? '已保存' : '未保存'}</Descriptions.Item>
          <Descriptions.Item label="最近保存时间">{valueOrDash(account?.updatedAt)}</Descriptions.Item>
          <Descriptions.Item label="加载状态">{loading ? '读取中' : '已读取'}</Descriptions.Item>
        </Descriptions>
      </div>

      <div className="panel">
        <div className="section-header">
          <div>
            <h2>测试登录结果</h2>
          </div>
          <Button disabled={!diagnosticPath} loading={diagnosticsLoading} onClick={viewDiagnostics}>查看诊断</Button>
        </div>
        {latestLoginResult ? (
          <>
            <Space wrap>
              <Tag color={latestLoginResult.ok ? 'green' : 'red'}>{`登录结果：${latestLoginResult.status}`}</Tag>
              <Tag color="blue">{`登录方式：${latestLoginResult.loginMethod || '-'}`}</Tag>
              <Tag>{`cookies：${latestLoginResult.cookieStatus || '-'}`}</Tag>
              <Tag>{`storageState：${latestLoginResult.storageStateStatus || '-'}`}</Tag>
              <Tag color={latestLoginResult.xmlVerified ? 'green' : 'default'}>{`XML 验证：${xmlVerificationText(latestLoginResult)}`}</Tag>
            </Space>
            <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small" style={{ marginTop: 12 }}>
              <Descriptions.Item label="诊断文件">{valueOrDash(diagnosticPath)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{formatDateTime(latestLoginResult.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{formatDateTime(latestLoginResult.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label="消息">{valueOrDash(latestLoginResult.message)}</Descriptions.Item>
            </Descriptions>
          </>
        ) : (
          <Alert type="info" showIcon message="还没有测试登录结果" />
        )}
      </div>

      <Modal title="登录诊断" open={diagnosticsOpen} onCancel={() => setDiagnosticsOpen(false)} footer={null} width={860}>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 520, overflow: 'auto' }}>
          {diagnostics ? JSON.stringify(diagnostics, null, 2) : (diagnosticsLoading ? '读取中' : '暂无诊断')}
        </pre>
      </Modal>
    </div>
  )
}
