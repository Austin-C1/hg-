import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import BrowserBettingPanel from './BrowserBettingPanel'
import { browserBettingSummary } from '../test/browserBettingFixture'

describe('BrowserBettingPanel', () => {
  test('does not present missing Submit or Reconciliation evidence as a current direction blocker', () => {
    const { container } = render(<BrowserBettingPanel summary={browserBettingSummary} />)

    expect(container.querySelectorAll('.browser-blocked-reason')).toHaveLength(0)
  })

  test('shows the browser transport, protocol version, eight direction matrix, sessions and campaign recovery state', () => {
    render(<BrowserBettingPanel summary={{
      ...browserBettingSummary,
      directions: browserBettingSummary.directions.map((direction, index) => {
        if (index === 2) return { ...direction, blockedReason: 'crown-capability-version-mismatch' }
        if (index === 3) return { ...direction, blockedReason: 'crown-new-safe-reason' }
        return direction
      }),
    }} />)

    expect(screen.getByRole('heading', { name: '浏览器内 API' })).toBeInTheDocument()
    expect(screen.getByText('crown-protocol-capabilities-v2:test-safe')).toBeInTheDocument()
    const matrix = screen.getByRole('list', { name: '八方向能力矩阵' })
    expect(within(matrix).getAllByRole('listitem')).toHaveLength(8)
    expect(within(matrix).getByText('赛前 · 让球 · 主')).toBeInTheDocument()
    expect(within(matrix).getByText('滚球 · 大小球 · 小')).toBeInTheDocument()
    expect(screen.getAllByText('Submit 证据未固化')).not.toHaveLength(0)
    expect(screen.queryByText('阻断原因：Submit 缺少直接 accepted 证据')).not.toBeInTheDocument()
    expect(screen.queryByText('阻断原因：Reconciliation 缺少结果查询证据')).not.toBeInTheDocument()
    expect(screen.getByText('阻断原因：Capability drift（能力版本不一致）')).toBeInTheDocument()
    const unknownReasonDirection = within(matrix).getByText('赛前 · 大小球 · 小').closest('li')
    expect(unknownReasonDirection).not.toBeNull()
    expect(within(unknownReasonDirection!).getByText('阻断原因：crown-new-safe-reason')).toBeInTheDocument()
    expect(screen.getByText('会话已过期，已阻断')).toBeInTheDocument()
    expect(screen.getByText('Generation 12')).toBeInTheDocument()
    expect(screen.getByText('已接受 1 / 8')).toBeInTheDocument()
    expect(screen.getByText('队列 2 · 在途 1')).toBeInTheDocument()
    expect(screen.getByText('terminal unknown，验收已停止')).toBeInTheDocument()
    expect(screen.queryByText(/cookie|password|uid|token|profile|context/i)).not.toBeInTheDocument()
  })

  test('renders a calm inactive campaign state without inventing progress', () => {
    render(<BrowserBettingPanel summary={{ ...browserBettingSummary, sessions: [], campaign: null }} />)
    expect(screen.getByText('当前没有验收 campaign')).toBeInTheDocument()
    expect(screen.queryByText(/已接受 \d/)).not.toBeInTheDocument()
  })
})
