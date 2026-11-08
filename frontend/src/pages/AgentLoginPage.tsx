import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, PackageCheck, ShieldCheck } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AuthFrame } from './components/AuthFrame'
import { PortalSelector } from '../components/PortalSelector'
import { useAgentAuth } from '../hooks/useAgentAuth'
import '../App.css'
import './agent-portal.css'

type AgentLoginLocationState = { from?: string }

export function AgentLoginPage() {
  const { login, loadError } = useAgentAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const locationState = location.state as AgentLoginLocationState | null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(loadError)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      await login(email.trim(), password)
      const destination = locationState?.from?.startsWith('/agent/')
        ? locationState.from
        : '/agent/dashboard'
      navigate(destination, { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="AGENT DELIVERY PORTAL"
      title="Welcome back"
      description="Sign in to view your assigned deliveries and update their progress."
    >
      <PortalSelector selectedPortal="agent" />
      <div className="agent-login-badge"><PackageCheck size={17} /><span>Delivery agent access</span></div>
      <form className="auth-form" onSubmit={handleSubmit}>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <label htmlFor="agent-login-email">Email address</label>
        <input
          id="agent-login-email"
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
        />
        <div className="password-label-row">
          <label htmlFor="agent-login-password">Password</label>
          <span>Secure agent access</span>
        </div>
        <div className="password-input-wrap">
          <input
            id="agent-login-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            maxLength={72}
          />
          <button
            className="password-toggle"
            type="button"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
        <button className="auth-submit" type="submit" disabled={isSubmitting || !email.trim() || !password}>
          {isSubmitting && <span className="spinner spinner-small" />}
          {isSubmitting ? 'Signing in…' : 'Sign in to deliveries'}
        </button>
      </form>
      <div className="agent-login-security"><ShieldCheck size={15} /> Your agent session is protected by a secure HttpOnly cookie.</div>
      <div className="auth-switch">Operations team? <Link to="/login">Switch to Admin / Operations sign in</Link></div>
    </AuthFrame>
  )
}
