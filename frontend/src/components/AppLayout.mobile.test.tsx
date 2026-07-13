import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'

vi.mock('react-responsive', () => ({ useMediaQuery: () => true }))

import { AppLayout } from './AppLayout'

describe('AppLayout mobile accessibility', () => {
  test('labels the icon-only navigation menu button', () => {
    render(<MemoryRouter><Routes><Route element={<AppLayout />}><Route index element={<div>content</div>} /></Route></Routes></MemoryRouter>)
    expect(screen.getByRole('button', { name: '打开导航菜单' })).toBeInTheDocument()
  })
})
