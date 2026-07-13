import { Button, Card, Form, Input, Select, Space, Switch, Tag, message } from 'antd'
import { useEffect, useState } from 'react'

import { api } from '../services/api'
import type { TelegramBotSettings, TelegramSettingsPayload } from '../types'

type BotType = 'oddsAlert' | 'betSuccess'

interface TelegramCardProps {
  type: BotType
  title: string
  data?: TelegramBotSettings
  onSaved: (next: TelegramSettingsPayload) => void
}

function TelegramCard({ type, title, data, onSaved }: TelegramCardProps) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [fetchingChatIds, setFetchingChatIds] = useState(false)
  const [editingToken, setEditingToken] = useState(false)

  useEffect(() => {
    if (!data) return
    form.setFieldsValue({
      ...data,
      botToken: '',
      chatIdsText: (data.chatIds || [data.chatId].filter(Boolean)).join('\n'),
    })
    setEditingToken(false)
  }, [data, form])

  async function save(values: Record<string, unknown>, forceClear = false) {
    setSaving(true)
    try {
      const botPayload: Record<string, unknown> = {
        ...values,
        chatIds: String(values.chatIdsText || '')
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean),
      }
      delete botPayload.chatIdsText
      if (!forceClear && !botPayload.botToken) delete botPayload.botToken
      const next = await api.updateTelegramSettings({ [type]: botPayload })
      onSaved(next)
      form.setFieldValue('botToken', '')
      setEditingToken(false)
      message.success('Telegram 配置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function fetchChatIds() {
    const botToken = String(form.getFieldValue('botToken') || '').trim()
    if (!botToken && !data?.hasBotToken) {
      message.warning('请先填写机器人 token，再获取 Chat ID')
      return
    }

    setFetchingChatIds(true)
    try {
      const result = await api.getTelegramChatIds({ type, ...(botToken ? { botToken } : {}) })
      const current = String(form.getFieldValue('chatIdsText') || '')
      const merged = Array.from(new Set([
        ...current.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        ...result.chatIds,
      ]))
      form.setFieldValue('chatIdsText', merged.join('\n'))
      message.success('Chat ID 已获取')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '获取失败')
    } finally {
      setFetchingChatIds(false)
    }
  }

  async function testMessage() {
    try {
      const result = await api.testTelegram(type)
      if (result.sent) message.success('测试消息已发送')
      else message.warning(`未发送：${result.reason || 'unknown'}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发送失败')
    }
  }

  async function clear() {
    setEditingToken(false)
    form.setFieldsValue({
      enabled: false,
      botName: title,
      botToken: '',
      chatIdsText: '',
      parseMode: 'HTML',
      testMessage: '',
    })
    await save(form.getFieldsValue(), true)
  }

  function editToken() {
    setEditingToken(true)
    form.setFieldValue('botToken', '')
  }

  const hasChatIds = Boolean((data?.chatIds || []).length || data?.chatId)

  return (
    <Card title={title} extra={<Tag color={data?.enabled ? 'green' : 'default'}>{data?.enabled ? '启用' : '关闭'}</Tag>} className="settings-card">
      <Form
        name={`${type}TelegramForm`}
        form={form}
        layout="vertical"
        onFinish={(values) => save(values)}
        initialValues={{
          enabled: false,
          botName: title,
          botToken: '',
          chatIdsText: '',
          parseMode: 'HTML',
          testMessage: '',
        }}
      >
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="botName" label="机器人名称"><Input /></Form.Item>
        <Form.Item label="当前 token">
          <Input value={data?.botTokenMasked || '未设置'} readOnly />
        </Form.Item>
        {data?.hasBotToken && !editingToken ? (
          <Form.Item label="机器人 token">
            <Space.Compact style={{ width: '100%' }}>
              <Input value="已保存" readOnly />
              <Button onClick={editToken}>修改</Button>
            </Space.Compact>
          </Form.Item>
        ) : (
          <Form.Item name="botToken" label="机器人 token">
            <Input
              type="password"
              placeholder={data?.hasBotToken ? '已设置时留空不修改' : '请输入机器人 token'}
              autoComplete="new-password"
              onInput={(event) => form.setFieldValue('botToken', (event.target as HTMLInputElement).value)}
            />
          </Form.Item>
        )}
        <Form.Item
          name="chatIdsText"
          label="接收消息 Chat ID"
          extra="多个 Chat ID 用换行或逗号分隔；群话题可写成 chatId:threadId。"
        >
          <Input.TextArea rows={3} placeholder={hasChatIds ? undefined : '未设置，获取 Chat ID 后会填入这里'} />
        </Form.Item>
        <Form.Item name="parseMode" label="解析格式">
          <Select options={[{ value: 'HTML', label: 'HTML' }, { value: 'Markdown', label: 'Markdown' }, { value: 'plain', label: '纯文本' }]} />
        </Form.Item>
        <Form.Item name="testMessage" label="测试消息"><Input.TextArea rows={3} /></Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
          <Button onClick={fetchChatIds} loading={fetchingChatIds}>获取 Chat ID</Button>
          <Button onClick={testMessage}>发送测试消息</Button>
          <Button danger onClick={clear}>清空</Button>
        </Space>
      </Form>
    </Card>
  )
}

export default function Settings() {
  const [settings, setSettings] = useState<TelegramSettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      setSettings(await api.getTelegramSettings())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h1>设置</h1>
          <p>Telegram 机器人配置独立保存，不混入投注账号。</p>
        </div>
      </div>

      <div className="settings-grid" aria-busy={loading}>
        <TelegramCard type="oddsAlert" title="赔率波动报警机器人" data={settings?.oddsAlert} onSaved={setSettings} />
        <TelegramCard type="betSuccess" title="投注成功通知机器人" data={settings?.betSuccess} onSaved={setSettings} />
      </div>
    </div>
  )
}
