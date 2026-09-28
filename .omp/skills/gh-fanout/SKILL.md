---
name: gh-fanout
argument-hint: [label/filter for issues to fan out, or a tracking issue number]
description: Fans out the gh-loop across many issues as worktree-isolated `omp --mode rpc` worker sessions, observed via GitHub (labels/comments/tracking issue), with dynamic scaling. Use when the user says "gh-fanout", "멀티세션", "fan-out", "병렬 루프", "multisession orchestration", or wants several gh-loop issues worked in parallel. A THIN controller — never a daemon; never auto-merges.
---

# gh-fanout — multisession controller (autonomy Q3)

## Goal

검증된 **gh-loop**(단일 이슈 루프)을 여러 이슈에 **병렬**로 돌리는 **얇은 컨트롤러**. 각 워커 = 별도 `omp --mode rpc` 프로세스 + 자기 git worktree(이슈 1개). 관측·coarse 조정은 **GitHub**(라벨/코멘트/트래킹 이슈), 동적 스케일은 cap(기본 3) 아래. **데몬/대시보드 아님** — on-demand 한 번 돌고 끝(레포 ecc2 경계). **tmux 안 씀**(가시성은 GitHub).

이것은 Q2 루프의 **실행 엔진**이지 별도 기능이 아니다 — fix/review 단계를 워커 풀로 fan-out.

## Non-Negotiables

| Rule | Why |
|------|-----|
| **머지 절대 자동 금지** | 워커 PR은 인간 승인으로만 머지(gh-loop과 동일 불변식) |
| **얇은 오케스트레이터** | 컨트롤러는 spawn/모니터/스케일만 — 상시 데몬·대시보드 제품화 금지(Q3.6 ecc2 경계) |
| **이슈 1 ↔ worktree 1 ↔ 워커 1** | 병렬 편집·커밋 충돌 방지 |
| **cap 준수 + 예산 가드** | 워커마다 모델콜 N배 — `--cap`(기본 3) 천장, 동적 스케일은 1~cap |
| **GitHub로만 관측** | irc는 프로세스-로컬이라 별도 세션 간 못 씀 → 라벨/코멘트/트래킹 이슈가 버스 |
| **단일 컨트롤러 가정** | GitHub 라벨은 CAS 아님 → **동시 컨트롤러 미지원**(로컬 온디맨드 tier). 멀티 컨트롤러는 외부 락 필요(out_of_scope) |

## Prerequisites (discover, don't assume)

```bash
gh auth status && git --version
command -v omp   # 워커 런타임: omp --mode rpc (JSONL-over-stdio, new_session/이벤트/host-tool)
```
컨트롤러 결정 로직은 `.omp/extensions/harness/gh-loop-controller.mjs`(테스트됨). gh/git/spawn은 이 스킬이 수행.

## Process

### 1. 후보 수집 + 중복할당 방지 (assign)
```bash
ISSUES=$(gh issue list --state open --label gh-loop --json number,title,labels --limit 100)
CLAIMED=$(gh issue list --state open --label "gh-loop:in-progress" --json number | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(i=>i.number))))')
node .omp/extensions/harness/gh-loop-controller.mjs assign --issues-json "$ISSUES" --claimed-json "$CLAIMED"
```
→ `assignable`만 fan-out 대상(이미 `gh-loop:in-progress`면 skip — 다른 워커가 잡음).

### 2. 풀 shape 결정 (planPool)
각 assignable을 task로 — `kind`(fix/review), 신호(risk = `risk-assess`, `changedFiles` = `pr://<n>/diff`/`gh pr diff`):
```bash
node .omp/extensions/harness/gh-loop-controller.mjs plan --tasks-json "$TASKS" --cap 3
```
→ `workers`(지금 띄울 것) + `queued`(스케일 시). review는 changed-files로 reviewer 증가, risk=high면 +1(이종 리뷰어).

### 3. 워커 spawn — claim → worktree → spawn (실패 시 롤백)
각 워커 슬롯마다 (단일 컨트롤러 전제):
```bash
ISSUE=<slot issue>
gh issue edit "$ISSUE" --add-label "gh-loop:in-progress"      # 클레임 먼저(다음 스캔의 재선점 방지)
WT="$(git rev-parse --show-toplevel)/../wt-gh-loop-$ISSUE"
git worktree remove "$WT" 2>/dev/null                         # stale 정리는 깨끗할 때만(미커밋 있으면 실패→사람 확인, state 보존)
if git worktree add "$WT" -B "gh-loop/issue-$ISSUE"; then     # FS·브랜치 격리
  PI_AUTO_QA=0 omp --mode rpc --cwd "$WT" &                   # 자식; new_session → prompt "gh-loop for issue #$ISSUE"
else
  gh issue edit "$ISSUE" --remove-label "gh-loop:in-progress" # 롤백: 거짓-클레임 방지
fi
```
- **롤백 불변식**: worktree 생성/spawn 실패 시 `in-progress` 라벨을 **제거**해 이슈가 거짓-클레임으로 남지 않게 한다.
- **Auto QA off (headless)**: 워커는 `PI_AUTO_QA=0`으로 spawn — v17.0.9부터 `dev.autoqa` 기본 true라 첫 `xd://report_issue` 기록이 **동의 다이얼로그**를 띄우는데, headless RPC 워커에는 응답할 사람이 없다. 명시적 off로 미결-동의 불확실성을 제거한다.
- 워커는 그 worktree에서 **gh-loop** 절차를 자기 이슈에 실행 — 머지 자동 안 함.

