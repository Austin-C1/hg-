import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import Settings from './Settings'
import { api } from '../services/api'

vi.mock('../services/api', () => ({
  api: {
    getTelegramSettings: vi.fn(async () => ({
      version: 1,
      oddsAlert: {
        enabled: true,
        botName: '赔率波动报警机器人',
        botTokenMasked: '1234****oken',
        hasBotToken: true,
        chatId: '10001',
        chatIds: ['10001'],
        parseMode: 'HTML',
        testMessage: 'hello',
      },
      betSuccess: {
        enabled: false,
        botName: '投注成功通知机器人',
        botTokenMasked: '',
        hasBotToken: false,
        chatId: '',
        chatIds: [],
        parseMode: 'HTML',
        testMessage: '',
      },
    })),
    updateTelegramSettings: vi.fn(async (payload) => ({
      version: 1,
      oddsAlert: {
        enabled: true,
        botName: '赔率波动报警机器人',
        botTokenMasked: '1234****oken',
        hasBotToken: true,
        chatId: '10001',
        chatIds: payload.oddsAlert?.chatIds || ['10001'],
        parseMode: 'HTML',
        testMessage: 'hello',
      },
      betSuccess: {
        enabled: false,
        botName: '投注成功通知机器人',
        botTokenMasked: '',
        hasBotToken: false,
        chatId: '',
        chatIds: [],
        parseMode: 'HTML',
        testMessage: '',
      },
    })),
    testTelegram: vi.fn(async () => ({ sent: true })),
    getTelegramChatIds: vi.fn(async () => ({ chatIds: ['10001', '-10002:88'] })),
  },
}))

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('shows multi chat id controls and fetch chat id actions', async () => {
    render(<Settings />)

    expect(await screen.findByText('赔率波动报警机器人')).toBeInTheDocument()
    expect(screen.getAllByLabelText('接收消息 Chat ID').length).toBe(2)
    expect(screen.getAllByRole('button', { name: '获取 Chat ID' }).length).toBe(2)
  })

  test('shows saved and unset field states instead of empty sensitive inputs', async () => {
    render(<Settings />)

    await screen.findByDisplayValue('1234****oken')

    expect(screen.getByDisplayValue('已保存')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('未设置，获取 Chat ID 后会填入这里')).toBeInTheDocument()
  })

  test('fetches Telegram chat ids and merges them into the textarea', async () => {
    render(<Settings />)

    await screen.findByDisplayValue('1234****oken')
    fireEvent.click(screen.getByRole('button', { name: /修\s*改/ }))
    const tokenInputs = await screen.findAllByPlaceholderText('已设置时留空不修改')
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(tokenInputs[0], '123456:secret-token')
    fireEvent.input(tokenInputs[0])
    fireEvent.change(tokenInputs[0])
    await waitFor(() => expect(tokenInputs[0]).toHaveValue('123456:secret-token'))
    fireEvent.click(screen.getAllByRole('button', { name: '获取 Chat ID' })[0])

    await waitFor(() => expect(api.getTelegramChatIds).toHaveBeenCalledWith({ type: 'oddsAlert', botToken: '123456:secret-token' }))
    expect(screen.getAllByLabelText('接收消息 Chat ID')[0]).toHaveValue('10001\n-10002:88')
  })

  test('fetches Telegram chat ids with the saved token when token input is empty', async () => {
    render(<Settings />)

    await screen.findByDisplayValue('1234****oken')
    fireEvent.click(screen.getAllByRole('button', { name: '获取 Chat ID' })[0])

    await waitFor(() => expect(api.getTelegramChatIds).toHaveBeenCalledWith({ type: 'oddsAlert' }))
    expect(screen.getAllByLabelText('接收消息 Chat ID')[0]).toHaveValue('10001\n-10002:88')
  })
})
