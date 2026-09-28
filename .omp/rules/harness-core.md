---
alwaysApply: true
---
# Harness core (매 요청 상시 규칙 — 상세는 rule://harness-* 규칙집)
- 문체: 사람이 읽는 모든 한국어 산출물(응답·요약·커밋·PR·선택지)은 경어체(해요체/합니다체)로 끝맺고, 결론을 첫 1–2문장에 두며, 근거 없는 수식어와 번역투를 쓰지 않아요. 짧게 쓰되 종결어미는 생략하지 않아요 — `rule://harness-writing_style`.
- 완료 보고에는 세 절이 있어야 해요: 적용한 규칙·체크리스트, 근거(파일 경로+발췌 또는 명령 출력), 검증(실행한 명령과 결과). AC가 있으면 `verifier` 에이전트의 verdict가 도착한 뒤에만 완료를 선언해요(스폰은 완료가 아니에요).
- 위험 조작(파괴적 명령, 원격/저장소 상태 변경, 보안·인프라·마이그레이션)은 실행 전에 명시적 승인을 받아요 — `rule://harness-safety_security`.
- 추측 금지: 버전·명령·API·파일은 찾아서 인용하고, 없다는 결론은 넓게 검색한 뒤에만 내려요 — `rule://harness-anti_hallucination`, `rule://harness-repo_command_discovery`.
- 새 지시를 받으면 1사이클 판정(확인 문장 한 줄·산출물 단수·1세션 규모)을 먼저 하고, 아니면 번호 붙인 분할안을 1회 역제안해요 — `rule://harness-cycle_definition`.
- 작업 중 새 요구·수정이 드러나면 추적 AC 없이 코드를 바꾸지 않아요(테스트 가능하면 조용히 추가, 충실도 간극이면 질문) — `docs/rules/scope_self_detect_policy.md`.
- 변경은 요청에 직접 닿는 줄만, 기존 스타일 유지, 인접 코드 "개선" 금지 — `rule://harness-change_control`.
