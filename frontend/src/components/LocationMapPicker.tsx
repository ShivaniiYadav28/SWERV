import { useEffect } from 'react'
import { useMap, useMapEvents, MapContainer, Marker, TileLayer, ZoomControl } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export type MapPoint = { latitude: number; longitude: number }

function createPointIcon(kind: 'pickup' | 'destination') {
  return L.divIcon({
    className: 'dispatch-map-pin-wrap',
    html: `<span class="dispatch-map-pin dispatch-map-pin-${kind}" aria-hidden="true"></span>`,
    iconSize: [30, 36],
    iconAnchor: [15, 34],
  })
}

const pickupIcon = createPointIcon('pickup')
const destinationIcon = createPointIcon('destination')

function RefreshMapSize() {
  const map = useMap()

  useEffect(() => {
    let frame = 0
    const refreshSize = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        map.invalidateSize({ pan: false, animate: false })
      })
    }

    refreshSize()
    const resizeObserver = new ResizeObserver(refreshSize)
    resizeObserver.observe(map.getContainer())
    window.addEventListener('resize', refreshSize)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', refreshSize)
    }
  }, [map])

  return null
}

function MapClickSelector({ onSelect }: { onSelect: (point: MapPoint) => void }) {
  useMapEvents({
    click(event) {
      onSelect({ latitude: event.latlng.lat, longitude: event.latlng.lng })
    },
  })
  return null
}

export function LocationMapPicker({
  label,
  point,
  onChange,
}: {
  label: string
  point: MapPoint | null
  onChange: (point: MapPoint | null) => void
}) {
  const mapCenter: [number, number] = point
    ? [point.latitude, point.longitude]
    : [20, 0]

  return (
    <div className="mt-3 rounded-lg border border-[#373238] bg-[#1b1a1d] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold text-[#e7dfe2]">{label} map point</p>
          {point ? (
            <p className="dispatch-map-selected-coordinate" role="status" aria-live="polite">
              Selected: {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
            </p>
          ) : (
            <p className="mt-1 text-[9px] text-[#857e87]">Optional — no point selected</p>
          )}
        </div>
        {point && (
          <button type="button" className="dispatch-coordinate-clear" onClick={() => onChange(null)}>
            Clear point
          </button>
        )}
      </div>
      <p className="my-2 text-[9px] leading-relaxed text-[#817a83]">Click the map to set the exact point. The address is not used to guess coordinates.</p>
      <div className="dispatch-location-map-frame">
        <MapContainer
          center={mapCenter}
          zoom={point ? 13 : 2}
          scrollWheelZoom={false}
          zoomControl={false}
          className="dispatch-location-map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ZoomControl position="bottomright" />
          <RefreshMapSize />
          <MapClickSelector onSelect={onChange} />
          {point && (
            <Marker
              position={[point.latitude, point.longitude]}
              icon={label.toLowerCase() === 'pickup' ? pickupIcon : destinationIcon}
              title={`${label} location`}
              alt={`${label} location`}
            />
          )}
        </MapContainer>
      </div>
    </div>
  )
}
