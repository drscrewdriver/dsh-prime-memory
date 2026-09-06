# 변경 기록（한국어 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **호환성 참고**: 본 플러그인은 한국어 문서를 제공하지만, 공식 DSH의 `LocaleRuntime`이 등록하는 언어는 `zh` / `en`뿐입니다. `ko`를 선택하면 `locale "ko" is not registered` 오류가 납니다. DSH를 fork하여 `LOCALE_IDS`와 `LOCALES` 라벨을 갱신하고 재빌드하면 사용 가능해집니다.

이 파일은 **0.9.0** 릴리스 노트의 한국어판입니다. 전체 이력은 [CHANGELOG.md](./CHANGELOG.md)（中文）를 참조하세요.

## [0.9.0] — 2026-09-01

### 추가

- **Hall 조분류 채널**: `family` / `type`과 직교하는 조속성 축. `types.ts`가 `HALL_CATALOG`（정典 소스: 기본 활성 `work` / `relationships` / `general` 에 더해 실험적 `finance` / `journey`）를 정의. `config.hall.enabled`로 참여 Hall 제어. L1 추출 단계가 활성 목록에서 `metadata.hall`을 자동 태그（명확한 해당 없으면 생략, 강제 `general` 없음）. `ListRecordsRequest.hall`과 `UiRecord.hall`이 계약을 확장하고, 레코드 브라우저에 Hall 필터 dropdown과 각 카드의 Hall 태그 추가.
- **원격 임베딩 런타임 오버라이드**: 임베딩 `baseUrl` / `apiKey` / `model` / `dimensions`가 **설정 UI에서 편집 가능**해지고, 배포 YAML을 런타임에서 오버라이드（`effectiveCfg`가 `cfg.embedding`에 주입, LLM 채널과 독립된 서브트리）. `EmbeddingManager`에 `getEff()`가 추가되어 설정 편집이 즉시 반영.
- **고권한 쓰기/삭제 도구**: `memory_add`（명시적 "기억해 X" → L1 직접 쓰기, 임의 `hall`）와 `memory_delete`（의미 검색 히트 삭제, 최대 10건）를 등록. `live.memoryMutate`（설정의 고권한 모드）로 게이트. 레코드 브라우저에 고권한 스위치（확인 포함）와 각 레코드 삭제 버튼 추가.
- **다국어 문서**（`multilingual-docs-skill` 사양 준수）: `README` / `INSTALL` / `CHANGELOG`를 `zh` / `en` / `ja` / `ko`로 구비. 각 페이지 머리에 언어 전환（각 언어 모어 표기）과, ja/ko 페이지의 DSH 호환성 참고 배치.
- **툴체인**: ESLint 9（flat config）와 Vitest 도입. `npm run lint` / `npm run test` 추가. `HALL_CATALOG`와 Hall 추출 프롬프트를 커버하는 첫 Vitest 케이스 추가.

### 변경

- **원격 임베딩 `apiKey`가 임의로**: 키 불필요 self-host `/embeddings` 서비스 수용（`remoteCeiling`이 `apiKey`를 필수로 하지 않음）. 키 미설정 시 `authorization` 헤더를 생략하여 빈 `Bearer`가 거부되는 것 방지.

### 수정

- `apiKey`가 빈 경우 원격 임베딩이 빈 `Bearer` 헤더를 보내지 않게 됨.

### 알려진 제한

- `EmbeddingManager` 구축 지점（`src/index.ts`）의 `getEff()` 배선이 아직 연결되지 않아, 런타임 오버라이드가 매니저 내부 임베딩 서비스에 아직 반영되지 않습니다. 후속에서 완료 예정.
