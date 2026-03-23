import { useEffect, useState, useCallback } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, Send } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { ScheduleGrid } from '@/components/schedule/ScheduleGrid'
import type { Schedule, Profile, WorkType, LeaveType, Store } from '@/types/database'

export function StorePage() {
  const { storeId } = useParams<{ storeId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, profile } = useAuthStore()
  const isAdmin = profile?.role === 'admin'

  const monthParam = searchParams.get('month')
  const currentMonth = monthParam ? new Date(monthParam + '-01') : new Date()
  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()

  const [store, setStore] = useState<Store | null>(null)
  const [members, setMembers] = useState<Profile[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)

  const days = eachDayOfInterval({
    start: startOfMonth(currentMonth),
    end: endOfMonth(currentMonth),
  })

  const loadData = useCallback(async () => {
    if (!storeId) return
    setLoading(true)

    const monthStart = format(startOfMonth(currentMonth), 'yyyy-MM-dd')
    const monthEnd = format(endOfMonth(currentMonth), 'yyyy-MM-dd')

    const [storeRes, membersRes, schedulesRes] = await Promise.all([
      supabase.from('stores').select('*').eq('id', storeId).single(),
      supabase
        .from('store_members')
        .select('*, profiles(*)')
        .eq('store_id', storeId)
        .eq('status', 'approved'),
      supabase
        .from('schedules')
        .select('*')
        .eq('store_id', storeId)
        .gte('date', monthStart)
        .lte('date', monthEnd),
    ])

    if (storeRes.data) setStore(storeRes.data)
    if (membersRes.data) {
      const profiles = membersRes.data.map((m: { profiles: Profile }) => m.profiles)
      setMembers(profiles)
    }
    if (schedulesRes.data) setSchedules(schedulesRes.data)
    setLoading(false)
  }, [storeId, currentMonth.toISOString()])

  useEffect(() => {
    loadData()
  }, [loadData])

  function navigateMonth(direction: 'prev' | 'next') {
    const newMonth = direction === 'prev' ? subMonths(currentMonth, 1) : addMonths(currentMonth, 1)
    setSearchParams({ month: format(newMonth, 'yyyy-MM') })
  }

  async function handleSave(userId: string, date: string, workType: WorkType | null, leaveType: LeaveType | null) {
    if (!storeId) return

    if (!workType && !leaveType) {
      // 둘 다 null이면 삭제
      await supabase
        .from('schedules')
        .delete()
        .eq('store_id', storeId)
        .eq('user_id', userId)
        .eq('date', date)
    } else {
      await supabase
        .from('schedules')
        .upsert(
          {
            store_id: storeId,
            user_id: userId,
            date,
            work_type: workType,
            leave_type: leaveType,
            status: isAdmin ? 'approved' : 'draft',
          },
          { onConflict: 'store_id,user_id,date' }
        )
    }
    loadData()
  }

  async function submitMySchedules() {
    if (!storeId || !user) return
    if (!confirm('이번 달 스케줄을 제출하시겠습니까?')) return

    const monthStart = format(startOfMonth(currentMonth), 'yyyy-MM-dd')
    const monthEnd = format(endOfMonth(currentMonth), 'yyyy-MM-dd')

    await supabase
      .from('schedules')
      .update({ status: 'submitted' })
      .eq('store_id', storeId)
      .eq('user_id', user.id)
      .eq('status', 'draft')
      .gte('date', monthStart)
      .lte('date', monthEnd)

    loadData()
  }

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">로딩 중...</div>
  }

  const myDrafts = schedules.filter((s) => s.user_id === user?.id && s.status === 'draft')

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{store?.name}</h1>
          <p className="text-sm text-muted-foreground">{members.length}명 근무</p>
        </div>
        {!isAdmin && myDrafts.length > 0 && (
          <Button size="sm" onClick={submitMySchedules}>
            <Send className="mr-1 h-4 w-4" />
            제출 ({myDrafts.length}건)
          </Button>
        )}
      </div>

      {/* 월 네비게이션 */}
      <div className="flex items-center justify-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigateMonth('prev')}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-lg font-semibold">
          {format(currentMonth, 'yyyy년 M월', { locale: ko })}
        </h2>
        <Button variant="ghost" size="sm" onClick={() => navigateMonth('next')}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* 범례 */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-work-open" />오픈</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-work-middle" />미들</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-work-close" />마감</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-work-allday" />종일</span>
        <span className="text-muted-foreground">|</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-leave-annual" />연차</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-leave-half" />반차</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-leave-substitute" />대체휴</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-leave-sick" />병가</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-leave-request" />요청</span>
      </div>

      {/* 스케줄 그리드 */}
      {members.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">승인된 멤버가 없습니다.</p>
      ) : (
        <ScheduleGrid
          year={year}
          month={month}
          days={days}
          members={members}
          schedules={schedules}
          currentUserId={user?.id ?? ''}
          isAdmin={isAdmin ?? false}
          onSave={handleSave}
        />
      )}

      {/* 상태 범례 */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-6 border-b-2 border-amber-400" />제출됨</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-6 border-b-2 border-green-400" />승인됨</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-6 border-b-2 border-red-400" />반려됨</span>
      </div>
    </div>
  )
}
