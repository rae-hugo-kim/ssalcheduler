import { useEffect, useState } from 'react'
import { Check, X, Calendar } from 'lucide-react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { WORK_TYPE_LABELS, LEAVE_TYPE_LABELS, WORK_TYPE_COLORS, LEAVE_TYPE_COLORS } from '@/constants/colors'
import type { Schedule, Profile, Store, WorkType, LeaveType } from '@/types/database'

interface ScheduleWithDetails extends Schedule {
  profiles: Profile
  stores: Store
}

export function ApprovalsTab() {
  const [schedules, setSchedules] = useState<ScheduleWithDetails[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPendingSchedules()
  }, [])

  async function loadPendingSchedules() {
    setLoading(true)
    const { data } = await supabase
      .from('schedules')
      .select('*, profiles(*), stores(*)')
      .eq('status', 'submitted')
      .order('date', { ascending: true })
    if (data) setSchedules(data as ScheduleWithDetails[])
    setLoading(false)
  }

  async function updateScheduleStatus(ids: string[], status: 'approved' | 'rejected') {
    await supabase.from('schedules').update({ status }).in('id', ids)
    loadPendingSchedules()
  }

  async function approveAll() {
    if (!schedules.length) return
    if (!confirm(`${schedules.length}건을 모두 승인하시겠습니까?`)) return
    await updateScheduleStatus(schedules.map((s) => s.id), 'approved')
  }

  if (loading) return <div className="py-8 text-center text-muted-foreground">로딩 중...</div>

  // 매장별로 그룹핑
  const byStore = schedules.reduce<Record<string, ScheduleWithDetails[]>>((acc, s) => {
    const key = s.stores.name
    if (!acc[key]) acc[key] = []
    acc[key].push(s)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      {schedules.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">승인 대기 중인 스케줄이 없습니다.</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">총 {schedules.length}건 대기 중</p>
            <Button size="sm" onClick={approveAll}>
              <Check className="mr-1 h-4 w-4" />전체 승인
            </Button>
          </div>

          {Object.entries(byStore).map(([storeName, items]) => (
            <section key={storeName} className="space-y-2">
              <h3 className="text-sm font-semibold">{storeName}</h3>
              {items.map((s) => (
                <Card key={s.id}>
                  <CardContent className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm">
                          <span className="font-medium">{s.profiles.display_name}</span>
                          {' — '}
                          {format(new Date(s.date), 'M월 d일 (EEE)', { locale: ko })}
                        </p>
                        <div className="flex gap-1 mt-0.5">
                          {s.work_type && (
                            <Badge variant="secondary" className={`text-xs ${WORK_TYPE_COLORS[s.work_type as WorkType]}`}>
                              {WORK_TYPE_LABELS[s.work_type as WorkType]}
                            </Badge>
                          )}
                          {s.leave_type && (
                            <Badge variant="secondary" className={`text-xs ${LEAVE_TYPE_COLORS[s.leave_type as LeaveType]}`}>
                              {LEAVE_TYPE_LABELS[s.leave_type as LeaveType]}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => updateScheduleStatus([s.id], 'approved')}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => updateScheduleStatus([s.id], 'rejected')}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}
