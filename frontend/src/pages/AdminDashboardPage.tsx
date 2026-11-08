import { Link } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'

export function AdminDashboardPage() {
  return (
    <main className="admin-page">
      <div className="admin-page-top">
        <Link to="/dashboard">← Back to overview</Link>
        <span>ADMINISTRATOR</span>
      </div>
      <section className="admin-card">
        <div className="admin-card-icon">
          <ShieldCheck size={22} />
        </div>
        <div className="auth-eyebrow">
          <i /> ACCESS CONTROL
        </div>
        <h1>Administrator dashboard</h1>
        <p>
          Your account has administrator access. Administrative management tools
          will be added in a future milestone.
        </p>
      </section>
    </main>
  )
}
