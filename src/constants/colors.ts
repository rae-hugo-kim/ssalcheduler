import type { WorkType, LeaveType } from '@/types/database'

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  open: '오픈',
  middle: '미들',
  close: '마감',
  allday: '종일',
}

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: '연차',
  half: '반차',
  substitute: '대체휴',
  sick: '병가',
  request: '요청',
}

export const WORK_TYPE_COLORS: Record<WorkType, string> = {
  open: 'bg-work-open',
  middle: 'bg-work-middle',
  close: 'bg-work-close',
  allday: 'bg-work-allday',
}

export const LEAVE_TYPE_COLORS: Record<LeaveType, string> = {
  annual: 'bg-leave-annual',
  half: 'bg-leave-half',
  substitute: 'bg-leave-substitute',
  sick: 'bg-leave-sick',
  request: 'bg-leave-request',
}

export const SCHEDULE_STATUS_LABELS = {
  draft: '임시저장',
  submitted: '제출됨',
  approved: '승인됨',
  rejected: '반려됨',
} as const
