import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function MainPage() {
  const [isLogin, setIsLogin] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const profile = useAuthStore((s) => s.profile)

  // 이미 로그인된 경우 리다이렉트
  if (profile) {
    navigate(profile.role === 'admin' ? '/admin' : '/my', { replace: true })
    return null
  }

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    if (isLogin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: displayName } },
      })
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
    }

    setLoading(false)
  }

  async function handleGoogleLogin() {
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    })
    if (error) setError(error.message)
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Calendar className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">쌀체듈러</CardTitle>
          <CardDescription>매장 스케줄 관리 서비스</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleGoogleLogin}
          >
            Google로 {isLogin ? '로그인' : '가입'}
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">또는</span>
            </div>
          </div>

          <form onSubmit={handleEmailAuth} className="space-y-3">
            {!isLogin && (
              <div className="space-y-1">
                <Label htmlFor="displayName">이름</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="홍길동"
                  required={!isLogin}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="email">이메일</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="6자 이상"
                minLength={6}
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '처리 중...' : isLogin ? '로그인' : '가입하기'}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?'}{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => { setIsLogin(!isLogin); setError('') }}
            >
              {isLogin ? '가입하기' : '로그인'}
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
