import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { AuthFrame } from './components/AuthFrame'

export function UnauthorizedPage() {
  const { user, logout } = useAuth()

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // Local session state is cleared even if the API cannot be reached.
    }
  }

  return (
    <AuthFrame
      eyebrow="ACCESS RESTRICTED"
      title="Administrator access required"
      description="Your account does not have permission to view this page."
    >
      <div className="denied-actions">
        <Link className="auth-submit auth-submit-link" to="/dashboard">
          Return to overview
        </Link>
        <button className="auth-secondary" type="button" onClick={handleLogout}>
          Sign out
        </button>
      </div>
      <div className="auth-role-note">
        Signed in as {user?.email} · {user?.role}
      </div>
    </AuthFrame>
  )
}
