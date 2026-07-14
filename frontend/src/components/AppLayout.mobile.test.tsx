import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'

vi.mock('react-responsive', () => ({ useMediaQuery: () => true }))

import { AppLayout } from './AppLayout'

describe('AppLayout mobile accessibility', () => {
  test('labels the icon-only navigation menu button', () => {
    render(<MemoryRouter><Routes><Route element={<AppLayout />}><Route index element={<div>content</div>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('button', { name: '打开导航菜单' })).toBeInTheDocument()
  })

  test('does not expose the retired system update page in the mobile drawer', () => {
    render(<MemoryRouter><Routes><Route element={<AppLayout />}><Route index element={<div>content</div>} /></Route></Routes></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: '打开导航菜单' }))
    expect(screen.queryByText('系统更新')).not.toBeInTheDocument()
  })
})
