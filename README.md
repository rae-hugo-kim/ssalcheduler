# 쌀체듈러 (SSalcheduler)

매장 직원 근무 스케줄을 월별로 관리하는 웹 애플리케이션입니다.

관리자가 매장을 만들고, 직원들이 자신의 근무/휴일 스케줄을 등록하면 관리자가 최종 승인하는 구조입니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **로그인/가입** | 이메일+비밀번호 또는 Google 계정으로 로그인 |
| **매장 관리** | 관리자가 매장을 생성/수정/삭제 |
| **멤버십** | 직원이 매장에 가입 요청 → 관리자 승인 |
| **월별 스케줄** | 달력 형태의 그리드에서 근무/휴일을 등록 |
| **근무 타입** | 오픈, 미들, 마감, 종일 (색상으로 구분) |
| **휴일 타입** | 연차, 반차, 대체휴, 병가, 요청 (색상으로 구분) |
| **승인 시스템** | 직원이 제출 → 관리자가 승인/반려 |
| **권한 구분** | 관리자 페이지와 일반 사용자 페이지 분리 |

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React, TypeScript, Vite |
| 스타일 | Tailwind CSS v4, shadcn/ui |
| 상태관리 | zustand |
| 날짜 | date-fns (한국어 로케일) |
| 백엔드 | Supabase (데이터베이스, 인증, RLS) |
| 배포 | GitHub Pages + GitHub Actions |

---

## 시작하기 (처음부터 끝까지)

아래 과정을 순서대로 따라하면 자신만의 쌀체듈러를 배포할 수 있습니다.

### 1단계: 프로젝트 가져오기

#### 방법 A: Fork (추천)

1. 이 저장소 페이지 오른쪽 위의 **Fork** 버튼을 클릭합니다.
2. 자신의 GitHub 계정에 저장소가 복제됩니다.
3. 내 컴퓨터에 클론합니다:

```bash
git clone https://github.com/내아이디/ssalcheduler.git
cd ssalcheduler
```

#### 방법 B: 직접 클론

```bash
git clone https://github.com/rae-hugo-kim/ssalcheduler.git
cd ssalcheduler
```

> **참고**: 직접 클론한 경우 push하려면 자신의 저장소로 remote를 변경해야 합니다.

---

### 2단계: Supabase 프로젝트 생성

Supabase는 데이터베이스와 로그인 기능을 제공하는 무료 서비스입니다.

#### 2-1. 계정 만들기

