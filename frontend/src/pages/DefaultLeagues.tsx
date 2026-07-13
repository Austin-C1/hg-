import { Button, Checkbox, Form, Input, Modal, Space, Switch, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState } from 'react'

import { api } from '../services/api'
import type { DefaultLeagueRule, DefaultLeagueStatus, DefaultLeagueOverview } from '../types'

function modeText(mode: string) {
  if (mode === 'live') return '滚球'
  if (mode === 'prematch') return '赛前'
  return '未知'
}

function statusText(status: string) {
  if (status === 'hit') return '已命中'
  if (status === 'disabled') return '已停用'
  if (status === 'mode_disabled') return '模式未启用'
  return '未出现'
}

function statusColor(status: string) {
  if (status === 'hit') return 'green'
  if (status === 'disabled') return 'default'
  if (status === 'mode_disabled') return 'orange'
  return 'red'
}

export default function DefaultLeagues() {
  const [payload, setPayload] = useState<DefaultLeagueOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<DefaultLeagueRule | null>(null)
  const [form] = Form.useForm<DefaultLeagueRule>()

  async function load() {
    setLoading(true)
    try {
      setPayload(await api.getDefaultLeagues())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function saveConfig(config: DefaultLeagueOverview['config']) {
    const next = await api.updateDefaultLeagues(config)
    setPayload(next)
  }

  async function saveRule(values: DefaultLeagueRule) {
    if (!payload) return
    const rule: DefaultLeagueRule = {
      name: values.name.trim(),
      aliases: [],
      enabled: values.enabled ?? true,
      autoTrack: values.autoTrack ?? true,
      modes: values.modes?.length ? values.modes : ['prematch', 'live'],
    }
    const exists = payload.config.leagues.some((item) => item.name === editing?.name)
    const leagues = exists
      ? payload.config.leagues.map((item) => item.name === editing?.name ? rule : item)
      : [...payload.config.leagues, rule]
    await saveConfig({ ...payload.config, leagues })
    message.success('默认联赛已保存')
    setOpen(false)
    setEditing(null)
    form.resetFields()
  }

  async function toggle(row: DefaultLeagueStatus) {
    if (!payload) return
    await saveConfig({
      ...payload.config,
      leagues: payload.config.leagues.map((item) => item.name === row.name ? { ...item, enabled: !item.enabled, aliases: [] } : item),
    })
  }

  async function remove(row: DefaultLeagueStatus) {
    if (!payload) return
    await saveConfig({
      ...payload.config,
      leagues: payload.config.leagues.filter((item) => item.name !== row.name),
    })
  }

  function edit(row: DefaultLeagueRule | null) {
    setEditing(row)
    form.setFieldsValue(row || { name: '', aliases: [], enabled: true, autoTrack: true, modes: ['prematch', 'live'] })
    setOpen(true)
  }

  const stats = payload?.stats || { configuredCount: 0, hitCount: 0, missingCount: 0, disabledCount: 0 }
  const columns: ColumnsType<DefaultLeagueStatus> = [
    { title: '皇冠内部联赛名', dataIndex: 'name', minWidth: 260 },
    { title: '模式', dataIndex: 'modes', width: 150, render: (modes: string[]) => modes.map((mode) => <Tag key={mode}>{modeText(mode)}</Tag>) },
    { title: '自动追踪', dataIndex: 'autoTrack', width: 100, render: (value) => value ? '开' : '关' },
    { title: '状态', dataIndex: 'status', width: 120, render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    { title: '命中比赛', dataIndex: 'hitCount', width: 100 },
    { title: '当前匹配名', dataIndex: 'matchedLeagues', render: (items: string[]) => items?.length ? items.join(' / ') : '-' },
    {
      title: '操作',
      width: 230,
      render: (_, row) => (
        <Space>
          <Button onClick={() => toggle(row)}>{row.enabled ? '停用' : '启用'}</Button>
          <Button onClick={() => edit(row)}>编辑</Button>
          <Button danger onClick={() => remove(row)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h1>默认联赛</h1>
          <p>只按填写的皇冠内部联赛名字精确匹配，不使用别名和模糊搜索。</p>
        </div>
        <Button type="primary" onClick={() => edit(null)}>新增联赛</Button>
      </div>

      <div className="kpi-grid compact">
        <div className="kpi"><span>已配置</span><strong>{stats.configuredCount}</strong></div>
        <div className="kpi"><span>当前命中</span><strong>{stats.hitCount}</strong></div>
        <div className="kpi"><span>当前未出现</span><strong>{stats.missingCount}</strong></div>
        <div className="kpi"><span>已停用</span><strong>{stats.disabledCount}</strong></div>
      </div>

      <div className="panel">
        <Table rowKey="name" loading={loading} columns={columns} dataSource={payload?.items || []} pagination={false} scroll={{ x: 1100 }} />
      </div>

      <Modal title={editing ? '编辑默认联赛' : '新增默认联赛'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={saveRule}>
          <Form.Item name="name" label="皇冠内部联赛名" rules={[{ required: true, message: '请输入皇冠内部联赛名' }]}><Input /></Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="autoTrack" label="命中后自动追踪今日比赛" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="modes" label="监控模式">
            <Checkbox.Group options={[{ value: 'prematch', label: '赛前' }, { value: 'live', label: '滚球' }]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
