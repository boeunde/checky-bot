# checky-bot

checky-bot은 여러 Google 공유 캘린더의 일정을 여러 Slack 채널로 알려 주는 봇입니다. 설정은 모두 Slack에서 합니다. 기획은 [docs/spec.md](docs/spec.md)에 있습니다.

## 사용법

1. 알림을 받을 채널에 봇을 초대합니다: `/invite @checky-bot`. 초대한 사람이 그 채널의 첫 **채널 봇 관리자**가 됩니다.
2. 그 채널에서 `/checky`를 입력합니다.
3. **+ 캘린더 추가**를 누르고 캘린더 ID를 넣습니다. 연결되면 가장 가까운 일정 1개가 나에게만 보이는 메시지로 옵니다.
4. 이어서 나오는 알림 설정 화면에서 하루 요약과 일정별 알림을 정합니다. 새 연결은 하루 요약만 켜져 있습니다.

채널 설정 화면은 봇 프로필의 **[메시지] > 홈** 탭에서 채널 옆 **[설정]** 버튼으로도 열 수 있습니다. 채널 설정 화면에서는 연결별 **테스트 메시지 발송 / 일시정지 / 캘린더 변경 / ⚙️ 설정**(연결 삭제는 ⚙️ 설정 화면 맨 위)과 **채널 봇 관리자 [변경]**을 할 수 있습니다. 봇 메시지는 메시지의 `⋯` 메뉴 > **checky-bot 메시지 삭제**로 지웁니다. 모두 그 채널의 채널 봇 관리자만 할 수 있습니다.

## 설치

모든 구글 쪽 작업은 **공용 구글 계정**으로 합니다. 개인 Gmail 계정이어도 됩니다.

### 1. Apps Script 프로젝트 만들기

1. https://script.google.com 에서 **새 프로젝트**를 만들고 이름을 `checky-bot`으로 바꿉니다.
2. 기본 코드를 지우고 [Code.gs](Code.gs) 내용을 붙여넣은 뒤 저장합니다.
3. 왼쪽 톱니바퀴(프로젝트 설정)에서 **시간대**를 `(GMT+09:00) 서울`로 맞춥니다.

### 2. Slack 앱 권한과 토큰

https://api.slack.com/apps 에서 앱을 새로 만듭니다(**Create New App > From scratch**).

1. **OAuth & Permissions > Bot Token Scopes**에 아래 권한을 추가합니다.

   | 권한 | 쓰는 곳 |
   |---|---|
   | `commands` | `/checky` 명령어 |
   | `chat:write` | 알림, 나에게만 보이는 메시지, 앱 관리자 DM, 메시지 삭제 |
   | `users:read` | 게스트·봇 계정 확인 |
   | `channels:read` | 공개 채널 초대·내보내기 감지 |
   | `groups:read` | 비공개 채널 초대·내보내기 감지 |

2. 같은 화면에서 **Install to Workspace**(또는 Reinstall)를 누르고, **Bot User OAuth Token**(`xoxb-`로 시작)을 복사합니다.
3. **Basic Information > App Credentials**의 **Verification Token**을 복사합니다.
4. Apps Script **프로젝트 설정 > 스크립트 속성**에 두 값을 넣습니다.

   | 속성 | 값 |
   |---|---|
   | `SLACK_BOT_TOKEN` | Bot User OAuth Token |
   | `SLACK_VERIFICATION_TOKEN` | Verification Token |

### 3. setup 실행

1. 편집기 상단 함수 목록에서 `setup`을 고르고 **실행**합니다.
2. 권한 요청을 허용합니다. "확인되지 않은 앱" 경고가 나오면 **고급 > (프로젝트 이름)(으)로 이동**을 누릅니다.
3. 실행 로그에 "Slack 봇 ...(으)로 연결되었습니다"가 나오면 성공입니다.

### 4. 웹 앱으로 배포

Slack이 보내는 명령어와 버튼 요청을 받으려면 배포가 필요합니다.

1. 오른쪽 위 **배포 > 새 배포**를 누르고, 유형으로 **웹 앱**을 고릅니다.
2. **다음 사용자 인증 정보로 실행: 나**, **액세스 권한이 있는 사용자: 모든 사용자**로 정합니다.
3. **배포**를 누르고 **웹 앱 URL**을 복사합니다. 아래에서는 이 주소를 "웹 앱 URL"이라고 부릅니다.

