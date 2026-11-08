import { useEffect, useRef, useState } from 'react'
import { Clock3, MapPin, Package, Radio, ShieldCheck, Truck } from 'lucide-react'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, Popup, TileLayer, ZoomControl, useMap } from 'react-leaflet'
import { useParams } from 'react-router-dom'
import { ApiError } from '../lib/api'
import {
  getCustomerTracking,
  getCustomerTrackingErrorMessage,
  getCustomerTrackingMapPoints,
  isTerminalDeliveryStatus,
} from '../lib/customerTracking'
import type { CustomerDeliveryStatus, CustomerTrackingAddress, CustomerTrackingData } from '../types/customerTracking'
import './customer-tracking.css'
import 'leaflet/dist/leaflet.css'

const trackingRefreshIntervalMs = 12_000

const statusLabels: Record<CustomerDeliveryStatus, string> = {
  pending: 'Order received',
  assigned: 'Preparing for pickup',
  picked_up: 'Picked up',
  in_transit: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Could not be delivered',
}

const mapIcons = {
  agent: L.divIcon({
    className: 'customer-map-icon-wrap',
    html: '<span class="customer-map-icon customer-map-icon-agent" aria-hidden="true"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  }),
  pickup: L.divIcon({
    className: 'customer-map-icon-wrap',
    html: '<span class="customer-map-icon customer-map-icon-pickup" aria-hidden="true"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  }),
  destination: L.divIcon({
    className: 'customer-map-icon-wrap',
    html: '<span class="customer-map-icon customer-map-icon-destination" aria-hidden="true"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  }),
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available yet'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function statusClass(status: CustomerDeliveryStatus): string {
  if (status === 'delivered') return 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300'
  if (status === 'cancelled' || status === 'failed') return 'border-rose-800/70 bg-rose-950/50 text-rose-300'
  return 'border-[#70413e] bg-[#392729] text-[#f0b3a8]'
}

function AddressCard({
  kind,
  address,
}: {
  kind: 'Pickup' | 'Destination'
  address: CustomerTrackingAddress
}) {
  const Icon = kind === 'Pickup' ? Package : MapPin

  return (
    <article className="rounded-xl border border-[#343035] bg-[#1d1b1f] p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-[#df9387]">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#382627]">
          <Icon size={16} aria-hidden="true" />
        </span>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em]">{kind}</h3>
      </div>
      <address className="grid gap-1 text-sm not-italic leading-relaxed text-[#bcb5bc]">
        <span className="font-medium text-[#eee8e8]">{address.address}</span>
        {address.addressLine2 && <span>{address.addressLine2}</span>}
        <span>{address.city}, {address.region} {address.postalCode}</span>
        <span>{address.country}</span>
      </address>
    </article>
  )
}

function MapViewport({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length === 1) {
      map.flyTo(positions[0], Math.max(map.getZoom(), 12), { duration: 0.5 })
    } else if (positions.length > 1) {
      map.fitBounds(L.latLngBounds(positions), { padding: [38, 38], maxZoom: 13 })
    }
  }, [map, positions])
  return null
}

function TrackingMap({ tracking }: { tracking: CustomerTrackingData }) {
  const { pickup: pickupPosition, destination: destinationPosition, agent: agentPosition, route: routePositions, positions } = getCustomerTrackingMapPoints(tracking)
  const initialPosition: [number, number] = positions[0] ?? [20, 0]
  const hasMapPosition = positions.length > 0

  if (!hasMapPosition) {
    return (
      <div className="grid min-h-[280px] place-items-center rounded-xl border border-[#343035] bg-[#1b1a1d] px-6 text-center sm:min-h-[340px]">
        <div className="max-w-xs">
          <MapPin className="mx-auto mb-3 text-[#cf7c70]" size={25} />
          <p className="text-sm font-medium text-[#e8e1e2]">Your route will appear here</p>
          <p className="mt-2 text-xs leading-relaxed text-[#98919a]">Live location will appear after pickup when the agent shares a current GPS update.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-[300px] overflow-hidden rounded-xl border border-[#343035] sm:h-[380px]">
      <MapContainer
        center={initialPosition}
        zoom={agentPosition ? 13 : 11}
        scrollWheelZoom={false}
        zoomControl={false}
        className="h-full w-full bg-[#1b1a1d]"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomControl position="bottomright" />
        <MapViewport positions={positions} />
        {pickupPosition && (
          <Marker position={pickupPosition} icon={mapIcons.pickup}>
            <Popup>Pickup location</Popup>
          </Marker>
        )}
        {destinationPosition && (
          <Marker position={destinationPosition} icon={mapIcons.destination}>
            <Popup>Delivery destination</Popup>
          </Marker>
        )}
        {agentPosition && (
          <Marker position={agentPosition} icon={mapIcons.agent}>
            <Popup>Current delivery location</Popup>
          </Marker>
        )}
        {routePositions.length > 1 && (
          <Polyline positions={routePositions} pathOptions={{ color: '#d77b6d', weight: 3, opacity: 0.85, dashArray: '7 8' }} />
        )}
      </MapContainer>
    </div>
  )
}

function TrackingTimeline({ tracking }: { tracking: CustomerTrackingData }) {
  const latestEvent = tracking.timeline.length - 1

  return (
    <ol className="grid gap-0">
      {tracking.timeline.map((event, index) => (
        <li key={`${event.status}-${event.timestamp}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
          {index < tracking.timeline.length - 1 && (
            <span className={`absolute left-[11px] top-6 h-[calc(100%-20px)] w-px ${index < latestEvent ? 'bg-[#a85f55]' : 'bg-[#454047]'}`} />
          )}
          <span className={`z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border ${index === latestEvent ? 'border-[#d77b6d] bg-[#4a2e30] text-[#f1b1a5]' : 'border-[#51474f] bg-[#252328] text-[#a9a1aa]'}`}>
            {index === latestEvent ? <span className="h-2 w-2 rounded-full bg-current" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-xs font-semibold text-[#e9e2e3]">{statusLabels[event.status]}</p>
              <time className="text-[10px] text-[#88828b]">{formatDate(event.timestamp)}</time>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[#a49da5]">{event.description}</p>
          </div>
        </li>
      ))}
      {tracking.timeline.length === 0 && (
        <li className="text-xs text-[#a49da5]">Delivery updates will appear here.</li>
      )}
    </ol>
  )
}

function LoadingState() {
  return (
    <div className="grid min-h-72 place-items-center rounded-xl border border-[#343035] bg-[#1d1b1f]" role="status">
      <div className="flex items-center gap-3 text-sm text-[#b7afb8]">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#4a4047] border-t-[#d77b6d]" />
        Loading your delivery update…
      </div>
    </div>
  )
}

function CustomerTrackingView({ token }: { token: string }) {
  const [tracking, setTracking] = useState<CustomerTrackingData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const requestInProgress = useRef(false)
  const activePage = useRef(true)
  const terminalStatus = useRef(false)
  const invalidLink = useRef(false)

  useEffect(() => {
    activePage.current = true
    requestInProgress.current = false
    terminalStatus.current = false
    invalidLink.current = false
    let refreshTimer: number | null = null

    async function refreshTracking() {
      if (!activePage.current || requestInProgress.current || terminalStatus.current || invalidLink.current) return
      requestInProgress.current = true

      try {
        const latestTracking = await getCustomerTracking(token)
        if (!activePage.current) return
        setTracking(latestTracking)
        setUpdatedAt(new Date().toISOString())
        setErrorMessage('')
        terminalStatus.current = isTerminalDeliveryStatus(latestTracking.status)
        if (terminalStatus.current && refreshTimer !== null) {
          window.clearInterval(refreshTimer)
          refreshTimer = null
        }
      } catch (error) {
        if (!activePage.current) return
        setErrorMessage(getCustomerTrackingErrorMessage(error))
        if (error instanceof ApiError && error.status === 404) {
          invalidLink.current = true
          setTracking(null)
          if (refreshTimer !== null) {
            window.clearInterval(refreshTimer)
            refreshTimer = null
          }
        }
      } finally {
        requestInProgress.current = false
        if (activePage.current) setIsLoading(false)
      }
    }

    void refreshTracking()
    refreshTimer = window.setInterval(() => void refreshTracking(), trackingRefreshIntervalMs)

    return () => {
      activePage.current = false
      if (refreshTimer !== null) window.clearInterval(refreshTimer)
    }
  }, [token])

  return (
    <main className="min-h-screen bg-[#151416] px-4 py-6 text-[#eee9e8] sm:px-6 sm:py-10">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_0%,#302324_0%,transparent_45%)]" />
      <div className="relative mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-4 sm:mb-8">
          <div className="flex items-center gap-2.5 text-inherit" aria-label="SWERV customer tracking">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#c96659] shadow-lg shadow-[#c96659]/15"><Truck size={18} /></span>
            <span className="grid gap-0.5"><strong className="text-sm tracking-wide">SWERV</strong><span className="text-[10px] text-[#918a92]">Delivery updates</span></span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#343035] bg-[#1d1b1f]/90 px-3 py-1.5 text-[10px] text-[#aaa2aa]"><ShieldCheck size={13} className="text-[#80b692]" /> Private tracking</span>
        </header>

        {isLoading && !tracking ? <LoadingState /> : errorMessage && !tracking ? (
          <section className="mx-auto grid min-h-72 max-w-xl place-items-center rounded-xl border border-[#49383a] bg-[#1d1b1f] p-6 text-center sm:p-10" role="alert">
            <div>
              <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[#382628] text-[#e29b8f]"><MapPin size={21} /></span>
              <h1 className="text-lg font-semibold text-[#f0e9e9]">We couldn’t open this tracking link</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#a59da5]">{errorMessage}</p>
            </div>
          </section>
        ) : tracking && (
          <>
            <section className="mb-5 rounded-2xl border border-[#3d3338] bg-gradient-to-br from-[#282124] to-[#1d1b1f] p-5 shadow-xl shadow-black/10 sm:mb-6 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-2xl">
                  <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d58b80]"><span className="h-1.5 w-1.5 rounded-full bg-[#d77b6d]" /> Delivery tracking</p>
                  <h1 className="text-2xl font-semibold tracking-tight text-[#f1ebeb] sm:text-3xl">Your delivery, at a glance</h1>
                  <p className="mt-2 text-sm leading-relaxed text-[#a69ea6]">Follow your package from pickup to destination.</p>
                </div>
                <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${statusClass(tracking.status)}`}>
                  <span className="h-2 w-2 rounded-full bg-current" />{statusLabels[tracking.status]}
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#373036] pt-4 text-[10px] text-[#918a92]">
                {!isTerminalDeliveryStatus(tracking.status) && <span className="inline-flex items-center gap-1.5"><Radio size={13} className="text-[#83bd97]" /> Updates automatically while your delivery is active</span>}
                <span className="inline-flex items-center gap-1.5"><Clock3 size={13} /> Updated {formatDate(updatedAt)}</span>
              </div>
            </section>

            {errorMessage && (
              <div className="mb-5 rounded-lg border border-[#5b4440] bg-[#2c2224] px-4 py-3 text-xs text-[#efb0a5]" role="status">
                We couldn’t refresh the latest update. We’ll try again automatically.
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.85fr)]">
              <div className="grid content-start gap-5">
                <section className="rounded-xl border border-[#343035] bg-[#1d1b1f] p-4 sm:p-5">
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#d58b80]">Live map</p><h2 className="mt-1 text-sm font-semibold text-[#ece6e6]">Delivery progress</h2></div>
                    {tracking.location && <span className="rounded-full border border-[#31513f] bg-[#203329] px-2.5 py-1 text-[9px] text-[#9bd0aa]">Agent location available</span>}
                  </div>
                  <TrackingMap tracking={tracking} />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#918a92]">
                    <span>{tracking.location ? 'Pin shows the latest shared delivery location' : 'Live location will appear after pickup'} · Dashed line connects known stops; it is not road directions.</span>
                    <span>Last location update: {formatDate(tracking.lastLocationUpdate)}</span>
                  </div>
                </section>

                <div className="grid gap-3 sm:grid-cols-2">
                  <AddressCard kind="Pickup" address={tracking.pickup} />
                  <AddressCard kind="Destination" address={tracking.destination} />
                </div>
              </div>

              <aside className="grid content-start gap-5">
                <section className="rounded-xl border border-[#343035] bg-[#1d1b1f] p-4 sm:p-5">
                  <div className="mb-4 flex items-center gap-2 text-[#df9387]"><Package size={16} /><h2 className="text-xs font-semibold uppercase tracking-[0.12em]">Package details</h2></div>
                  <p className="text-sm font-medium text-[#eee8e8]">{tracking.package.description}</p>
                  <div className="mt-4 flex items-center justify-between border-t border-[#343035] pt-3 text-xs">
                    <span className="text-[#918a92]">Category</span><span className="capitalize text-[#c5bdc4]">{tracking.package.category.replaceAll('_', ' ')}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="text-[#918a92]">Priority</span><span className="capitalize text-[#c5bdc4]">{tracking.priority}</span>
                  </div>
                </section>

                <section className="rounded-xl border border-[#343035] bg-[#1d1b1f] p-4 sm:p-5">
                  <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#e6dfe2]">Delivery updates</h2><Clock3 size={15} className="text-[#d58b80]" /></div>
                  <TrackingTimeline tracking={tracking} />
                </section>

                <section className="flex items-start gap-3 rounded-xl border border-[#343035] bg-[#1a191c] p-4">
                  <Clock3 size={15} className="mt-0.5 shrink-0 text-[#d58b80]" />
                  <div><p className="text-xs font-medium text-[#ded7dc]">Estimated arrival</p><p className="mt-1 text-xs text-[#928b94]">{tracking.estimatedArrival ? formatDate(tracking.estimatedArrival) : 'Arrival time is not available yet.'}</p></div>
                </section>
              </aside>
            </div>
          </>
        )}

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-[#302d32] pt-4 text-[9px] text-[#77717a]">
          <span>SWERV <span className="text-[#bd746a]">•</span> Customer delivery updates</span>
          <span>We refresh active delivery details every 12 seconds.</span>
        </footer>
      </div>
    </main>
  )
}

export function CustomerTrackingPage() {
  const { token = '' } = useParams()
  return <CustomerTrackingView key={token} token={token} />
}
