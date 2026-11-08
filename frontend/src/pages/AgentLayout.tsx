import { useState } from 'react'
import { Clock3, Command, LayoutDashboard, LogOut, PackageCheck, Truck } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { useAgentGpsTracking } from '../hooks/useAgentGpsTracking'
import { AgentGpsContext } from '../context/agent-gps-context'
import { formatAgentStatus } from '../lib/agentUi'
import './agent-portal.css'

const navigation = [
  { to: '/agent/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/agent/deliveries', label: 'My deliveries', icon: PackageCheck, end: false },
  { to: '/agent/history', label: 'History', icon: Clock3, end: true },
]

export function AgentLayout() {
  const { agent, logout } = useAgentAuth()
  const gpsTracking = useAgentGpsTracking()
  const navigate = useNavigate()
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleLogout() {
    if (isSigningOut) return
    setIsSigningOut(true)
    try {
      await gpsTracking.stopTracking()
      await logout()
    } catch {
      // The local agent session clears even when the API cannot be reached.
    } finally {
      navigate('/agent/login', { replace: true })
    }
  }

  if (!agent) return null
  const initials = agent.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  return (
    <AgentGpsContext.Provider value={gpsTracking}>
    <div className="agent-app-shell">
      <aside className="agent-sidebar">
        <NavLink to="/agent/dashboard" className="agent-brand" aria-label="SWERV agent home">
          <span className="agent-brand-mark"><Command size={18} /></span>
          <span><strong>SWERV</strong><small>Agent portal</small></span>
        </NavLink>
        <div className="agent-profile-card">
          <span className="agent-profile-avatar">{initials}</span>
          <span className="agent-profile-copy"><strong>{agent.name}</strong><small>{agent.agentCode}</small></span>
          <span className={`agent-status-dot status-${agent.status}`} aria-label={formatAgentStatus(agent.status)} />
        </div>
        <p className="agent-nav-label">YOUR WORK</p>
        <nav className="agent-navigation" aria-label="Agent navigation">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `agent-nav-link${isActive ? ' active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="agent-sidebar-bottom">
          <div className="agent-duty-note"><span><Truck size={16} /></span><div><strong>Stay on the move</strong><small>Keep delivery status up to date.</small></div></div>
          <button className="agent-sidebar-logout" type="button" onClick={() => void handleLogout()} disabled={isSigningOut}>
            <LogOut size={16} /> {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>

      <div className="agent-main-column">
        <header className="agent-topbar">
          <div className="agent-mobile-brand"><span className="agent-brand-mark"><Command size={17} /></span><strong>SWERV</strong></div>
          <div className="agent-topbar-context"><span className="agent-live-indicator" /> Delivery workspace <span className="agent-topbar-divider">/</span> {agent.agentCode}</div>
          <div className="agent-topbar-right"><span className={`agent-status-pill status-${agent.status}`}><i />{formatAgentStatus(agent.status)}</span><button className="agent-mobile-logout" type="button" onClick={() => void handleLogout()} aria-label="Sign out"><LogOut size={17} /></button><span className="agent-top-avatar">{initials}</span></div>
        </header>
        <main className="agent-page-content"><Outlet /></main>
        <footer className="agent-footer"><span>SWERV</span><span>Deliver with care</span></footer>
      </div>

      <nav className="agent-mobile-nav" aria-label="Agent navigation">
        {navigation.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `agent-mobile-nav-link${isActive ? ' active' : ''}`}>
            <Icon size={19} strokeWidth={1.9} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
    </AgentGpsContext.Provider>
  )
}