### 5. Slack 앱 연결

| 메뉴 | 설정 |
|---|---|
| **Slash Commands** | **Create New Command**: Command `/checky`, Request URL은 웹 앱 URL, Short Description `캘린더 알림 설정` |
| **Interactivity & Shortcuts** | 켜고 Request URL에 웹 앱 URL. **Create New Shortcut > On messages**: Name `checky-bot 메시지 삭제`, Callback ID `delete_message` |
| **Event Subscriptions** | 켜고 Request URL에 웹 앱 URL(Verified 표시 확인). **Subscribe to bot events**에 `app_home_opened`, `member_joined_channel`, `channel_left`, `group_left` 추가 |
| **App Home** | **Home Tab**과 **Messages Tab**을 켭니다. Messages Tab이 꺼져 있으면 앱 관리자 DM이 보이지 않습니다. |

저장 후 Slack이 재설치를 요청하면 **Reinstall**을 누릅니다.

### 6. 앱 관리자 등록

Slack 왼쪽 앱 목록에서 checky-bot을 열면(App Home) 처음 연 사람이 **앱 관리자**로 등록됩니다. 앱 관리자는 장애 DM을 받고, App Home의 [변경] 버튼으로 다른 사람에게 넘길 수 있습니다. 처음 `/checky`를 실행하거나 봇을 초대한 사람이 먼저 등록될 수도 있습니다.

## 코드를 고친 뒤

웹 앱은 배포한 시점의 코드로 돌아갑니다. 코드를 고치면 **배포 > 배포 관리 > 편집(연필) > 버전: 새 버전 > 배포**를 누르세요. URL은 그대로 유지됩니다. 자동 실행(1분·10분 주기)은 배포와 관계없이 저장된 최신 코드로 돕니다.

## 동작 방식

- **10분마다** 모든 캘린더를 읽어 앞으로 25분 안에 보낼 알림 목록을 만듭니다.
- **1분마다** 그 목록에서 지금 보낼 알림만 보냅니다. 캘린더를 읽지 않아 가볍습니다.
- **캘린더가 바뀌면** 다음 1분 실행 때 목록을 다시 만듭니다. 캘린더마다 변경 트리거를 하나씩 만들며, 15개를 넘는 캘린더는 10분 주기로만 반영됩니다.
- **실행이 늦어지면** 10분 안의 알림까지는 늦게라도 보내고, 그보다 오래된 알림은 건너뜁니다.

## 제약

- 알림은 최대 약 1분 늦을 수 있습니다.
- 개인 Gmail 계정은 자동 실행 시간이 하루 90분으로 제한됩니다. 실행 기록에서 하루 사용량을 확인하세요.
- Apps Script는 Slack 표준 서명 검증을 쓸 수 없어 Verification Token으로 요청을 확인합니다.
- Slack은 3초 안에 응답을 요구합니다. 테스트처럼 오래 걸리는 동작은 Slack에 경고가 떠도 결과는 이어서 옵니다.

## 문제 해결

- **Event Subscriptions에서 URL이 Verified 되지 않음:** 웹 앱 액세스 권한이 "모든 사용자"인지, `SLACK_VERIFICATION_TOKEN`이 맞는지 확인합니다.
- **`/checky`가 "먼저 초대하세요"라고 함:** 그 채널에 봇을 초대합니다. 비공개 채널은 초대가 꼭 필요합니다.
- **캘린더 연결이 안 됨:** 캘린더를 공용 구글 계정에 공유했는지, ID가 맞는지 확인합니다.
- **알림이 안 옴:** Apps Script 왼쪽 **실행** 메뉴에서 `dispatchDue`, `rebuildSchedule` 실패 기록을 확인합니다.
- **앱 관리자 DM이 안 보임:** App Home의 Messages Tab이 켜져 있는지 확인합니다.

## 테스트

Apps Script와 Slack을 흉내 낸 모의 환경에서 동작을 확인합니다. Node.js가 필요합니다.

```bash
node test/checky-bot.test.js
```
