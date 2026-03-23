import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Store, Plus, Clock, CheckCircle, XCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { StoreMember, Store as StoreType } from '@/types/database'

interface MemberWithStore extends StoreMember {
  stores: StoreType
}

export function MyPage() {
  const { user } = useAuthStore()
  const [memberships, setMemberships] = useState<MemberWithStore[]>([])
  const [allStores, setAllStores] = useState<StoreType[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user) {
      loadData()
    }
  }, [user])

  async function loadData() {
    setLoading(true)
    const [membershipsRes, storesRes] = await Promise.all([
      supabase
        .from('store_members')
        .select('*, stores(*)')
        .eq('user_id', user!.id),
      supabase
        .from('stores')
        .select('*'),
    ])

    if (membershipsRes.data) setMemberships(membershipsRes.data as MemberWithStore[])
    if (storesRes.data) setAllStores(storesRes.data)
    setLoading(false)
  }

  async function requestJoin(storeId: string) {
    await supabase
      .from('store_members')
      .insert({ store_id: storeId, user_id: user!.id, status: 'pending', role: 'member' })
    loadData()
  }

  const joinedStoreIds = new Set(memberships.map((m) => m.store_id))
  const availableStores = allStores.filter((s) => !joinedStoreIds.has(s.id))

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">로딩 중...</div>
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">마이페이지</h1>

      {/* 내 매장 목록 */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">내 매장</h2>
        {memberships.length === 0 ? (
          <p className="text-muted-foreground">아직 가입한 매장이 없습니다.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {memberships.map((m) => (
              <Card key={m.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Store className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{m.stores.name}</p>
                      <StatusBadge status={m.status} />
                    </div>
                  </div>
                  {m.status === 'approved' && (
                    <Link to={`/store/${m.store_id}`}>
                      <Button size="sm">입장</Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 매장 가입 요청 */}
      {availableStores.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">매장 가입 요청</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {availableStores.map((store) => (
              <Card key={store.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Store className="h-5 w-5 text-muted-foreground" />
                    <p className="font-medium">{store.name}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => requestJoin(store.id)}>
                    <Plus className="mr-1 h-4 w-4" />
                    가입 요청
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config = {
    pending: { icon: Clock, label: '승인 대기', className: 'text-amber-600' },
    approved: { icon: CheckCircle, label: '승인됨', className: 'text-green-600' },
    rejected: { icon: XCircle, label: '거절됨', className: 'text-red-600' },
  }[status] ?? { icon: Clock, label: status, className: 'text-muted-foreground' }

  const Icon = config.icon
  return (
    <span className={`flex items-center gap-1 text-xs ${config.className}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  )
}
