/**
 * 공용 Google 캘린더 일정을 Slack 채널로 알려주는 스크립트.
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 아래 두 값을 넣어야 합니다.
 *   CALENDAR_ID        공용 캘린더 ID
 *   SLACK_WEBHOOK_URL  Slack Incoming Webhook URL
 *
 * 설치와 변경 방법은 README.md를 참고하세요.
 */

const CONFIG = {
  TIME_ZONE: 'Asia/Seoul',

  // 시작 전 알림: 몇 분 전부터 알릴지, 몇 분마다 확인할지
  // CHECK_EVERY_MINUTES는 1, 5, 10, 15, 30 중 하나여야 합니다.
  REMINDER_MINUTES: 10,
  CHECK_EVERY_MINUTES: 5,

  // 아침 요약
  DAILY_SUMMARY_ENABLED: true,
  DAILY_SUMMARY_HOUR: 9,
  DAILY_SUMMARY_WEEKDAYS_ONLY: true,
};

const SENT_PROPERTY = 'SENT_REMINDERS';
const TRIGGER_HANDLERS = ['checkUpcomingEvents', 'sendDailySummary'];

/** 처음 한 번 실행합니다. 연결을 확인하고 자동 실행을 등록합니다. 다시 실행해도 중복 등록되지 않습니다. */
function setup() {
  // 아침 요약 시각은 프로젝트 시간대를 따르므로 먼저 맞는지 확인합니다.
  const scriptTimeZone = Session.getScriptTimeZone();
  if (scriptTimeZone !== CONFIG.TIME_ZONE) {
    throw new Error(`프로젝트 시간대가 ${scriptTimeZone}입니다. 프로젝트 설정에서 시간대를 (GMT+09:00) 서울로 바꾼 뒤 다시 실행하세요.`);
  }

  const calendar = getCalendar_();
  postToSlack_(`:white_check_mark: 캘린더 알림이 연결되었습니다: *${escapeSlack_(calendar.getName())}*`);

  ScriptApp.getProjectTriggers()
    .filter((trigger) => TRIGGER_HANDLERS.includes(trigger.getHandlerFunction()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('checkUpcomingEvents')
    .timeBased()
    .everyMinutes(CONFIG.CHECK_EVERY_MINUTES)
    .create();

  if (CONFIG.DAILY_SUMMARY_ENABLED) {
    ScriptApp.newTrigger('sendDailySummary')
      .timeBased()
      .everyDays(1)
      .atHour(CONFIG.DAILY_SUMMARY_HOUR)
      .create();
  }
}

/** 곧 시작할 일정을 한 번씩 알립니다. 종일 일정은 아침 요약에만 나옵니다. */
function checkUpcomingEvents() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // 이전 실행이 아직 진행 중이면 다음 주기에 처리합니다.

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + CONFIG.REMINDER_MINUTES * 60 * 1000);
    const sent = loadSentReminders_(now);

    getCalendar_()
      .getEvents(now, windowEnd)
      .filter((event) => !event.isAllDayEvent() && event.getStartTime() > now)
      .forEach((event) => {
        // 시작 시각을 키에 넣어 반복 일정의 각 회차와 시간이 바뀐 일정도 따로 알립니다.
        const start = event.getStartTime().getTime();
        const key = `${event.getId()}|${start}`;
        if (sent[key]) return;

        postToSlack_(formatReminder_(event, now));
        sent[key] = start;
        saveSentReminders_(sent);
      });

    saveSentReminders_(sent);
  } finally {
    lock.releaseLock();
  }
}

/** 오늘 일정을 한 메시지로 보냅니다. 일정이 없으면 보내지 않습니다. */
function sendDailySummary() {
  const now = new Date();
  const dayOfWeek = Number(Utilities.formatDate(now, CONFIG.TIME_ZONE, 'u')); // 1=월 ... 7=일
  if (CONFIG.DAILY_SUMMARY_WEEKDAYS_ONLY && dayOfWeek >= 6) return;

  const dayStart = new Date(Utilities.formatDate(now, CONFIG.TIME_ZONE, "yyyy-MM-dd'T'00:00:00XXX"));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const events = getCalendar_().getEvents(dayStart, dayEnd);
  if (events.length === 0) return;

  const date = Utilities.formatDate(now, CONFIG.TIME_ZONE, 'M월 d일');
  const lines = events.map((event) => {
    const time = event.isAllDayEvent() ? '종일' : formatTime_(event.getStartTime());
    return `• ${time}  ${getTitle_(event)}`;
  });
  postToSlack_(`:calendar: *${date} 일정 ${events.length}건*\n${lines.join('\n')}`);
}

function formatReminder_(event, now) {
  const minutes = Math.ceil((event.getStartTime().getTime() - now.getTime()) / 60000);
  const lines = [
    `:bell: *${minutes}분 후 시작*  ${getTitle_(event)}`,
    `:clock3: ${formatTime_(event.getStartTime())} - ${formatTime_(event.getEndTime())}`,
  ];
  const location = event.getLocation();
  if (location) lines.push(`:round_pushpin: ${escapeSlack_(location)}`);
  return lines.join('\n');
}

function getTitle_(event) {
  return escapeSlack_(event.getTitle() || '(제목 없음)');
}

function formatTime_(date) {
  return Utilities.formatDate(date, CONFIG.TIME_ZONE, 'HH:mm');
}

function escapeSlack_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCalendar_() {
  const calendarId = getRequiredProperty_('CALENDAR_ID');
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('캘린더를 찾을 수 없습니다. CALENDAR_ID를 확인하고, 이 계정의 캘린더 목록에 추가되어 있는지 확인하세요.');
  }
  return calendar;
}

function postToSlack_(text) {
  const response = UrlFetchApp.fetch(getRequiredProperty_('SLACK_WEBHOOK_URL'), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text }),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(`Slack 전송 실패 (${code}): ${response.getContentText()}`);
  }
}

function getRequiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`스크립트 속성 ${name}이(가) 설정되지 않았습니다.`);
  return value.trim();
}

/** 알림을 보낸 기록을 읽습니다. 이미 시작한 일정의 기록은 버립니다. */
function loadSentReminders_(now) {
  const raw = PropertiesService.getScriptProperties().getProperty(SENT_PROPERTY);
  const sent = raw ? JSON.parse(raw) : {};
  Object.keys(sent).forEach((key) => {
    if (sent[key] <= now.getTime()) delete sent[key];
  });
  return sent;
}

function saveSentReminders_(sent) {
  PropertiesService.getScriptProperties().setProperty(SENT_PROPERTY, JSON.stringify(sent));
}
