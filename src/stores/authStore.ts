import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import type { Profile } from '@/types/database'

interface AuthState {
  session: Session | null
  user: User | null
  profile: Profile | null
  loading: boolean
  setSession: (session: Session | null) => void
  setProfile: (profile: Profile | null) => void
  setLoading: (loading: boolean) => void
  isAdmin: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  loading: true,
  setSession: (session) => set({ session, user: session?.user ?? null }),
  setProfile: (profile) => set({ profile }),
  setLoading: (loading) => set({ loading }),
  isAdmin: () => get().profile?.role === 'admin',
}))
