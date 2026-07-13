import zhCN from 'antd/locale/zh_CN'
import { Alert, Button, ConfigProvider, Input, Modal, Space, Spin, Tag } from 'antd'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import { api, DASHBOARD_AUTH_EXPIRED_EVENT } from './services/api'

const MatchSelection = lazy(() => import('./pages/MatchSelection'))
const DefaultLeagues = lazy(() => import('./pages/DefaultLeagues'))
const CrownMonitorAccount = lazy(() => import('./pages/CrownMonitorAccount'))
const MonitorSettings = lazy(() => import('./pages/MonitorSettings'))
const AutoBetRules = lazy(() => import('./pages/AutoBetRules'))
const BettingAccounts = lazy(() => import('./pages/BettingAccounts'))
const OperationsConsole = lazy(() => import('./pages/OperationsConsole'))
const Settings = lazy(() => import('./pages/Settings'))
const SystemUpdate = lazy(() => import('./pages/SystemUpdate'))

function DashboardSessionControl() {
  const [authenticated, setAuthenticated] = useState(false)
  const [accessMode, setAccessMode] = useState<'local-trust' | 'password-session' | 'readonly'>('readonly')
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const payload = await api.sessionBootstrap()
      const next = Boolean(payload.csrfToken)
      setAuthenticated(next)
      setAccessMode(payload.dashboardAccessMode || (next ? 'password-session' : 'readonly'))
      return next
    } catch {
      setAuthenticated(false)
      setAccessMode('readonly')
      return false
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const expireSession = () => {
      setAuthenticated(false)
      setAccessMode('readonly')
      setErrorMessage('请先登录 Dashboard 后再继续操作。')
      setOpen(true)
    }
    window.addEventListener(DASHBOARD_AUTH_EXPIRED_EVENT, expireSession)
    return () => window.removeEventListener(DASHBOARD_AUTH_EXPIRED_EVENT, expireSession)
  }, [])

  const close = () => {
    setOpen(false)
    setPassword('')
    setErrorMessage('')
  }

  const submit = async () => {
    if (!password || submitting) return
    setSubmitting(true)
    setErrorMessage('')
    try {
      await api.login(password)
      if (!await refresh()) throw new Error('authentication-required')
      close()
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Dashboard 登录失败'
      setErrorMessage(text === 'dashboard-security-not-configured'
        ? 'Dashboard 登录密码尚未配置，请先在本机环境中设置。'
        : text)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Space size="small">
        <Tag color={authenticated ? 'green' : 'default'}>
          {accessMode === 'local-trust'
            ? 'Dashboard 本机免密'
            : (authenticated ? 'Dashboard 已登录' : 'Dashboard 未登录')}
        </Tag>
        {!authenticated ? <Button size="small" onClick={() => setOpen(true)}>Dashboard 登录</Button> : null}
      </Space>
      <Modal
        title="Dashboard 登录"
        open={open}
        okText="确认登录"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={submit}
        onCancel={close}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {errorMessage ? <Alert type="error" message={errorMessage} showIcon /> : null}
          <Input.Password
            aria-label="Dashboard 密码"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onPressEnter={submit}
          />
        </Space>
      </Modal>
    </>
  )
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 8 } }}>
      <Router>
        <Routes>
          <Route element={<AppLayout sessionControl={<DashboardSessionControl />} />}>
            <Route index element={<Navigate to="/matches" replace />} />
            <Route path="/matches" element={<Suspense fallback={<Spin />}><MatchSelection /></Suspense>} />
            <Route path="/default-leagues" element={<Suspense fallback={<Spin />}><DefaultLeagues /></Suspense>} />
            <Route path="/monitor-account" element={<Suspense fallback={<Spin />}><CrownMonitorAccount /></Suspense>} />
            <Route path="/monitor-alerts" element={<Suspense fallback={<Spin />}><MonitorSettings /></Suspense>} />
            <Route path="/monitor-settings" element={<Navigate to="/monitor-alerts" replace />} />
            <Route path="/betting-rules" element={<Suspense fallback={<Spin />}><AutoBetRules /></Suspense>} />
            <Route path="/auto-bet-rules" element={<Navigate to="/betting-rules" replace />} />
            <Route path="/betting-accounts" element={<Suspense fallback={<Spin />}><BettingAccounts /></Suspense>} />
            <Route path="/operations" element={<Suspense fallback={<Spin />}><OperationsConsole /></Suspense>} />
            <Route path="/settings" element={<Suspense fallback={<Spin />}><Settings /></Suspense>} />
            <Route path="/system-update" element={<Suspense fallback={<Spin />}><SystemUpdate /></Suspense>} />
            <Route path="*" element={<Navigate to="/matches" replace />} />
          </Route>
        </Routes>
      </Router>
    </ConfigProvider>
  )
}
