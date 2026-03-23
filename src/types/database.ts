export type WorkType = 'open' | 'middle' | 'close' | 'allday'
export type LeaveType = 'annual' | 'half' | 'substitute' | 'sick' | 'request'
export type ScheduleStatus = 'draft' | 'submitted' | 'approved' | 'rejected'
export type UserRole = 'admin' | 'user'
export type MemberStatus = 'pending' | 'approved' | 'rejected'
export type MemberRole = 'admin' | 'member'

export interface Profile {
  id: string
  display_name: string
  phone: string | null
  role: UserRole
  created_at: string
  updated_at: string
}

export interface Store {
  id: string
  name: string
  owner_id: string
  created_at: string
}

export interface StoreMember {
  id: string
  store_id: string
  user_id: string
  status: MemberStatus
  role: MemberRole
  created_at: string
}

export interface Schedule {
  id: string
  store_id: string
  user_id: string
  date: string
  work_type: WorkType | null
  leave_type: LeaveType | null
  status: ScheduleStatus
  note: string | null
  created_at: string
  updated_at: string
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile
        Insert: Omit<Profile, 'created_at' | 'updated_at'>
        Update: Partial<Omit<Profile, 'id' | 'created_at'>>
      }
      stores: {
        Row: Store
        Insert: Omit<Store, 'id' | 'created_at'>
        Update: Partial<Omit<Store, 'id' | 'created_at'>>
      }
      store_members: {
        Row: StoreMember
        Insert: Omit<StoreMember, 'id' | 'created_at'>
        Update: Partial<Omit<StoreMember, 'id' | 'created_at'>>
      }
      schedules: {
        Row: Schedule
        Insert: Omit<Schedule, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Schedule, 'id' | 'created_at'>>
      }
    }
  }
}
