import { LayoutDashboard, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'

type Portal = 'operations' | 'agent'

const portals = [
  {
    id: 'operations' as const,
    title: 'Admin / Operations',
    description: 'Manage fleet and dispatch.',
    path: '/login',
    Icon: LayoutDashboard,
  },
  {
    id: 'agent' as const,
    title: 'Delivery Agent',
    description: 'View and update deliveries.',
    path: '/agent/login',
    Icon: Truck,
  },
]

export function PortalSelector({ selectedPortal }: { selectedPortal: Portal }) {
  return (
    <section aria-labelledby="portal-selector-heading" className="mb-5">
      <h2 id="portal-selector-heading" className="mb-2 text-[10px] font-semibold text-[#c9c1c5]">
        Choose how you want to sign in
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {portals.map(({ id, title, description, path, Icon }) => {
          const isSelected = id === selectedPortal

          return (
            <Link
              key={id}
              to={path}
              aria-current={isSelected ? 'page' : undefined}
              className={`group flex min-h-[66px] items-center gap-2 rounded-lg border px-2.5 py-2 no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d77b6d] ${
                isSelected
                  ? 'border-[#9c5d55] bg-[#332426] text-[#f0c3bb]'
                  : 'border-[#373238] bg-[#211f22] text-[#aaa2aa] hover:border-[#65423f] hover:bg-[#292326] hover:text-[#e7d8d5]'
              }`}
            >
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${isSelected ? 'bg-[#4a3031] text-[#e99d90]' : 'bg-[#302d32] text-[#a39aa3] group-hover:text-[#dda096]'}`}>
                <Icon size={15} aria-hidden="true" />
              </span>
              <span className="grid min-w-0 gap-1">
                <span className="text-[9px] font-semibold leading-tight sm:text-[10px]">{title}</span>
                <span className="text-[8px] leading-tight text-[#8d858e]">{description}</span>
              </span>
            </Link>
          )
        })}
      </div>
      <p className="mt-1.5 text-[8px] text-[#827a83]">
        Signing in to {selectedPortal === 'agent' ? 'the Delivery Agent portal' : 'Admin / Operations'}.
      </p>
    </section>
  )
}