1. [https://supabase.com](https://supabase.com) 에 접속합니다.
2. **Start your project** 를 클릭합니다.
3. GitHub 계정으로 로그인합니다. (GitHub 계정이 없다면 먼저 만드세요.)

#### 2-2. 새 프로젝트 만들기

1. 로그인 후 **New Project** 를 클릭합니다.
2. 아래 항목을 입력합니다:
   - **Organization**: 기본 조직 선택 (처음이면 하나만 있습니다)
   - **Project name**: 원하는 이름 (예: `ssalcheduler`)
   - **Database Password**: 강력한 비밀번호를 입력하고 **반드시 따로 저장해두세요**
   - **Region**: `Northeast Asia (Seoul)` 선택 (한국에서 사용하므로)
3. **Create new project** 를 클릭합니다.
4. 프로젝트 생성에 1~2분 정도 걸립니다. 기다려주세요.

#### 2-3. API 키 확인하기

프로젝트가 생성되면 키를 확인합니다:

1. 왼쪽 메뉴에서 **Project Settings** (톱니바퀴 아이콘) 을 클릭합니다.
2. **API** 탭을 클릭합니다.
3. 아래 두 가지를 복사해서 메모장에 저장해 두세요:
   - **Project URL** — `https://xxxxxxxx.supabase.co` 형태
   - **anon public** 키 — `eyJhbGciOiJIUzI1NiIs...` 형태의 긴 문자열

> **주의**: `service_role` 키는 절대 외부에 노출하지 마세요. 우리가 사용하는 것은 `anon` 키입니다.

---

### 3단계: 데이터베이스 테이블 만들기

프로젝트에 포함된 SQL 파일을 실행하여 필요한 테이블들을 한 번에 생성합니다.

1. Supabase 대시보드 왼쪽 메뉴에서 **SQL Editor** 를 클릭합니다.
2. **New query** 를 클릭합니다.
3. 프로젝트의 `supabase/migrations/001_initial_schema.sql` 파일 내용을 **전체 복사**하여 붙여넣습니다.
4. **Run** (또는 Ctrl+Enter) 을 클릭합니다.
5. `Success. No rows returned` 라고 표시되면 성공입니다.

> **확인 방법**: 왼쪽 메뉴의 **Table Editor** 에서 `profiles`, `stores`, `store_members`, `schedules` 4개 테이블이 보이면 됩니다.

---

### 4단계: Google 로그인 설정

Google 계정으로 로그인할 수 있도록 설정합니다. (이메일+비밀번호 로그인은 기본 제공됩니다.)

#### 4-1. Google Cloud Console에서 OAuth 클라이언트 만들기

1. [https://console.cloud.google.com](https://console.cloud.google.com) 에 접속합니다.
2. Google 계정으로 로그인합니다.
3. 상단의 프로젝트 선택 드롭다운을 클릭하고 **새 프로젝트** 를 만듭니다.
   - 프로젝트 이름: `ssalcheduler` (원하는 이름)
   - **만들기** 클릭
4. 만든 프로젝트가 선택된 상태에서 왼쪽 메뉴의 **API 및 서비스** → **OAuth 동의 화면** 으로 이동합니다.
5. **시작하기** 를 클릭합니다 (또는 **동의 화면 구성**).
   - 앱 이름: `쌀체듈러`
   - 사용자 지원 이메일: 본인 이메일
   - 대상: **외부** 선택
   - 개발자 연락처 이메일: 본인 이메일
   - **만들기** 클릭
6. 왼쪽 메뉴의 **API 및 서비스** → **사용자 인증 정보** 로 이동합니다.
7. 상단의 **+ 사용자 인증 정보 만들기** → **OAuth 클라이언트 ID** 를 클릭합니다.
8. 아래 항목을 입력합니다:
   - **애플리케이션 유형**: `웹 애플리케이션`
   - **이름**: `ssalcheduler`
   - **승인된 리디렉션 URI**: 아래 URI를 추가합니다:
     ```
     https://내프로젝트ID.supabase.co/auth/v1/callback
     ```
     > `내프로젝트ID`는 2-3단계에서 복사한 Project URL에서 `https://` 와 `.supabase.co` 사이의 문자열입니다.
9. **만들기** 를 클릭합니다.
10. 팝업에서 **클라이언트 ID** 와 **클라이언트 보안 비밀번호** 를 복사해서 저장해 두세요.

#### 4-2. Supabase에 Google OAuth 연결하기

1. Supabase 대시보드로 돌아갑니다.
2. 왼쪽 메뉴에서 **Authentication** → **Providers** 로 이동합니다.
3. **Google** 을 찾아서 클릭합니다.
4. **Enable Sign in with Google** 을 켭니다.
5. 아래 항목을 입력합니다:
   - **Client ID**: Google에서 복사한 클라이언트 ID
   - **Client Secret**: Google에서 복사한 클라이언트 보안 비밀번호
6. **Save** 를 클릭합니다.

> **Google 로그인이 필요 없다면**: 이 단계를 건너뛰어도 됩니다. 이메일+비밀번호 로그인만으로도 사용 가능합니다.

---

### 5단계: 프로젝트 환경 설정

내 컴퓨터에서 프로젝트를 실행하기 위한 설정입니다.

#### 5-1. Node.js 설치 확인

```bash
node --version
# v18 이상이면 OK. 없다면 https://nodejs.org 에서 설치
```

#### 5-2. 패키지 설치

```bash
npm install
```

#### 5-3. 환경 변수 설정

프로젝트 루트에 `.env` 파일을 만들고 2단계에서 복사한 값을 입력합니다:

```bash
# .env 파일 생성 (프로젝트 루트에)
cp .env.example .env
```

`.env` 파일을 열어서 아래와 같이 수정합니다:

```env
VITE_SUPABASE_URL=https://내프로젝트ID.supabase.co
VITE_SUPABASE_ANON_KEY=내anon키
```

> **주의**: `.env` 파일은 `.gitignore`에 포함되어 있어서 GitHub에 올라가지 않습니다. 안심하세요.

#### 5-4. 로컬에서 실행해보기

```bash
npm run dev
```

터미널에 표시되는 주소 (보통 `http://localhost:5173/ssalcheduler/`)를 브라우저에서 열면 로그인 화면이 나타납니다.

**첫 번째로 가입하는 사용자가 자동으로 관리자(admin)가 됩니다.**

---

### 6단계: GitHub Pages로 배포하기

인터넷에 공개하여 누구나 접속할 수 있게 만드는 과정입니다.

#### 6-1. GitHub에 코드 올리기

Fork한 경우 이미 GitHub에 저장소가 있습니다. 변경사항을 push합니다:

```bash
git add -A
git commit -m "초기 설정 완료"
git push origin main
```

#### 6-2. GitHub Secrets 설정

GitHub Actions가 빌드할 때 Supabase 키를 사용할 수 있도록 설정합니다.

1. GitHub에서 내 저장소 페이지로 이동합니다.
2. **Settings** 탭을 클릭합니다.
3. 왼쪽 메뉴에서 **Secrets and variables** → **Actions** 를 클릭합니다.
4. **New repository secret** 을 클릭하여 아래 두 개를 추가합니다:

| Name | Value |
|------|-------|
| `VITE_SUPABASE_URL` | `https://내프로젝트ID.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `내anon키` |

#### 6-3. GitHub Pages 활성화

1. **Settings** → **Pages** 로 이동합니다.
2. **Source** 를 **GitHub Actions** 로 선택합니다.
3. 저장합니다.

#### 6-4. 배포 확인

1. `main` 브랜치에 push하면 자동으로 빌드와 배포가 시작됩니다.
2. **Actions** 탭에서 진행 상황을 확인할 수 있습니다.
3. 배포가 완료되면 아래 주소에서 접속 가능합니다:

```
https://내아이디.github.io/ssalcheduler/
```

---

### 7단계: Supabase에 배포 URL 등록

배포된 사이트에서 Google 로그인이 작동하려면 URL을 등록해야 합니다.

1. Supabase 대시보드 → **Authentication** → **URL Configuration** 으로 이동합니다.
2. **Site URL** 을 배포 주소로 변경합니다:
   ```
   https://내아이디.github.io/ssalcheduler/
   ```
3. **Redirect URLs** 에도 같은 주소를 추가합니다:
   ```
   https://내아이디.github.io/ssalcheduler/
   ```
4. **Save** 를 클릭합니다.

또한 Google Cloud Console에서도 업데이트합니다:

1. [Google Cloud Console](https://console.cloud.google.com) → **API 및 서비스** → **사용자 인증 정보**
2. 만들어둔 OAuth 클라이언트를 클릭합니다.
3. **승인된 자바스크립트 원본** 에 추가:
   ```
   https://내아이디.github.io
   ```
4. **저장** 을 클릭합니다.

---

## 사용 방법

### 관리자 (첫 번째 가입자)

1. 사이트에 접속하여 가입합니다 (첫 가입자 = 자동 관리자).
2. 관리자 페이지의 **매장관리** 탭에서 매장을 생성합니다.
3. **회원관리** 탭에서 직원들의 가입 요청을 승인합니다.
4. **승인관리** 탭에서 직원들이 제출한 스케줄을 승인/반려합니다.

### 직원 (일반 사용자)

1. 사이트에 접속하여 가입합니다.
2. 마이페이지에서 원하는 매장에 **가입 요청** 을 보냅니다.
3. 관리자가 승인하면 매장 페이지에 입장할 수 있습니다.
4. 스케줄 그리드에서 자신의 행을 클릭하여 근무/휴일을 등록합니다.
5. 등록이 끝나면 **제출** 버튼을 누릅니다.

### 스케줄 색상 가이드

#### 근무 타입
| 색상 | 의미 |
|------|------|
| 노랑 | 오픈 |
| 초록 | 미들 |
| 보라 | 마감 |
| 파랑 | 종일 |

#### 휴일 타입
| 색상 | 의미 |
|------|------|
| 주황 | 연차 |
| 연한 주황 | 반차 |
| 회색 | 대체휴 |
| 빨강 | 병가 |
| 분홍 | 요청 |

#### 상태 표시 (셀 하단 라인)
| 색상 | 의미 |
|------|------|
| 노란 라인 | 제출됨 (승인 대기) |
| 초록 라인 | 승인됨 |
| 빨간 라인 | 반려됨 |

---

## 프로젝트 구조

```
ssalcheduler/
├── src/
│   ├── components/
│   │   ├── auth/              # 인증 관련 (ProtectedRoute)
│   │   ├── layout/            # 공통 레이아웃 (Layout)
│   │   ├── schedule/          # 스케줄 관련 (Grid, Cell, EditModal)
│   │   └── ui/                # shadcn/ui 컴포넌트
│   ├── pages/
│   │   ├── admin/             # 관리자 페이지 (회원/매장/승인 탭)
│   │   ├── MainPage.tsx       # 로그인/가입
│   │   ├── MyPage.tsx         # 매장 선택
│   │   └── StorePage.tsx      # 스케줄 그리드
│   ├── providers/             # AuthProvider
│   ├── stores/                # zustand 상태관리
│   ├── types/                 # TypeScript 타입
│   ├── constants/             # 색상, 라벨 상수
│   ├── lib/                   # Supabase 클라이언트
│   └── App.tsx                # 라우터 설정
├── supabase/
│   └── migrations/            # DB 스키마 SQL
├── .github/
│   └── workflows/             # GitHub Actions 배포
├── .env.example               # 환경변수 예시
└── package.json
```

---

## 자주 묻는 질문 (FAQ)

### Q: 첫 번째 가입자가 아닌 사람을 관리자로 만들고 싶어요.

Supabase 대시보드 → **Table Editor** → `profiles` 테이블에서 해당 사용자의 `role` 값을 `admin`으로 변경하세요.

### Q: Google 로그인 없이 이메일만으로 사용할 수 있나요?

네. 4단계(Google 로그인 설정)를 건너뛰면 됩니다. 이메일+비밀번호 로그인은 기본으로 작동합니다.

### Q: 비밀번호를 잊어버린 직원이 있어요.

Supabase 대시보드 → **Authentication** → **Users** 에서 해당 사용자를 찾아 비밀번호를 재설정하거나, 앱에 비밀번호 찾기 기능을 추가할 수 있습니다.

### Q: 매장을 여러 개 운영할 수 있나요?

네. 관리자 페이지의 매장관리 탭에서 매장을 여러 개 생성할 수 있습니다. 직원은 각 매장에 개별적으로 가입 요청을 보냅니다.

### Q: 배포 후 수정사항이 반영이 안 돼요.

GitHub Actions 탭에서 배포 작업이 실행 중인지 확인하세요. `main` 브랜치에 push할 때마다 자동으로 재배포됩니다. Secrets가 올바르게 설정되어 있는지도 확인하세요.

### Q: 무료로 사용할 수 있나요?

네. Supabase 무료 플랜과 GitHub Pages 모두 무료입니다. 소규모 매장 운영에 충분합니다.

---

## 로컬 개발

```bash
# 패키지 설치
npm install

# 개발 서버 실행
npm run dev

# 타입 체크
npx tsc -b

# 프로덕션 빌드
npm run build

# 빌드 결과 미리보기
npm run preview
```

---

## 라이선스

MIT License
