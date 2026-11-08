import { Command } from 'lucide-react'
import type { ReactNode } from 'react'
import '../auth.css'

export function AuthFrame({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="auth-page">
      <div className="auth-backdrop" />
      <section className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">
            <Command size={18} />
          </span>
          <span className="auth-brand-copy">
            <strong>SWERV</strong>
          </span>
        </div>
        <div className="auth-heading">
          <div className="auth-eyebrow">
            <i /> {eyebrow}
          </div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {children}
        <div className="auth-footer">
          SWERV OPERATIONS <span>•</span> CARBON CORAL
        </div>
      </section>
    </main>
  )
}
