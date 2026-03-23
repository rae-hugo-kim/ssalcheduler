import { useState } from 'react'
import { Users, Store, ClipboardCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StoresTab } from './StoresTab'
import { MembersTab } from './MembersTab'
import { ApprovalsTab } from './ApprovalsTab'

type Tab = 'members' | 'stores' | 'approvals'

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'members', label: '회원관리', icon: <Users className="h-4 w-4" /> },
  { key: 'stores', label: '매장관리', icon: <Store className="h-4 w-4" /> },
  { key: 'approvals', label: '승인관리', icon: <ClipboardCheck className="h-4 w-4" /> },
]

export function AdminPage() {
  const [activeTab, setActiveTab] = useState<Tab>('members')

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">관리자 페이지</h1>

      <div className="flex gap-1 border-b pb-1">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            variant={activeTab === tab.key ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab(tab.key)}
            className="gap-1.5"
          >
            {tab.icon}
            {tab.label}
          </Button>
        ))}
      </div>

      {activeTab === 'members' && <MembersTab />}
      {activeTab === 'stores' && <StoresTab />}
      {activeTab === 'approvals' && <ApprovalsTab />}
    </div>
  )
}
