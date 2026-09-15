# 변경 기록（한국어 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **호환성 참고**: 본 플러그인은 한국어 문서를 제공하지만, 공식 DSH의 `LocaleRuntime`이 등록하는 언어는 `zh` / `en`뿐입니다. `ko`를 선택하면 `locale "ko" is not registered` 오류가 납니다. DSH를 fork하여 `LOCALE_IDS`와 `LOCALES` 라벨을 갱신하고 재빌드하면 사용 가능해집니다.

이 파일은 **0.11.0** 릴리스 노트와 현재 **미출시** 변경 사항의 한국어판입니다. 전체 이력은 [CHANGELOG.md](./CHANGELOG.md)（中文）를 참조하세요.

## [미출시]

### 추가

- **§B L1 결정 증거 체인(추적 가능성 기반)**. 모든 L1 레코드는 중복 제거 판단의 **결과**지만, 판단 자체는 흔적을 남기지 않았습니다(결과는 보이지만 무엇에 근거했는지는 보이지 않음). 새 테이블 `l1_receipts`가 판단마다 증거를 남깁니다(`run_id` / `record_id` / `kind` / **후보 풀의 순서 있는 sha256 다이제스트** / `decided_at`). 새 도구 **`memory_receipts`** 와 RPC 엔드포인트 **`dsh-memory/receipts`** 로 레코드 단위·배치 단위 **2차원 소급**이 가능합니다. 증거는 이벤트 **이전**에 존재해야 합니다——입력 스냅샷은 **사후에 채워 넣을 수 없기** 때문입니다([ADR-0006](./docs/adr/0006-l1-decision-receipts.md)).
  - 보존 정책은 **run 수** 기준(`RECEIPTS_MAX_RUNS = 1000`)——시간 창으로는 행 수의 상한을 줄 수 없습니다. 또한 트리밍은 **run 단위이며 행 단위가 아닙니다**(행 단위로 자르면 "반쪽 배치"가 생겨 완전해 보이지만 실제로는 누락된 결론을 내놓습니다——"찾을 수 없음"보다 해롭습니다).
  - 레드라인: 트리밍은 **`l1_receipts`만 건드리고 `l1_records`는 절대 건드리지 않습니다**.
  - 실패 격리: 증거는 측면 인프라이므로 쓰기 실패는 `warn`만 남기고 **L1 증류를 절대 중단하지 않습니다**.

- **§C 모순 동결(선택, 기본 꺼짐)**. 기존 중복 제거 **결정 어휘**는 `store` / `update` / `merge` / `skip`뿐이어서, "충돌 감지기"가 모순을 감지해도 **LLM이 직접 재정해 기록**했고 **"멈추고 사람에게 묻는" 선택지가 없었습니다**. `conflictFreeze.enabled`를 켜면 어휘에 `conflict`가 추가되어, 양쪽 다 맞아 보여 기계가 판단할 수 없을 때 그 쌍을 `conflict_pending`에 **대기**시킵니다——**새 기억은 평소대로 저장되고 양쪽 내용 모두 바뀌지 않습니다**. 재정은 새 도구 **`memory_resolve_conflict`**(RPC: `dsh-memory/conflict-resolve`)로 하며 결론은 `winner` / `loser` / `both`입니다.
  - **동결은 "쓰기를 막는 것"이 아니라 "자동 재정하지 않는 것"**——전자는 정보를 잃어, 해결하려던 문제보다 나빠집니다.
  - **안전밸브**: `maxPending`(큐 상한) / `timeoutDays`(타임아웃 강등). 의미는 "**새것을 받지 않는다**"이지 "오래된 것을 조용히 지운다"가 아닙니다——자동 결착된 쌍도 **큐의 행으로 남고** `resolution = auto`로 사람의 결론과 구분됩니다.
  - **그래프 측**: 동결된 레코드를 소스로 가진 노드는 `disputed`가 됩니다(기존 상태. 검색 후보에는 남으므로 "평소대로 회수되지만 상태가 보이는" 중간 상태). 이 부여는 **파생 동기화**이며 단방향 플래그가 아닙니다——재정은 분쟁을 **취소**하므로, 단방향이면 해결된 노드가 영원히 `disputed`로 남아 **파생 그래프가 사실과 어긋납니다**.
  - **제로 드리프트**: 꺼져 있을 때 중복 제거 프롬프트는 변경 전과 **바이트 단위로 동일**합니다. 이는 **구조적** 보증(꺼진 경로는 base 상수를 그대로 반환)이며 수동 비교가 아닙니다([ADR-0010](./docs/adr/0010-conflict-freeze-default-off-and-timeout.md)).

### 변경

