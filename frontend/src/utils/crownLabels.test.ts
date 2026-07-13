import { describe, expect, test } from 'vitest'

import {
  labelAccountStatus,
  labelMarketType,
  labelMode,
  labelPeriod,
  labelSide,
  labelStatus,
} from './crownLabels'

describe('crownLabels', () => {
  test('maps Crown odds values to Chinese labels', () => {
    expect(labelMode('live')).toBe('滚球')
    expect(labelMode('prematch')).toBe('赛前')
    expect(labelStatus('not_started')).toBe('未开赛')
    expect(labelMarketType('asian_handicap')).toBe('让球')
    expect(labelMarketType('moneyline')).toBe('独赢')
    expect(labelMarketType('total')).toBe('大小球')
    expect(labelPeriod('first_half')).toBe('上半场')
    expect(labelPeriod('full_match')).toBe('全场')
    expect(labelSide('home')).toBe('主队')
    expect(labelSide('away')).toBe('客队')
    expect(labelSide('over')).toBe('大')
    expect(labelSide('under')).toBe('小')
  })

  test('maps account and fallback values without hiding unknown text', () => {
    expect(labelAccountStatus('disabled')).toBe('未启用')
    expect(labelAccountStatus('manual_review')).toBe('人工复核')
    expect(labelAccountStatus('future_preview')).toBe('未来预览')
    expect(labelMarketType('custom_market')).toBe('custom_market')
    expect(labelSide(null)).toBe('-')
  })
})
