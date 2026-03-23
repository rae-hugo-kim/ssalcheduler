-- =============================================
-- SSalcheduler 초기 스키마
-- =============================================

-- 1. profiles (auth.users 확장)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. stores (매장)
CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. store_members (매장 소속 + 승인)
CREATE TABLE store_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, user_id)
);

-- 4. schedules (근무 스케줄)
CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  work_type TEXT CHECK (work_type IN ('open', 'middle', 'close', 'allday')),
  leave_type TEXT CHECK (leave_type IN ('annual', 'half', 'substitute', 'sick', 'request')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(store_id, user_id, date)
);

-- =============================================
-- 인덱스
-- =============================================

CREATE INDEX idx_schedules_store_month ON schedules (store_id, date);
CREATE INDEX idx_schedules_user ON schedules (user_id, date);
CREATE INDEX idx_store_members_store ON store_members (store_id, status);
CREATE INDEX idx_store_members_user ON store_members (user_id);

-- =============================================
-- RLS 활성화
-- =============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

-- =============================================
-- RLS 정책: profiles
-- =============================================

CREATE POLICY "profiles_select_authenticated"
  ON profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY "profiles_update_admin"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- =============================================
-- RLS 정책: stores
-- =============================================

CREATE POLICY "stores_select_authenticated"
  ON stores FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "stores_insert_admin"
  ON stores FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "stores_update_owner"
  ON stores FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "stores_delete_owner"
  ON stores FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());

-- =============================================
-- RLS 정책: store_members
-- =============================================

CREATE POLICY "store_members_select_own"
  ON store_members FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "store_members_select_store_admin"
  ON store_members FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_members sm
      WHERE sm.store_id = store_members.store_id
        AND sm.user_id = auth.uid()
        AND sm.role = 'admin'
        AND sm.status = 'approved'
    )
    OR
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = store_members.store_id
        AND s.owner_id = auth.uid()
    )
  );

CREATE POLICY "store_members_insert_request"
  ON store_members FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND status = 'pending' AND role = 'member');

CREATE POLICY "store_members_update_store_admin"
  ON store_members FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = store_members.store_id
        AND s.owner_id = auth.uid()
    )
  );

CREATE POLICY "store_members_delete_self_or_admin"
  ON store_members FOR DELETE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = store_members.store_id
        AND s.owner_id = auth.uid()
    )
  );

-- =============================================
-- RLS 정책: schedules
-- =============================================

CREATE POLICY "schedules_select_store_member"
  ON schedules FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_members sm
      WHERE sm.store_id = schedules.store_id
        AND sm.user_id = auth.uid()
        AND sm.status = 'approved'
    )
  );

CREATE POLICY "schedules_insert_own"
  ON schedules FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM store_members sm
      WHERE sm.store_id = schedules.store_id
        AND sm.user_id = auth.uid()
        AND sm.status = 'approved'
    )
  );

CREATE POLICY "schedules_update_own_draft"
  ON schedules FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid() AND status IN ('draft', 'rejected')
  );

CREATE POLICY "schedules_update_store_admin"
  ON schedules FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = schedules.store_id
        AND s.owner_id = auth.uid()
    )
  );

CREATE POLICY "schedules_delete_store_admin"
  ON schedules FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = schedules.store_id
        AND s.owner_id = auth.uid()
    )
  );

-- =============================================
-- Auth Trigger: 첫 가입자 = admin
-- =============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_count INT;
  user_role TEXT;
BEGIN
  SELECT COUNT(*) INTO user_count FROM public.profiles;
  IF user_count = 0 THEN
    user_role := 'admin';
  ELSE
    user_role := 'user';
  END IF;

  INSERT INTO public.profiles (id, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    user_role
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- updated_at 자동 갱신
-- =============================================

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER schedules_updated_at
  BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