- **새 설정** `conflictFreeze.enabled`(기본 꺼짐) / `conflictFreeze.maxPending`(100) / `conflictFreeze.timeoutDays`(30, `0` = 타임아웃 강등 없음). **새 엔드포인트** `dsh-memory/receipts`와 `dsh-memory/conflict-resolve`(엔드포인트 면 26 → 28).
- **`L1ReceiptKind`에 `conflict` 추가**. 동작 어휘를 확장할 때는 **그 어휘를 소비하는 모든 지점**(증거 정규화·통계 로그·렌더 문구·schema 설명)을 함께 확인해야 합니다——실행 중 실측: 등록 누락이 있으면 "모델이 **명확히** 판단 불가라고 말한" 것이 `skip_missing`(= "모델이 **답하지 않음**")으로 기록되고, §C의 감사 가능성은 **전적으로** 증거 체인에 의존하므로 감사 결론이 사실과 **정반대**가 됩니다.

### 수정

- **미인식 액션이 폴백 분기에 조용히 흡수됨**. `pipeline/l1.ts`의 적용 루프는 `store` / `skip`만 명시 분기하고 **나머지 액션은 모두 update/merge 분기로 떨어집니다**. conflict 판단은 설계상 `target_ids`가 없어 `targets=[]`가 되고, "0건을 교체한" 병합 산물로 추가되어 `version`이 **1**로 계산되었습니다. **오류도 없고 데이터 손실도 없으며 흔적은 version 숫자 하나뿐**——즉 conflict가 조용히 merge/update로 강등되고 있었고, 이는 §C가 바로 제거하려던 동작입니다. **수정**: 명시적 `conflict` 분기를 추가하고, 검증 실패 또는 스위치 꺼짐일 때는 **`store`로 폴백**하며 폴백 분기로는 절대 떨어지지 않습니다.
- **엔드포인트 게이트가 손으로 베낀 목록이었음**. `tests/contract-keys.test.ts`는 실제 등록표를 import하지 않고 복제했기 때문에 두 단언이 복제본 자체와만 일치했습니다. §B가 `receipts`를 추가해 실제 등록표가 27이 되어도 복제본은 26이었고 개수 단언도 `toBe(26)` 그대로여서——**계속 초록**이었습니다. 이번에 `conflict-resolve`를 추가해도 **여전히 초록**이었습니다. **수정**: 로컬 목록이 `MEMORY_ENDPOINTS`와 항목 단위로 일치함을 단언합니다.

## [0.11.0] — 2026-09-13

### 호환성（DSH 플러그인 프레임워크 문서 적합화）

- **settings 등록 크로스 버전 대응（0.1.1-rc.2 ~ 0.1.5-rc.2）**. 기존 `src/settings.ts`는 `@deepseek-ai/dsh-settings`에서 `settingsNamespace()`를 **값 임포트**했는데, v0.1.3+에서는 이 익스포트가 제거되어 새 호스트에서는 모듈 로드 시점에 `Failed to load plugins`이 발생해 플러그인 트리 전체가 함께 깨집니다. 현재는:
  - 네임스페이스는 문자열 리터럴 `'dsh-memory'`（브라우저 측은 원시 문자열만 읽으므로 신구 호스트에서 동등）. 타입 임포트만 남기고（컴파일 시 소거, 로드 리스크 없음）.
  - 등록은 3분기 런타임 분기: 우선 `settings.register()`（모든 대상 버전에 존재, get/watch/update 스코프를 반환하며 라이브 토글과 UI 쓰기가 모두 이를 경유）; 폴백은 `settings.installSection()` 브리지（v0.1.2+ 서비스 표면, `register`이 없을 때만. 런타임 쓰기는 비즈니스 오류로 명시 거부）; 둘 다 없으면 상시 온으로 강등——"settings 장애가 호스트를 꺾지 않는다"는 원칙은 불변.
  - `SettingsScope`는 로컬 구조 타입으로 변경, 패키지 수준 타입 익스포트에 의존하지 않음.
- **`dsh.plugin.json` 추가**（DSH 발견 매니페스트: id / `engines.dsh` `>=0.1.1-rc.2 <0.2.0-0` / components는 `dist/` 산출물 지정）. `dsh-plugin-template` 표준 파일 구조 준수.
- **`@deepseek-ai/dsh-*` peerDependencies를 optional로 전환하고 범위 확대**（`^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-rc.1 || ^0.1.5-rc.2`）. `@deepseek-ai/cordis`는 필수 유지——awesome-dsh-plugin 제출 요건 B.3 준수.
- **`screenshots.json` 추가**（`assets/img/` 참조 8장）, 제출 카드에 표시 가능.

### 변경

- `package.json` 버전을 0.11.0으로 상향. npm `files`에 `dsh.plugin.json` 추가（`screenshots.json`은 awesome-dsh-plugin 탐색 규약에 따라 git 리포지토리 전용, npm 패키지에는 미포함）.

### 실측 대기

- v0.1.5-rc.2에서의 `conversation.input.left` / `settings.section` 슬롯과 Session V3의 `session.surface.nodes` 시맨틱스（occupancy 추정）는 미검증. README의 호환성 매트릭스 참조.
