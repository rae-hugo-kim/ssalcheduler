import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

interface ProtectedRouteProps {
  children: React.ReactNode
  requireAdmin?: boolean
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { session, profile, loading } = useAuthStore()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">로딩 중...</div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/" replace />
  }

  if (requireAdmin && profile?.role !== 'admin') {
    return <Navigate to="/my" replace />
  }

  return <>{children}</>
}
