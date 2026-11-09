import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  CalendarDays,
  BarChart3,
  Command,
  LayoutDashboard,
  LogOut,
  Map,
  Navigation,
  Settings2,
  ShieldCheck,
  Truck,
  Users,
  X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '../types/auth'
import { NotificationBell } from './NotificationBell'

type DashboardSidebarProps = {
  user: AuthUser
  activePage: 'dashboard' | 'agents' | 'dispatch' | 'admin' | 'customers' | 'liveFleet' | 'demandForecast' | 'anomalyDetection' | 'pod' | 'routeOptimization' | 'attendance'
  menuOpen: boolean
  onMenuClose: () => void
  onLogout: () => void
}

const initialsFor = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

export function DashboardSidebar({
  user,
  activePage,
  menuOpen,
  onMenuClose,
  onLogout,
}: DashboardSidebarProps) {
  const initials = initialsFor(user.name)

  return (
    <>
      {menuOpen && (
        <button
          aria-label="Close navigation"
          className="scrim"
          onClick={onMenuClose}
        />
      )}
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">
            <Command size={19} strokeWidth={2.4} />
          </div>
          <div className="brand-copy">
            <span className="brand-name">SWERV</span>
          </div>
          <button
            className="icon-button mobile-close"
            type="button"
            aria-label="Close menu"
            onClick={onMenuClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="workspace-brand">
          <div className="workspace-avatar">S</div>
          <div className="workspace-copy">
            <strong>SWERV Operations</strong>
            <span>Fleet operations workspace</span>
          </div>
          <NotificationBell recipientType="user" recipientId={user.id} isAdmin={user.role === 'admin'} />
        </div>

        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <Link
            to="/dashboard"
            className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <LayoutDashboard size={17} strokeWidth={1.8} />
            <span>Overview</span>
          </Link>
          <Link
            to="/live-fleet"
            className={`nav-item ${activePage === 'liveFleet' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <Map size={17} strokeWidth={1.8} />
            <span>Live fleet</span>
          </Link>
          <Link
            to="/dispatch-requests"
            className={`nav-item ${activePage === 'dispatch' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <Navigation size={17} strokeWidth={1.8} />
            <span>Dispatch</span>
          </Link>
          <Link
            to="/route-optimization"
            className={`nav-item ${activePage === 'routeOptimization' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <Navigation size={17} strokeWidth={1.8} />
            <span>Route optimization</span>
          </Link>
          <Link
            to="/agents"
            className={`nav-item ${activePage === 'agents' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <Truck size={17} strokeWidth={1.8} />
            <span>Fleet agents</span>
          </Link>
          <Link to="/agent-attendance" className={`nav-item ${activePage === 'attendance' ? 'active' : ''}`} onClick={onMenuClose}>
            <CalendarDays size={17} strokeWidth={1.8} />
            <span>Attendance</span>
          </Link>
          <Link
            to="/customers"
            className={`nav-item ${activePage === 'customers' ? 'active' : ''}`}
            onClick={onMenuClose}
          >
            <Users size={17} strokeWidth={1.8} />
            <span>Customers</span>
          </Link>
          {user.role === 'admin' && (
            <>
              <Link to="/admin/demand-forecasting" className={`nav-item ${activePage === 'demandForecast' ? 'active' : ''}`} onClick={onMenuClose}>
                <BarChart3 size={17} />
                <span>Demand forecasting</span>
              </Link>
              <Link to="/admin/anomaly-detection" className={`nav-item ${activePage === 'anomalyDetection' ? 'active' : ''}`} onClick={onMenuClose}>
                <AlertTriangle size={17} />
                <span>AI Anomaly Detection</span>
              </Link>
              <Link to="/admin/proof-of-delivery" className={`nav-item ${activePage === 'pod' ? 'active' : ''}`} onClick={onMenuClose}>
                <ClipboardCheck size={17} />
                <span>Proof of delivery</span>
              </Link>
              <Link to="/admin/users" className={`nav-item ${activePage === 'admin' ? 'active' : ''}`} onClick={onMenuClose}>
                <ShieldCheck size={17} />
                <span>User management</span>
              </Link>
            </>
          )}
        </nav>

        <div className="nav-spacer" />
        <div className="sidebar-help">
          <div className="help-icon">
            <Activity size={17} />
          </div>
          <div>
            <strong>Operations center</strong>
            <span>Workspace overview</span>
          </div>
        </div>
        <div className="nav-item nav-item-disabled settings" aria-disabled="true">
          <Settings2 size={17} />
          <span>Settings</span>
        </div>
        <div className="profile-row">
          <div className="profile-avatar">{initials}</div>
          <div className="profile-copy">
            <strong>{user.name}</strong>
            <span>{user.role === 'admin' ? 'Administrator' : 'Operator'}</span>
          </div>
          <button
            className="profile-logout"
            type="button"
            onClick={onLogout}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
    </>
  )
}
