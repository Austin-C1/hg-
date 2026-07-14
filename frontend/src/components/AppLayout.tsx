import {
  BankOutlined,
  ControlOutlined,
  BarChartOutlined,
  MenuOutlined,
  ProfileOutlined,
  RobotOutlined,
  SettingOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Button, Drawer, Layout, Menu, Tag } from 'antd'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useMediaQuery } from 'react-responsive'

const { Sider, Content } = Layout

const items = [
  { key: '/operations', icon: <ControlOutlined />, label: '运行控制台' },
  { key: '/matches', icon: <UnorderedListOutlined />, label: '比赛选择' },
  { key: '/default-leagues', icon: <ProfileOutlined />, label: '默认联赛' },
  { key: '/monitor-account', icon: <UserOutlined />, label: '皇冠监控账号' },
  { key: '/monitor-alerts', icon: <SettingOutlined />, label: '监控报警' },
  { key: '/betting-rules', icon: <BarChartOutlined />, label: '投注规则' },
  { key: '/betting-accounts', icon: <BankOutlined />, label: '投注账号配置' },
  { key: '/settings', icon: <RobotOutlined />, label: '设置' },
]

function Brand() {
  return (
    <div className="app-brand">
      <span>皇冠抓水投注</span>
      <Tag color="blue">local</Tag>
    </div>
  )
}

export function AppLayout({ sessionControl }: { sessionControl?: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useMediaQuery({ maxWidth: 767 })
  const [open, setOpen] = useState(false)

  const selectedKey = items.some((item) => item.key === location.pathname) ? location.pathname : '/matches'
  const menu = (
    <Menu
      theme="dark"
      mode="inline"
      selectedKeys={[selectedKey]}
      items={items}
      onClick={({ key }) => {
        navigate(key)
        setOpen(false)
      }}
    />
  )

  return (
    <Layout className="app-shell">
      <Sider width={220} className="app-sider desktop-sider">
        <Brand />
        {menu}
      </Sider>
      <Layout>
        <div className="session-bar">{sessionControl}</div>
        {isMobile ? (
          <div className="mobile-header">
            <Button aria-label="打开导航菜单" icon={<MenuOutlined />} onClick={() => setOpen(true)} />
            <span>皇冠抓水投注</span>
            <Tag color="blue">local</Tag>
          </div>
        ) : null}
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
      <Drawer title={<Brand />} placement="left" open={open} onClose={() => setOpen(false)} width={260}>
        {menu}
      </Drawer>
    </Layout>
  )
}
