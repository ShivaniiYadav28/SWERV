import { useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, Circle, LocateFixed, ShieldCheck } from 'lucide-react'
import { getAgentPodImage, getAgentPodStatus, requestAgentPodOtp, submitAgentPod, uploadAgentPodImage, verifyAgentPodOtp } from '../lib/agentPortal'
import type { PodLocation, PodStatus } from '../types/proofOfDelivery'

type Props = { dispatchId: string; dispatchStatus: string; onComplete: () => void }
type GpsState = PodLocation | null

export function ProofOfDeliveryWorkflow({ dispatchId, dispatchStatus, onComplete }: Props) {
  const [started, setStarted] = useState(false)
  const [status, setStatus] = useState<PodStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [otp, setOtp] = useState('')
  const [developmentOtp, setDevelopmentOtp] = useState('')
  const [photoPreview, setPhotoPreview] = useState('')
  const [signatureSaved, setSignatureSaved] = useState(false)
  const [gps, setGps] = useState<GpsState>(null)
  const [hasSignatureInk, setHasSignatureInk] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview) }, [photoPreview])

  async function startWorkflow() {
    setLoading(true); setError(''); setSuccess('')
    try {
      const current = await getAgentPodStatus(dispatchId)
      setStatus(current); setStarted(true)
      if (current.photoUploaded) {
        try { setPhotoPreview(URL.createObjectURL(await getAgentPodImage(dispatchId, 'photo'))) } catch { /* Existing file can still be replaced if its preview is unavailable. */ }
      }
      setSignatureSaved(current.signatureUploaded)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'POD could not be started.') }
    finally { setLoading(false) }
  }

  async function saveImage(type: 'photo' | 'signature', file: Blob, name: string) {
    setLoading(true); setError(''); setSuccess('')
    try {
      await uploadAgentPodImage(dispatchId, type, file, name)
      setStatus(await getAgentPodStatus(dispatchId))
      if (type === 'photo') setPhotoPreview(URL.createObjectURL(file))
      else setSignatureSaved(true)
      setSuccess(type === 'photo' ? 'Delivery photo saved.' : 'Customer signature saved.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The proof image could not be saved.') }
    finally { setLoading(false) }
  }

  function pointerPosition(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * event.currentTarget.width / rect.width, y: (event.clientY - rect.top) * event.currentTarget.height / rect.height }
  }

  function startDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.setPointerCapture(event.pointerId)
    const { x, y } = pointerPosition(event)
    context.beginPath(); context.moveTo(x, y); drawing.current = true
  }

  function drawSignature(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    const { x, y } = pointerPosition(event)
    context.lineWidth = 3; context.lineCap = 'round'; context.strokeStyle = '#f1d8d3'
    context.lineTo(x, y); context.stroke(); setHasSignatureInk(true)
  }

  function clearSignature() {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    setHasSignatureInk(false); setSignatureSaved(false)
  }

  function saveSignature() {
    if (!hasSignatureInk || !canvasRef.current) { setError('Ask the customer to sign before saving.'); return }
    canvasRef.current.toBlob((blob) => { if (blob) void saveImage('signature', blob, 'customer-signature.png') }, 'image/png')
  }

  async function requestOtp() {
    setLoading(true); setError(''); setSuccess('')
    try {
      const result = await requestAgentPodOtp(dispatchId)
      setDevelopmentOtp(result.developmentOtp)
      setStatus(await getAgentPodStatus(dispatchId))
      setSuccess('Development test code created. It was not sent to the customer.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Customer verification code could not be created.') }
    finally { setLoading(false) }
  }

  async function verifyOtp() {
    setLoading(true); setError(''); setSuccess('')
    try { await verifyAgentPodOtp(dispatchId, otp); setStatus(await getAgentPodStatus(dispatchId)); setDevelopmentOtp(''); setSuccess('Customer code verified.') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Customer code could not be verified.') }
    finally { setLoading(false) }
  }

  function captureGps() {
    setError(''); setSuccess('')
    if (!navigator.geolocation) { setGps({ locationUnavailableReason: 'unsupported' }); return }
    setLoading(true)
    navigator.geolocation.getCurrentPosition(
      (position) => { setGps({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy }); setLoading(false) },
      (cause) => { setGps({ locationUnavailableReason: cause.code === 1 ? 'permission_denied' : 'timeout' }); setLoading(false); setError('GPS was unavailable. You can continue with the location clearly marked unavailable.') },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
  }

  async function finishDelivery() {
    if (!status?.photoUploaded || !signatureSaved || !status.otpVerified || !gps || dispatchStatus !== 'in_transit') return
    setLoading(true); setError(''); setSuccess('')
    try { await submitAgentPod(dispatchId, gps); setSuccess('Proof saved. Delivery is complete.'); onComplete() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Proof of delivery could not be submitted.') }
    finally { setLoading(false) }
  }

  const ready = Boolean(status?.photoUploaded && signatureSaved && status.otpVerified && gps && dispatchStatus === 'in_transit')
  return (
    <section className="agent-pod-panel" aria-labelledby="pod-title">
      <div className="agent-info-panel-heading"><span className="agent-section-icon"><ShieldCheck size={17} /></span><div><small>DELIVERY VERIFICATION</small><h2 id="pod-title">Proof of delivery</h2></div></div>
      <p className="agent-pod-intro">Capture the delivery evidence and verify the customer before completing this delivery.</p>
      {!started ? <button type="button" className="agent-primary-action" disabled={loading} onClick={() => void startWorkflow()}>{loading ? 'Loading…' : 'Start POD'}</button> : <>
        {dispatchStatus !== 'in_transit' && <p className="agent-pod-note">Move this delivery to In transit before final submission.</p>}
        <div className="agent-pod-step"><strong>{status?.photoUploaded ? <CheckCircle2 size={16} /> : <Circle size={16} />} Delivery photo</strong><label className="agent-pod-upload">{photoPreview && <img src={photoPreview} alt="Delivery proof preview" />}<span><Camera size={15} />{photoPreview ? 'Replace photo' : 'Capture or choose photo'}</span><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={loading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void saveImage('photo', file, file.name); event.currentTarget.value = '' }} /></label><small>JPEG, PNG or WebP; maximum 5 MB.</small></div>
        <div className="agent-pod-step"><strong>{status?.otpVerified ? <CheckCircle2 size={16} /> : <Circle size={16} />} Customer code</strong><button className="agent-quiet-button" type="button" disabled={loading || !status?.photoUploaded || status.otpVerified} onClick={() => void requestOtp()}>Request customer code</button>{developmentOtp && <div className="agent-pod-dev-code" role="status"><b>Development test code: {developmentOtp}</b><span>Not sent to the customer. For local testing only.</span></div>}{!status?.otpVerified && <div className="agent-pod-inline"><input aria-label="Six-digit customer code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" /><button className="agent-quiet-button" type="button" disabled={loading || otp.length !== 6} onClick={() => void verifyOtp()}>Verify</button></div>}</div>
        <div className="agent-pod-step"><strong>{signatureSaved ? <CheckCircle2 size={16} /> : <Circle size={16} />} Customer signature</strong><canvas ref={canvasRef} className="agent-pod-signature" width={680} height={210} aria-label="Customer signature pad" onPointerDown={startDrawing} onPointerMove={drawSignature} onPointerUp={() => { drawing.current = false }} onPointerCancel={() => { drawing.current = false }} /><div className="agent-pod-actions"><button className="agent-quiet-button" type="button" onClick={clearSignature} disabled={loading}>Clear</button><button className="agent-quiet-button" type="button" onClick={saveSignature} disabled={loading || !hasSignatureInk}>Save signature</button></div></div>
        <div className="agent-pod-step"><strong>{gps ? <CheckCircle2 size={16} /> : <Circle size={16} />} Delivery GPS</strong>{gps?.latitude !== undefined ? <p>Captured: {gps.latitude.toFixed(6)}, {gps.longitude?.toFixed(6)} · ±{Math.round(gps.accuracyMeters ?? 0)} m</p> : gps ? <p>Location unavailable ({gps.locationUnavailableReason?.replaceAll('_', ' ')}). This is recorded as unavailable, not verified GPS evidence.</p> : <p>Capture device location, or explicitly record that location was not available.</p>}<div className="agent-pod-actions"><button className="agent-quiet-button" type="button" disabled={loading} onClick={captureGps}><LocateFixed size={14} /> Capture location</button><button className="agent-quiet-button" type="button" disabled={loading} onClick={() => setGps({ locationUnavailableReason: 'not_available' })}>Record unavailable</button></div></div>
        {error && <p className="agent-action-error" role="alert">{error}</p>}{success && <p className="agent-pod-success" role="status">{success}</p>}
        <button type="button" className="agent-primary-action" disabled={!ready || loading} onClick={() => void finishDelivery()}>{loading ? 'Saving proof…' : 'Submit proof and complete delivery'}</button>
      </>}
      {!started && error && <p className="agent-action-error" role="alert">{error}</p>}
      {started && !status && <div className="agent-pod-note">POD status could not be loaded. <button className="agent-quiet-button" type="button" onClick={() => void startWorkflow()} disabled={loading}>Retry</button></div>}
    </section>
  )
}
