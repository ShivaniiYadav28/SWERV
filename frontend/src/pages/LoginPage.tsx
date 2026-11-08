import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { AuthFrame } from './components/AuthFrame'
import { PortalSelector } from '../components/PortalSelector'

type LoginLocationState = { from?: string; error?: string }

export function LoginPage() {
  const { login, loadError } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const locationState = location.state as LoginLocationState | null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(
    locationState?.error ?? loadError,
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    try {
      await login({ email, password })
      navigate(locationState?.from ?? '/dashboard', { replace: true })
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sign in failed. Please try again.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="WELCOME BACK"
      title="Sign in to SWERV"
      description="Access your fleet operations workspace."
    >
      <PortalSelector selectedPortal="operations" />
      <form className="auth-form" onSubmit={handleSubmit}>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}

        <label htmlFor="login-email">Email address</label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
        />

        <div className="password-label-row">
          <label htmlFor="login-password">Password</label>
          <span>Secure, private access</span>
        </div>
        <div className="password-input-wrap">
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            maxLength={72}
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>

        <button className="auth-submit" type="submit" disabled={isSubmitting}>
          {isSubmitting && <span className="spinner spinner-small" />}
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="auth-switch">
        New to SWERV? <Link to="/register">Create an account</Link>
      </div>
      <div className="auth-switch !mt-2">
        Delivery agent? <Link to="/agent/login">Switch to agent sign in</Link>
      </div>
      <div className="auth-assurance">
        <ShieldCheck size={15} /> Your session is protected with secure,
        HttpOnly cookies.
      </div>
    </AuthFrame>
  )
}
