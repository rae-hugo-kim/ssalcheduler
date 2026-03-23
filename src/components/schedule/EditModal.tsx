import { useState } from 'react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import { WORK_TYPE_LABELS, LEAVE_TYPE_LABELS, WORK_TYPE_COLORS, LEAVE_TYPE_COLORS } from '@/constants/colors'
import type { WorkType, LeaveType } from '@/types/database'

interface EditModalProps {
  date: Date
  userName: string
  initialWorkType: WorkType | null
  initialLeaveType: LeaveType | null
  onSave: (workType: WorkType | null, leaveType: LeaveType | null) => void
  onClose: () => void
}

const WORK_TYPES: WorkType[] = ['open', 'middle', 'close', 'allday']
const LEAVE_TYPES: LeaveType[] = ['annual', 'half', 'substitute', 'sick', 'request']

export function EditModal({ date, userName, initialWorkType, initialLeaveType, onSave, onClose }: EditModalProps) {
  const [workType, setWorkType] = useState<WorkType | null>(initialWorkType)
  const [leaveType, setLeaveType] = useState<LeaveType | null>(initialLeaveType)

  function selectWork(wt: WorkType) {
    setWorkType(workType === wt ? null : wt)
    setLeaveType(null)
  }

  function selectLeave(lt: LeaveType) {
    setLeaveType(leaveType === lt ? null : lt)
    setWorkType(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 font-semibold">{userName}</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {format(date, 'yyyy년 M월 d일 (EEE)', { locale: ko })}
        </p>

        {/* 근무 타입 */}
        <p className="mb-2 text-sm font-medium">근무</p>
        <div className="mb-4 grid grid-cols-4 gap-1.5">
          {WORK_TYPES.map((wt) => (
            <button
              key={wt}
              type="button"
              onClick={() => selectWork(wt)}
              className={`rounded px-2 py-1.5 text-xs font-medium transition-all ${
                WORK_TYPE_COLORS[wt]
              } ${workType === wt ? 'ring-2 ring-primary ring-offset-1' : 'opacity-60 hover:opacity-100'}`}
            >
              {WORK_TYPE_LABELS[wt]}
            </button>
          ))}
        </div>

        {/* 휴일 타입 */}
        <p className="mb-2 text-sm font-medium">휴일</p>
        <div className="mb-4 grid grid-cols-5 gap-1.5">
          {LEAVE_TYPES.map((lt) => (
            <button
              key={lt}
              type="button"
              onClick={() => selectLeave(lt)}
              className={`rounded px-2 py-1.5 text-xs font-medium transition-all ${
                LEAVE_TYPE_COLORS[lt]
              } ${leaveType === lt ? 'ring-2 ring-primary ring-offset-1' : 'opacity-60 hover:opacity-100'}`}
            >
              {LEAVE_TYPE_LABELS[lt]}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>취소</Button>
          <Button
            size="sm"
            onClick={() => { onSave(workType, leaveType); onClose() }}
          >
            저장
          </Button>
        </div>
      </div>
    </div>
  )
}
