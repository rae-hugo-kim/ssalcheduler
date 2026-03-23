import { Link, useNavigate } from 'react-router-dom'
import { LogOut, User, Calendar } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'

export function Layout({ children }: { children: React.ReactNode }) {
  const { session, profile } = useAuthStore()
  const navigate = useNavigate()
  const isAdmin = profile?.role === 'admin'

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to={session ? (isAdmin ? '/admin' : '/my') : '/'} className="flex items-center gap-2 font-bold text-lg no-underline text-foreground">
            <Calendar className="h-5 w-5" />
            쌀체듈러
          </Link>

          {session && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <User className="h-4 w-4" />
                {profile?.display_name}
                {isAdmin && (
                  <span className="ml-1 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                    관리자
                  </span>
                )}
              </span>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          {children}
        </div>
      </main>
    </div>
  )
}
