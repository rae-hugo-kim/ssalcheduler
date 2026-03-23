import { useState } from 'react'
import { format, getDay } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ScheduleCell } from './ScheduleCell'
import { EditModal } from './EditModal'
import type { Schedule, Profile, WorkType, LeaveType } from '@/types/database'

interface ScheduleGridProps {
  year: number
  month: number
  days: Date[]
  members: Profile[]
  schedules: Schedule[]
  currentUserId: string
  isAdmin: boolean
  onSave: (userId: string, date: string, workType: WorkType | null, leaveType: LeaveType | null) => void
}

interface EditTarget {
  userId: string
  userName: string
  date: Date
  workType: WorkType | null
  leaveType: LeaveType | null
}

const DAY_COLORS: Record<number, string> = {
  0: 'bg-day-sunday',  // 일요일
  6: 'bg-day-saturday', // 토요일
}

const DAY_TEXT_COLORS: Record<number, string> = {
  0: 'text-red-500',
  6: 'text-blue-500',
}

export function ScheduleGrid({ days, members, schedules, currentUserId, isAdmin, onSave }: ScheduleGridProps) {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  // 스케줄을 userId+date로 빠르게 조회하기 위한 맵
  const scheduleMap = new Map<string, Schedule>()
  for (const s of schedules) {
    scheduleMap.set(`${s.user_id}_${s.date}`, s)
  }

  function getSchedule(userId: string, date: Date): Schedule | undefined {
    return scheduleMap.get(`${userId}_${format(date, 'yyyy-MM-dd')}`)
  }

  function handleCellClick(member: Profile, date: Date) {
    const canEdit = isAdmin || member.id === currentUserId
    if (!canEdit) return

    const schedule = getSchedule(member.id, date)
    // 일반 유저: draft/rejected만 편집 가능
    if (!isAdmin && schedule && !['draft', 'rejected'].includes(schedule.status)) return

    setEditTarget({
      userId: member.id,
      userName: member.display_name,
      date,
      workType: (schedule?.work_type as WorkType) ?? null,
      leaveType: (schedule?.leave_type as LeaveType) ?? null,
    })
  }

  function handleSave(workType: WorkType | null, leaveType: LeaveType | null) {
    if (!editTarget) return
    onSave(editTarget.userId, format(editTarget.date, 'yyyy-MM-dd'), workType, leaveType)
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="sticky left-0 z-10 min-w-[80px] border-r bg-muted px-2 py-1.5 text-left text-xs font-semibold">
                이름
              </th>
              {days.map((day) => {
                const dow = getDay(day)
                return (
                  <th
                    key={day.toISOString()}
                    className={`min-w-[44px] px-1 py-1.5 text-center text-xs font-medium ${DAY_COLORS[dow] ?? ''} ${DAY_TEXT_COLORS[dow] ?? ''}`}
                  >
                    <div>{format(day, 'd')}</div>
                    <div className="text-[10px]">{format(day, 'EEE', { locale: ko })}</div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} className="border-t hover:bg-muted/30">
                <td className="sticky left-0 z-10 border-r bg-white px-2 py-1 text-xs font-medium whitespace-nowrap">
                  {member.display_name}
                  {member.id === currentUserId && (
                    <span className="ml-1 text-[10px] text-primary">(나)</span>
                  )}
                </td>
                {days.map((day) => {
                  const dow = getDay(day)
                  const schedule = getSchedule(member.id, day)
                  const canEdit = isAdmin || (member.id === currentUserId && (!schedule || ['draft', 'rejected'].includes(schedule.status)))

                  return (
                    <td
                      key={day.toISOString()}
                      className={`px-0.5 py-0.5 ${DAY_COLORS[dow] ?? ''}`}
                    >
                      <ScheduleCell
                        workType={(schedule?.work_type as WorkType) ?? null}
                        leaveType={(schedule?.leave_type as LeaveType) ?? null}
                        status={schedule?.status ?? 'draft'}
                        isEditable={canEdit}
                        onClick={() => handleCellClick(member, day)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editTarget && (
        <EditModal
          date={editTarget.date}
          userName={editTarget.userName}
          initialWorkType={editTarget.workType}
          initialLeaveType={editTarget.leaveType}
          onSave={handleSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </>
  )
}
