import { WORK_TYPE_LABELS, LEAVE_TYPE_LABELS, WORK_TYPE_COLORS, LEAVE_TYPE_COLORS } from '@/constants/colors'
import type { WorkType, LeaveType, ScheduleStatus } from '@/types/database'

interface ScheduleCellProps {
  workType: WorkType | null
  leaveType: LeaveType | null
  status: ScheduleStatus
  isEditable: boolean
  onClick: () => void
}

const STATUS_INDICATOR: Record<ScheduleStatus, string> = {
  draft: '',
  submitted: 'border-b-2 border-amber-400',
  approved: 'border-b-2 border-green-400',
  rejected: 'border-b-2 border-red-400',
}

export function ScheduleCell({ workType, leaveType, status, isEditable, onClick }: ScheduleCellProps) {
  const isEmpty = !workType && !leaveType

  let bgColor = ''
  let label = ''

  if (workType) {
    bgColor = WORK_TYPE_COLORS[workType]
    label = WORK_TYPE_LABELS[workType]
  } else if (leaveType) {
    bgColor = LEAVE_TYPE_COLORS[leaveType]
    label = LEAVE_TYPE_LABELS[leaveType]
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isEditable}
      className={`
        h-8 w-full rounded text-xs font-medium transition-colors
        ${bgColor}
        ${STATUS_INDICATOR[status]}
        ${isEmpty ? 'text-muted-foreground hover:bg-muted' : ''}
        ${isEditable ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}
      `}
    >
      {label || (isEditable ? '—' : '')}
    </button>
  )
}
