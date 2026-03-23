import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import type { Store } from '@/types/database'

export function StoresTab() {
  const { user } = useAuthStore()
  const [stores, setStores] = useState<Store[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStores()
  }, [])

  async function loadStores() {
    setLoading(true)
    const { data } = await supabase
      .from('stores')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setStores(data)
    setLoading(false)
  }

  async function createStore(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim() || !user) return
    await supabase.from('stores').insert({ name: newName.trim(), owner_id: user.id })
    setNewName('')
    loadStores()
  }

  async function updateStore(id: string) {
    if (!editName.trim()) return
    await supabase.from('stores').update({ name: editName.trim() }).eq('id', id)
    setEditingId(null)
    loadStores()
  }

  async function deleteStore(id: string) {
    if (!confirm('정말 삭제하시겠습니까? 해당 매장의 모든 데이터가 삭제됩니다.')) return
    await supabase.from('stores').delete().eq('id', id)
    loadStores()
  }

  if (loading) return <div className="py-8 text-center text-muted-foreground">로딩 중...</div>

  return (
    <div className="space-y-4">
      {/* 매장 추가 */}
      <form onSubmit={createStore} className="flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="새 매장 이름"
          className="max-w-xs"
        />
        <Button type="submit" size="sm">
          <Plus className="mr-1 h-4 w-4" />
          추가
        </Button>
      </form>

      {/* 매장 목록 */}
      {stores.length === 0 ? (
        <p className="text-muted-foreground">등록된 매장이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {stores.map((store) => (
            <Card key={store.id}>
              <CardContent className="flex items-center justify-between p-3">
                {editingId === store.id ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); updateStore(store.id) }}
                    className="flex flex-1 gap-2"
                  >
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <Button type="submit" size="sm">저장</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>취소</Button>
                  </form>
                ) : (
                  <>
                    <span className="font-medium">{store.name}</span>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingId(store.id); setEditName(store.name) }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteStore(store.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