### 4. 모니터 + GitHub 로깅 (관측 평면)
- 컨트롤러가 워커 **RPC 이벤트 스트림**(`agent_end`/`tool_execution_*`)을 수신 → **상태-변화 마일스톤만** 추린다(시작/막힘/완료/needs-decision). 모든 tool 이벤트를 올리지 말 것.
- **라벨**(상태): `gh-loop:in-progress` → 완료 시 제거 / 실패 시 `gh-loop:blocked`.
- **코멘트**(마일스톤): 이슈에 **상태-변화당 1개**, 같은 마일스톤 키는 dedup. *(주의: 이건 `gh-loop-issue`의 이슈-**생성** throttle과 별개 — 여기선 코멘트 coalescing이 따로 필요. 마일스톤만 + 키 dedup으로 GitHub secondary rate-limit 회피.)*
- **트래킹 이슈**(풀): 부모 이슈를 **edit로 갱신**해 "워커 N/cap, 완료 X, 막힘 Y" 유지(코멘트 누적 X). 사람은 이걸로 전체를 본다(tmux 불요).

### 5. 동적 스케일 (nextScale)
워커 완료/백로그 변화마다:
```bash
node .omp/extensions/harness/gh-loop-controller.mjs scale --state-json "$STATE" --cap 3
```
→ `up`(여유+백로그, ≤cap 추가 spawn) / `down`(백로그 0 + idle → retire) / `hold`.

### 6. 정리 (retire) + 시작 시 재조정
- **완료(머지/폐기 확정)**: worktree·브랜치 정리 — `--force` 미사용으로 미커밋 손실 방지.
  ```bash
  git worktree remove "$WT" 2>/dev/null || true   # 미커밋 남았으면 실패 → 사람 확인
  git branch -d "gh-loop/issue-$ISSUE" 2>/dev/null || true   # -d(머지된 것만); 폐기 확정 시에만 -D
  ```
- **크래시**: 무조건 `--force`로 지우지 말 것 — 워커 커밋은 **브랜치에 보존**(재개/회수용). worktree dir만 정리하되 미커밋 손실 위험 시 보류.
- **시작 시 재조정**: 컨트롤러 기동 시 `gh-loop:in-progress`인데 **살아있는 워커가 없는** 이슈(이전 크래시) → 라벨 정리/재클레임, stale worktree·브랜치 점검.
- 컨트롤러는 백로그·워커가 다 비면 종료(상시 대기 X).

## Observability (tmux 대체)

사람은 **GitHub로 관찰**: 이슈 라벨(상태 한눈에) · 코멘트(마일스톤) · 트래킹 이슈(풀 집계) · PR(결과). 내구·원격·비동기·검색가능. **단** 토큰단위 라이브는 아님 — 막힌 워커 정밀 디버그는 그 워커 RPC 이벤트 로그를 봄(컨트롤러가 보존).

## Reuse map

| 단계 | 자산 |
|---|---|
| assign/plan/scale 결정 | `.omp/extensions/harness/gh-loop-controller.mjs`(테스트됨) |
| 워커 루프 | `gh-loop` 스킬(per-issue) |
| 워커 로깅 throttle/dedup | `gh-loop-issue.mjs` |
| finding→이슈 소스 | `gh-loop-detect.mjs` |
| 워커 커밋 리뷰 | review-gate — 위험 변경에 2차 관점(이종 모델/휴먼 리뷰) 또는 감사된 override 강제 |
| 워커 substrate | `omp --mode rpc`(omp://rpc.md) |

## Scope / limits

- **로컬 온디맨드** 컨트롤러(이 박스). **24/7 상시응답**은 분리(robo-omp/cloud — WSL2 데스크톱은 상시서버 아님).
- **라이브 N워커 실주행**은 비용 N배 — 결정 로직은 테스트로 검증됨; 실제 다중 구동은 환경/예산 따라.
- 워커끼리 **직접 통신 안 함**(이슈 단위 분할이라 대부분 불요); fine 조정은 컨트롤러 경유.
