import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AgentGuestRoute, AgentProtectedRoute, GuestRoute, ProtectedRoute } from './components/ProtectedRoute'
import { AdminUsersPage } from './pages/AdminUsersPage'
import { DemandForecastingPage } from './pages/DemandForecastingPage'
import { CustomersPage } from './pages/CustomersPage'
import { DashboardPage } from './pages/DashboardPage'
import { DispatchRequestsPage } from './pages/DispatchRequestsPage'
import { FleetAgentsPage } from './pages/FleetAgentsPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { UnauthorizedPage } from './pages/UnauthorizedPage'
import { AgentLoginPage } from './pages/AgentLoginPage'
import { AgentLayout } from './pages/AgentLayout'
import { AgentDashboardPage } from './pages/AgentDashboardPage'
import { AgentDeliveriesPage } from './pages/AgentDeliveriesPage'
import { AgentDeliveryDetailsPage } from './pages/AgentDeliveryDetailsPage'
import { AgentHistoryPage } from './pages/AgentHistoryPage'
import { ProofOfDeliveryPage } from './pages/ProofOfDeliveryPage'
import { AgentAttendancePage } from './pages/AgentAttendancePage'
import { AdminAttendancePage } from './pages/AdminAttendancePage'

const LiveFleetPage = lazy(() =>
  import('./pages/LiveFleetPage').then((module) => ({ default: module.LiveFleetPage })),
)
const AnomalyDetectionPage = lazy(() =>
  import('./pages/AnomalyDetectionPage').then((module) => ({ default: module.AnomalyDetectionPage })),
)
const CustomerTrackingPage = lazy(() =>
  import('./pages/CustomerTrackingPage').then((module) => ({ default: module.CustomerTrackingPage })),
)
const RouteOptimizationPage = lazy(() =>
  import('./pages/RouteOptimizationPage').then((module) => ({ default: module.RouteOptimizationPage })),
)

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route
        path="/login"
        element={
          <GuestRoute>
            <LoginPage />
          </GuestRoute>
        }
      />
      <Route
        path="/register"
        element={
          <GuestRoute>
            <RegisterPage />
          </GuestRoute>
        }
      />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />
      <Route path="/track/:token" element={<Suspense fallback={<main className="auth-loading"><span className="spinner" /><p>Opening your tracking link…</p></main>}><CustomerTrackingPage /></Suspense>} />

      <Route
        path="/agent/login"
        element={<AgentGuestRoute><AgentLoginPage /></AgentGuestRoute>}
      />
      <Route element={<AgentProtectedRoute />}>
        <Route path="/agent" element={<AgentLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<AgentDashboardPage />} />
          <Route path="deliveries" element={<AgentDeliveriesPage />} />
          <Route path="deliveries/:id" element={<AgentDeliveryDetailsPage />} />
          <Route path="history" element={<AgentHistoryPage />} />
          <Route path="attendance" element={<AgentAttendancePage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/agents" element={<FleetAgentsPage />} />
        <Route path="/dispatch-requests" element={<DispatchRequestsPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/agent-attendance" element={<AdminAttendancePage />} />
        <Route path="/live-fleet" element={<Suspense fallback={<main className="auth-loading"><span className="spinner" /><p>Loading live fleet…</p></main>}><LiveFleetPage /></Suspense>} />
        <Route path="/route-optimization" element={<Suspense fallback={<main className="auth-loading"><span className="spinner" /><p>Loading route optimization…</p></main>}><RouteOptimizationPage /></Suspense>} />
      </Route>
      <Route element={<ProtectedRoute requiredRole="admin" />}>
        <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/demand-forecasting" element={<DemandForecastingPage />} />
        <Route path="/admin/anomaly-detection" element={<Suspense fallback={<main className="auth-loading"><span className="spinner" /><p>Loading anomaly dashboard…</p></main>}><AnomalyDetectionPage /></Suspense>} />
        <Route path="/admin/proof-of-delivery" element={<ProofOfDeliveryPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
