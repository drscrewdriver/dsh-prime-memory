# 설치 안내（dsh-layered-memory）

본 플러그인은 **DSH 공식 bundle 합성 패키지**로 배포됩니다. 설치 후 `cordis.patch.yml`의 `dsh.bundle` 계층이 플러그인 행을 자동 마운트하므로 profile 설정을 손으로 고칠 필요가 없습니다.

## 환경 요구

- Node.js ≥ 22.16（DSH 0.1.1-rc.2 이상）
- DeepSeek Harness（이하 DSH）설치 완료, `--profile web` 사용 가능

## 설치

두 가지 호출 방식 중 선택（`npx` 접두사는 아래 어떤 `dsh` 명령도 대체 가능）：

```bash
# 방식 1: npx로 공식 CLI 직접 실행（dsh 사전 설치 불필요. 버전 고정 가능, 예: dsh-layered-memory@0.8.4）
npx -y @deepseek-ai/dsh plugin --profile web add dsh-layered-memory

# 방식 2: dsh CLI 설치된 경우（dsh는 pnpm 포워더. 없으면 먼저 npm i -g pnpm）
dsh plugin --profile web add dsh-layered-memory

# 기타 소스: GitHub 저장소 / 로컬 경로（개발·디버깅용. link: 는 저장소를 가리키며, npm run build + dsh 재시작으로 반영）
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-layered-memory
```

### Agent에게 설치시키기（권장）

현재 Agent가 터미널 명령을 실행할 수 있다면 아래 문장을 그대로 보내세요：

```text
DeepSeek Harness의 web 프로파일에 dsh-layered-memory 플러그인을 설치해 주세요.

다른 프로파일은 수정하지 말고 아래 두 명령만 실행해 주세요:
dsh plugin --profile web add dsh-layered-memory
dsh --profile web --dump-config

출력에 dsh-layered-memory가 나타나면 설치 결과를 알려 주세요.
실행 중인 DSH를 임의로 닫거나 재시작하지 마세요. 설치 후 DSH Web Host 수동 재시작을 알려 주세요.
```

## 업그레이드

```bash
# 최신版으로
dsh plugin --profile web update dsh-layered-memory

# 특정 버전으로
dsh plugin --profile web update dsh-layered-memory@0.8.11
```

업그레이드는 플러그인 코드와 `dist/` 산출물만 교체하며, 데이터 디렉터리 `~/.dsh/memory/`에는 영향이 없습니다.

## 검증

DSH Web Host 재시작 후 확인：

1. **데이터 디렉터리가 나타남**＝플러그인 적용 성공：`~/.dsh/memory/` 아래에 `conversations/` `records/` `scenes/`와 `memory.db`가 나타남；
2. **설정에 "기억" 페이지**, 입력 바에 모드 pill이 나타남＝클라이언트 준비 완료；
3. 개인정보를 담은 메시지를 보내고 증류 완료 후, 다른 턴에서 관련을 물으면 컨텍스트에 "컨텍스트 주입 · memory" 행이 보여야 함.

선택 스모크 테스트（개발·장애 대응용）：

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## 마이그레이션 / 다운그레이드

- **구버전（0.5.0 이전은 `dsh-memory-plugin`）에서 이전**：구 데이터 디렉터리는 신패키지와 호환되지 않습니다. 백업 후 `~/.dsh/memory/`를 삭제하고 신플러그인 초회 실행에서 재구축하세요. 내역은 그대로 승격 불가하며 재증류가 필요합니다.
- **구버전으로 롤백**：`dsh plugin --profile web remove dsh-layered-memory` 후 구버전 문서로 재설치. 데이터 디렉터리는 남지만 구버전은 신레이아웃을 읽지 못하므로 함께 삭제 권장.

## 제거

```bash
dsh plugin --profile web remove dsh-layered-memory
```

데이터는 `~/.dsh/memory/`에 남습니다. 필요 없으면 디렉터리 전체를 수동 삭제하세요.

## 문제 해결

| 현상 | 가능한 원인 | 조치 |
| --- | --- | --- |
| 설치 후 "기억" 페이지 없음 | DSH 미재시작 / bundle 미마운트 | DSH Web Host 재시작. `dsh --profile web --dump-config`로 `dsh-layered-memory` 확인 |
| 기동 시 `duplicate loader entry id` | patch가 `insert:`와 bundle 동일 id 중복 추가 | 수동 `insert:` 삭제（본 패키지는 bundle 계층 동봉） |
| "컨텍스트 주입 · memory" 행 없음 | 증류 미실행 / 회상 꺼짐 | 모드가 off 아니며 `recall.enabled=true` 확인. `memory.log`의 `L1 단계 완료` 확인 |
| 로컬 임베딩 다운로드 멈춤 | 미러 직결 불가 | `embedding.proxy`로 프록시 설정, 또는 `embedding.mirror`을 공식 `huggingface.co`로 |
| 원격 임베딩 401 오류 | apiKey 오류 / 무키 서비스에 key 불필요 | `embedding.apiKey` 확인. self-host 무키 서비스는 apiKey 비움 |

자세한 것은 [README.ko.md](./README.ko.md)와 [CHANGELOG.ko.md](./CHANGELOG.ko.md) 참조.
