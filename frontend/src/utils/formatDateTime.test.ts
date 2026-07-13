import { describe, expect, test } from 'vitest'

import { formatDateTime } from './formatDateTime'

describe('formatDateTime', () => {
  test('formats stored UTC timestamps as Asia/Shanghai time', () => {
    expect(formatDateTime('2026-07-10T10:04:00.000Z')).toBe('2026-07-10 18:04:00')
  })
})
