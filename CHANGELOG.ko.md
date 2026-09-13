# 변경 기록（한국어 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **호환성 참고**: 본 플러그인은 한국어 문서를 제공하지만, 공식 DSH의 `LocaleRuntime`이 등록하는 언어는 `zh` / `en`뿐입니다. `ko`를 선택하면 `locale "ko" is not registered` 오류가 납니다. DSH를 fork하여 `LOCALE_IDS`와 `LOCALES` 라벨을 갱신하고 재빌드하면 사용 가능해집니다.

이 파일은 **0.11.0** 릴리스 노트의 한국어판입니다. 전체 이력은 [CHANGELOG.md](./CHANGELOG.md)（中文）를 참조하세요.

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
