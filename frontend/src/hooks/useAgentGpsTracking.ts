import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgentAuth } from './useAgentAuth'
import { ApiError } from '../lib/api'
import { getGpsErrorState, toGpsLocation } from '../lib/agentGps'
import {
  getAgentDeliveries,
  startAgentGpsSession,
  stopAgentGpsSession,
  submitAgentGpsLocation,
  type AgentGpsLocation,
} from '../lib/agentPortal'
import type { AgentGpsStatus } from '../context/agent-gps-context'

const locationSendIntervalMs = 20_000
const eligibilityCheckIntervalMs = 30_000

export function useAgentGpsTracking() {
  const { agent, clearAgent } = useAgentAuth()
  const navigate = useNavigate()
  const [hasActiveDelivery, setHasActiveDelivery] = useState(false)
  const [isEligibilityLoading, setIsEligibilityLoading] = useState(true)
  const [status, setStatus] = useState<AgentGpsStatus>('stopped')
  const [message, setMessage] = useState('GPS starts when you are on duty or have an active delivery.')
  const [isTracking, setIsTracking] = useState(false)
  const [lastReportedAt, setLastReportedAt] = useState<string | null>(null)

  const trackingRequestedRef = useRef(false)
  const userStoppedRef = useRef(false)
  const gpsSessionReadyRef = useRef(false)
  const locationWatchIdRef = useRef<number | null>(null)
  const locationTimerRef = useRef<number | null>(null)
  const eligibilityTimerRef = useRef<number | null>(null)
  const latestLocationRef = useRef<AgentGpsLocation | null>(null)
  const locationRequestRef = useRef<Promise<void> | null>(null)
  const checkingEligibilityRef = useRef(false)
  const sessionAttemptRef = useRef(0)
  const gpsNetworkErrorRef = useRef(false)
  const firstLocationAttemptedRef = useRef(false)

  const isEligible = agent?.status === 'on_duty' || hasActiveDelivery
  const agentId = agent?.id

  const clearTrackingResources = useCallback((stopExistingGpsSession = false): Promise<void> => {
    trackingRequestedRef.current = false
    sessionAttemptRef.current += 1
    if (locationWatchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current)
      locationWatchIdRef.current = null
    }
    if (locationTimerRef.current !== null) {
      window.clearInterval(locationTimerRef.current)
      locationTimerRef.current = null
    }
    latestLocationRef.current = null
    gpsNetworkErrorRef.current = false
    firstLocationAttemptedRef.current = false

    if (gpsSessionReadyRef.current || stopExistingGpsSession) {
      gpsSessionReadyRef.current = false
      const pendingRequest = locationRequestRef.current
      return (async () => {
        if (pendingRequest) await pendingRequest.catch(() => undefined)
        await stopAgentGpsSession().catch(() => undefined)
      })()
    }
    return Promise.resolve()
  }, [])

  const stopTracking = useCallback(async (
    reason = 'GPS tracking is stopped.',
    nextStatus: AgentGpsStatus = 'stopped',
    wasManual = true,
    stopExistingGpsSession = wasManual,
  ) => {
    if (wasManual) userStoppedRef.current = true
    const cleanup = clearTrackingResources(stopExistingGpsSession)
    setIsTracking(false)
    setStatus(nextStatus)
    setMessage(reason)
    await cleanup
  }, [clearTrackingResources])

  const handleExpiredAgentSession = useCallback(() => {
    void clearTrackingResources(true)
    clearAgent()
    navigate('/agent/login', { replace: true })
  }, [clearAgent, clearTrackingResources, navigate])

  const sendLatestLocation = useCallback(async () => {
    const location = latestLocationRef.current
    if (!location || !gpsSessionReadyRef.current || !trackingRequestedRef.current || locationRequestRef.current) return

    const request = (async () => {
      try {
        await submitAgentGpsLocation(location)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void stopTracking('GPS session expired or was revoked. Start GPS again when you are ready.', 'stopped', false, true)
          return
        } else {
          throw error
        }
      }

      if (trackingRequestedRef.current) {
        gpsNetworkErrorRef.current = false
        setStatus('active')
        setMessage('GPS is active. Your location is shared with fleet operations.')
        setLastReportedAt(location.recordedAt)
      }
    })()

    locationRequestRef.current = request
    try {
      await request
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        void stopTracking('GPS stopped because you are no longer on duty and have no active delivery.', 'stopped', false, true)
      } else if (trackingRequestedRef.current) {
        gpsNetworkErrorRef.current = true
        setStatus('unavailable')
        setMessage('GPS update could not reach SWERV. We’ll retry automatically.')
      }
    } finally {
      if (locationRequestRef.current === request) locationRequestRef.current = null
    }
  }, [stopTracking])

  useEffect(() => {
    if (!agentId) return

    let isMounted = true

    async function checkEligibility() {
      if (checkingEligibilityRef.current) return
      checkingEligibilityRef.current = true
      try {
        const deliveries = await getAgentDeliveries()
        if (isMounted) {
          setHasActiveDelivery(deliveries.length > 0)
          setIsEligibilityLoading(false)
        }
      } catch (error) {
        if (!isMounted) return
        setIsEligibilityLoading(false)
        if (error instanceof ApiError && error.status === 401) handleExpiredAgentSession()
      } finally {
        checkingEligibilityRef.current = false
      }
    }

    void checkEligibility()
    eligibilityTimerRef.current = window.setInterval(() => void checkEligibility(), eligibilityCheckIntervalMs)
    return () => {
      isMounted = false
      if (eligibilityTimerRef.current !== null) {
        window.clearInterval(eligibilityTimerRef.current)
        eligibilityTimerRef.current = null
      }
    }
  }, [agentId, handleExpiredAgentSession])

  useEffect(() => {
    if (!isEligible) {
      userStoppedRef.current = false
      if (trackingRequestedRef.current || gpsSessionReadyRef.current) {
        void stopTracking('GPS stopped because you are no longer on duty and have no active delivery.', 'stopped', false, true)
      } else {
        setStatus('stopped')
        setMessage('GPS starts when you are on duty or have an active delivery.')
      }
      return
    }

    if (!trackingRequestedRef.current && !userStoppedRef.current) {
      setStatus('permission-required')
      setMessage('Allow location access to share your GPS while working.')
    }
  }, [isEligible, stopTracking])

  const startTracking = useCallback(async () => {
    if (!isEligible || trackingRequestedRef.current) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable')
      setMessage('This browser does not support GPS location.')
      return
    }

    trackingRequestedRef.current = true
    userStoppedRef.current = false
    firstLocationAttemptedRef.current = false
    setIsTracking(true)
    setStatus('permission-required')
    setMessage('Allow location access in your browser to start GPS tracking.')
    const sessionAttempt = ++sessionAttemptRef.current

    try {
      await startAgentGpsSession()
      if (!trackingRequestedRef.current || sessionAttempt !== sessionAttemptRef.current) {
        await stopAgentGpsSession().catch(() => undefined)
        return
      }
      gpsSessionReadyRef.current = true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleExpiredAgentSession()
      } else if (error instanceof ApiError && error.status === 403) {
        void stopTracking('GPS requires on-duty status or an active delivery.', 'stopped', false)
      } else {
        trackingRequestedRef.current = false
        setIsTracking(false)
        setStatus('unavailable')
        setMessage(error instanceof Error ? error.message : 'Secure GPS could not be started.')
      }
      return
    }

    try {
      locationWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          if (!trackingRequestedRef.current) return
          const location = toGpsLocation(position)
          if (!location) {
            setStatus('unavailable')
            setMessage('The browser returned an invalid GPS position. Waiting for a valid fix…')
            return
          }
          latestLocationRef.current = location
          if (!gpsNetworkErrorRef.current) {
            setStatus('active')
            setMessage('GPS is active. Your location is shared with fleet operations.')
          }
          if (!firstLocationAttemptedRef.current) {
            firstLocationAttemptedRef.current = true
            void sendLatestLocation()
          }
        },
        (error) => {
          const gpsError = getGpsErrorState(error.code)
          if (gpsError.status === 'permission-required') {
            void stopTracking(gpsError.message, gpsError.status, false)
          } else if (error.code === 3) {
            setStatus(gpsError.status)
            setMessage(gpsError.message)
          } else {
            setStatus(gpsError.status)
            setMessage(gpsError.message)
          }
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
      )
      locationTimerRef.current = window.setInterval(() => void sendLatestLocation(), locationSendIntervalMs)
    } catch {
      void stopTracking('Your location is temporarily unavailable. Check browser location settings and try again.', 'unavailable', false)
    }
  }, [handleExpiredAgentSession, isEligible, sendLatestLocation, stopTracking])

  useEffect(() => () => {
    void clearTrackingResources()
  }, [clearTrackingResources])

  return {
    status,
    message,
    isEligible,
    isEligibilityLoading,
    isTracking,
    lastReportedAt,
    startTracking: () => { void startTracking() },
    stopTracking: () => stopTracking(),
  }
}
