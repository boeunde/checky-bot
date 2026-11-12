/**
 * checky-bot v1.1.0
 * 공용 Google 캘린더 일정을 여러 Slack 채널로 알려 주는 봇입니다.
 * 설정은 Slack에서 합니다. 알림 받을 채널에 봇을 초대하고 그 채널에서 /checky를 입력하세요.
 *
 * 설치 방법은 README.md, 기획은 docs/spec.md를 참고하세요.
 *
 * 스크립트 속성:
 *   SLACK_BOT_TOKEN           Slack 앱의 Bot User OAuth Token (xoxb-...)
 *   SLACK_VERIFICATION_TOKEN  Slack 앱의 Basic Information > Verification Token
 */

// ─── 설정값 ───────────────────────────────────────────────

const TIME_ZONE = 'Asia/Seoul';
const KST_OFFSET = 9 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const SCHEDULE_AHEAD = 25 * MINUTE; // 일정 목록을 만들 때 앞으로 볼 범위
const SCHEDULE_BEHIND = 10 * MINUTE; // 실행이 늦어져도 이 시간 안의 알림은 보냅니다.
const SCHEDULE_CACHE_SECONDS = 30 * 60;
// 알림 목록의 저장 형태가 바뀌면 이름을 바꿉니다. 예전 코드가 만든 목록을 새 코드가 읽지 않도록 하기 위해서입니다.
const SCHEDULE_CACHE_KEY = 'schedule_v2';
const SENT_KEEP = 40 * MINUTE;
const REMINDER_GRACE = 5 * MINUTE; // 일정 시작 후 이 시간이 지나면 늦은 알림을 보내지 않습니다.
const MESSAGE_ATTACHMENT_LIMIT = 50; // Slack 메시지 하나에 붙일 일정(첨부) 수 상한
const DESCRIPTION_LIMIT = 300;
const LOG_LIMIT = 10;
const PREVIEW_LOOKAHEAD_DAYS = 30;
const TEST_LOOKBACK_DAYS = 30;
const TEST_MESSAGE_LIMIT = 10;
const MAX_CALENDAR_TRIGGERS = 15; // Apps Script는 스크립트당 트리거 20개까지 허용합니다.
const NOTIFY_COOLDOWN = 6 * 60 * MINUTE;
const HOME_CHANNEL_LIMIT = 40; // 앱 홈 화면은 블록 100개까지 담을 수 있습니다.

const GITHUB_URL = 'https://github.com/boeunde/checky-bot';
const SPACER_IMAGE = 'https://api.slack.com/img/blocks/bkb_template_images/placeholder.png'; // 화면 여백용 회색 이미지
const REMINDER_OFFSETS = [0, 5, 15, 30, 60];
const DAILY_SCOPES = { all: '모든 일정', allday: '종일 일정만', timed: '시간 일정만' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS = [1, 2, 3, 4, 5];
const REMOVED_ERRORS = ['not_in_channel', 'channel_not_found', 'is_archived'];
const TRIGGER_HANDLERS = ['dispatchDue', 'rebuildSchedule', 'onCalendarChanged'];

const HELP_TEXT = [
  '*Checky Bot 사용법*',
  '1. 알림을 받을 채널에 봇을 초대합니다: `/invite @Checky Bot`',
  '2. 그 채널에서 `/checky`를 입력해 캘린더를 연결하고 알림을 설정합니다.',
  '• `/checky today`: 이 채널 캘린더의 오늘 일정을 나에게만 보여 줍니다.',
  '• `/checky today-all`: 오늘 일정을 채널에 보냅니다 (채널 관리자만).',
  '• 봇 메시지 지우기: 메시지의 ⋯ 메뉴 > Checky Bot 메시지 삭제 (채널 관리자만)',
].join('\n');

// ─── 설치와 자동 실행 ─────────────────────────────────────

/** 처음 한 번 실행합니다. 다시 실행해도 트리거가 중복되지 않습니다. */
function setup() {
  const scriptTimeZone = Session.getScriptTimeZone();
  if (scriptTimeZone !== TIME_ZONE) {
    throw new Error(`프로젝트 시간대가 ${scriptTimeZone}입니다. 프로젝트 설정에서 시간대를 (GMT+09:00) 서울로 바꾼 뒤 다시 실행하세요.`);
  }
  getRequiredProperty_('SLACK_VERIFICATION_TOKEN');
  const auth = slackApi_('auth.test', {});
  withLock_(() => {
    const meta = loadMeta_();
    meta.botUserId = auth.user_id;
    saveJson_('META', meta);
  });

  ScriptApp.getProjectTriggers()
    .filter((trigger) => TRIGGER_HANDLERS.includes(trigger.getHandlerFunction()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('dispatchDue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('rebuildSchedule').timeBased().everyMinutes(10).create();
  syncCalendarTriggers_();
  invalidateSchedule_();
  if (typeof Calendar === 'undefined') {
    console.warn('변경 알림(일정 등록·변경·삭제)을 쓰려면 편집기 왼쪽 서비스 + 에서 Google Calendar API를 추가하세요.');
  }
  console.log(`Slack 봇 ${auth.user}(으)로 연결되었습니다. 이제 웹 앱으로 배포하세요.`);
}

// 자동 실행 함수 셋은 걸린 시간을 날짜별로 기록합니다(하루 90분 한도 확인용, usageReport 참고).
function rebuildSchedule() {
  withUsage_('rebuildSchedule', runRebuildSchedule_);
}

function onCalendarChanged(e) {
  withUsage_('onCalendarChanged', () => runOnCalendarChanged_(e));
}

function dispatchDue() {
  withUsage_('dispatchDue', runDispatchDue_);
}

/** 10분마다: 앞으로 보낼 알림 목록을 새로 만듭니다. */
function runRebuildSchedule_() {
  syncCalendarTriggers_();
  const { failures } = rebuildSchedule_();
  // 변경 알림: 트리거가 없는 캘린더(15개 초과)와 놓친 변경을 여기서 확인합니다.
  failures.push(...syncChanges_());
  if (failures.length) throw new Error(`일부 캘린더를 읽지 못했습니다.\n${failures.join('\n')}`);
}

/** 캘린더가 바뀌면: 다음 1분 실행 때 목록을 다시 만들고, 변경 알림을 켠 캘린더면 바뀐 일정을 확인합니다. */
function runOnCalendarChanged_(e) {
  invalidateSchedule_();
  if (e && e.calendarId) {
    const failures = syncChanges_(e.calendarId);
    if (failures.length) console.error(failures.join('\n'));
  }
}

/** 1분마다: 목록에서 지금 보낼 알림만 보냅니다. 캘린더를 읽지 않아 가볍습니다. */
function runDispatchDue_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('dispatching')) return; // 이전 실행이 아직 진행 중
  cache.put('dispatching', '1', 50);
  try {
    const failures = [];
    const raw = cache.get(SCHEDULE_CACHE_KEY);
    let schedule;
    if (raw) {
      schedule = JSON.parse(raw);
    } else {
      const built = rebuildSchedule_();
      schedule = built.schedule;
      failures.push(...built.failures);
    }

    const now = Date.now();
    const sent = loadSent_(now);
    const due = schedule.items
      .filter((item) => item.at <= now && item.at > now - SCHEDULE_BEHIND && !sent[item.key])
      .filter((item) => item.until === undefined || now <= item.until); // 이미 시작한 지 오래된 일정은 알리지 않습니다.
    mergeItems_(due)
      .sort((a, b) => a.at - b.at)
      .forEach((item) => {
        try {
          postMessage_(item.channel, item.text, item.attachments, item.blocks);
          item.keys.forEach((key) => { sent[key] = item.at + SENT_KEEP; });
          saveJson_('SENT', sent);
        } catch (err) {
          failures.push(`${item.channel}: ${err.message}`);
          handleSendFailure_(item.channel, err);
        }
      });
    try {
      failures.push(...dispatchChanges_(now));
    } catch (err) {
      failures.push(`변경 알림: ${err.message}`);
    }
    if (failures.length) console.error(failures.join('\n'));
  } finally {
    cache.remove('dispatching');
  }
}

function invalidateSchedule_() {
  CacheService.getScriptCache().remove(SCHEDULE_CACHE_KEY);
}

/** 캘린더마다 "변경 시 실행" 트리거를 맞춥니다. 만들 수 없는 캘린더는 10분 주기로만 반영됩니다. */
function syncCalendarTriggers_() {
  const wanted = [];
  loadMeta_().channels.forEach((chId) => {
    const ch = loadChannel_(chId);
    if (!ch) return;
    ch.connections.forEach((conn) => {
      if (!conn.paused && !wanted.includes(conn.calendarId)) wanted.push(conn.calendarId);
    });
  });
  const targets = wanted.slice(0, MAX_CALENDAR_TRIGGERS);
  const existing = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'onCalendarChanged');
  existing.forEach((t) => {
    if (!targets.includes(t.getTriggerSourceId())) ScriptApp.deleteTrigger(t);
  });
  const have = existing.map((t) => t.getTriggerSourceId());
  targets
    .filter((id) => !have.includes(id))
    .forEach((id) => {
      try {
        ScriptApp.newTrigger('onCalendarChanged').forUserCalendar(id).onEventUpdated().create();
      } catch (err) {
        console.warn(`캘린더 변경 트리거를 만들지 못했습니다 (${id}): ${err.message}`);
      }
    });
}

// ─── 알림 목록 만들기 ─────────────────────────────────────

function rebuildSchedule_() {
  const now = Date.now();
  const from = now - SCHEDULE_BEHIND;
  const to = now + SCHEDULE_AHEAD;
  const items = [];
  const failures = [];

  loadMeta_().channels.forEach((chId) => {
    const ch = loadChannel_(chId);
    if (!ch) return;
    const entries = []; // 하루 요약은 채널 안의 캘린더를 한 메시지로 묶기 위해 모읍니다.
    ch.connections.forEach((conn) => {
      if (conn.paused) return;
      try {
        const calendar = CalendarApp.getCalendarById(conn.calendarId);
        setConnectionError_(chId, conn, calendar ? null : 'calendar');
        if (!calendar) return;
        // 하루 요약은 그날 전체가, 1시간 전 알림은 1시간 뒤 일정까지 필요합니다.
        const infos = readEvents_(calendar, kstDayStart_(from), Math.max(kstDayStart_(to) + DAY, to + 61 * MINUTE));
        const color = calendarColor_(calendar);
        entries.push({ conn, infos, color });
        // 설정을 바꾸기 전 시각의 알림은 보내지 않습니다.
        const since = Math.max(from, conn.updatedAt || 0);
        if (conn.reminder.enabled) {
          reminderItems_(conn, infos, since, to, undefined, color).forEach((item) => items.push(Object.assign(item, { channel: chId })));
        }
      } catch (err) {
        failures.push(`${chId} / ${conn.calendarName}: ${err.message}`);
      }
    });
    dailyItems_(chId, entries, from, to).forEach((item) => items.push(Object.assign(item, { channel: chId })));
  });

  const schedule = { builtAt: now, items };
  try {
    CacheService.getScriptCache().put(SCHEDULE_CACHE_KEY, JSON.stringify(schedule), SCHEDULE_CACHE_SECONDS);
  } catch (err) {
    failures.push(`알림 목록 저장 실패: ${err.message}`);
  }
  return { schedule, failures };
}

/**
 * 일정 알림. 요일은 일정이 있는 날 기준입니다. 종일 일정은 "종일 일정 알림"을 켰을 때만 알립니다.
 * onlyDay를 주면 그날 일정만, 요일 설정과 관계없이 만듭니다(테스트용).
 */
function reminderItems_(conn, infos, from, to, onlyDay, color) {
  const r = conn.reminder;
  const items = [];
  infos.forEach((info) => {
    if (info.allDay) {
      if (!r.allDay) return;
      for (let i = 0; i < info.days; i++) {
        const day = info.start + i * DAY;
        if (onlyDay !== undefined ? day !== onlyDay : !r.days.includes(kstParts_(day).dow)) continue;
        const at = day + r.allDayTime * MINUTE;
        if (at < from || at > to) continue;
        items.push({
          at,
          key: `r|${conn.id}|${info.id}|${info.start}|${i}`,
          group: `r|${conn.id}|${at}|${day}`,
          order: day - 1, // 같은 메시지 안에서 종일 일정을 먼저 적습니다.
          header: `*일정 알림* | ${escapeSlack_(conn.calendarName)}`,
          notify: notifyLine_(conn, info),
          attachment: eventAttachment_(color, info, day),
        });
      }
      return;
    }
    const day = kstDayStart_(info.start);
    if (onlyDay !== undefined ? day !== onlyDay : !r.days.includes(kstParts_(info.start).dow)) return;
    const at = info.start - r.offset * MINUTE;
    if (at < from || at > to) return;
    // 시작 시각을 키에 넣어, 일정 시간이 바뀌면 다시 알립니다.
    items.push({
      at,
      until: info.start + REMINDER_GRACE,
      key: `r|${conn.id}|${info.id}|${info.start}`,
      group: `r|${conn.id}|${at}|${day}`,
      order: info.start,
      header: `*일정 알림* | ${escapeSlack_(conn.calendarName)}`,
      notify: notifyLine_(conn, info),
      attachment: eventAttachment_(color, info, day),
    });
  });
  return items;
}

/**
 * 같은 채널·같은 연결·같은 시각의 일정 알림을 한 메시지로 묶습니다.
 * 머리글은 메시지 맨 위에 한 번만 둡니다. 보낸 기록은 일정마다 남기므로(keys),
 * 나중에 같은 시각에 일정이 추가돼도 이미 보낸 일정은 다시 보내지 않습니다.
 */
function mergeItems_(items) {
  const merged = [];
  const groups = {};
  items.forEach((item) => {
    if (!item.group) {
      merged.push(Object.assign({}, item, { keys: [item.key] }));
      return;
    }
    const id = `${item.channel}|${item.group}`;
    if (!groups[id]) {
      groups[id] = { at: item.at, channel: item.channel, text: item.text, parts: [] };
      merged.push(groups[id]);
    }
    groups[id].parts.push(item);
  });
  const result = [];
  merged.forEach((m) => {
    if (!m.parts) {
      result.push(m);
      return;
    }
    const parts = m.parts.sort((a, b) => a.order - b.order);
    for (let i = 0; i < parts.length; i += MESSAGE_ATTACHMENT_LIMIT) {
      const chunk = parts.slice(i, i + MESSAGE_ATTACHMENT_LIMIT);
      const message = eventMessage_(`${chunk[0].header} | 총 ${parts.length}건`, chunk.map((p) => p.notify).join('\n'), chunk.map((p) => p.attachment));
      result.push(Object.assign({ at: m.at, channel: m.channel, keys: chunk.map((p) => p.key) }, message));
    }
  });
  return result;
}

/** 하루 요약. 같은 채널·같은 날·같은 시각에 보낼 캘린더를 모은 뒤, 캘린더마다 메시지 하나씩 만듭니다. */
function dailyItems_(chId, entries, from, to) {
  const groups = {};
  entries.forEach((entry) => {
    const d = entry.conn.daily;
    if (!d.enabled) return;
    const since = Math.max(from, entry.conn.updatedAt || 0);
    for (let day = kstDayStart_(from); day <= to; day += DAY) {
      const at = day + d.time * MINUTE;
      if (at < since || at > to || !d.days.includes(kstParts_(day).dow)) continue;
      const key = `d|${chId}|${dayKey_(day)}|${d.time}`;
      if (!groups[key]) groups[key] = { at, day, entries: [] };
      groups[key].entries.push(entry);
    }
  });
  // 캘린더마다 메시지를 따로 보내므로(머리글이 메시지당 하나) 보낸 기록도 캘린더마다 남깁니다.
  const items = [];
  Object.keys(groups).forEach((key) => {
    const g = groups[key];
    g.entries.forEach((entry) => {
      dailyMessages_(g.day, [entry], g.at).forEach((message) => {
        items.push(Object.assign({ at: g.at, key: `${key}|${entry.conn.id}` }, message));
      });
    });
  });
  return items;
}

// ─── 일정 읽기와 메시지 ───────────────────────────────────

function readEvents_(calendar, from, to) {
  return calendar
    .getEvents(new Date(from), new Date(to))
    .map((event) => eventInfo_(event, calendar.getId()))
    .filter((info) => info.notifiable);
}

function eventInfo_(event, calendarId) {
  const info = {
    id: event.getId(),
    title: (event.getTitle() || '').trim(),
    description: cleanDescription_(event.getDescription()),
    allDay: event.isAllDayEvent(),
  };
  if (info.allDay) {
    info.start = kstDayStart_(event.getAllDayStartDate().getTime());
    const end = kstDayStart_(event.getAllDayEndDate().getTime());
    info.days = Math.max(1, Math.round((end - info.start) / DAY));
    info.end = info.start + info.days * DAY;
  } else {
    info.start = event.getStartTime().getTime();
    info.end = event.getEndTime().getTime();
    info.days = 1;
  }
  // 비공개 일정과, 세부정보를 볼 수 없어 제목이 없는 일정은 보내지 않습니다.
  const visibility = event.getVisibility();
  info.notifiable = info.title !== ''
    && visibility !== CalendarApp.Visibility.PRIVATE
    && visibility !== CalendarApp.Visibility.CONFIDENTIAL;
  info.link = eventLink_(event, calendarId, info);
  // 반복 일정은 "매주 화요일, 13회"처럼 반복 규칙을 작은 회색 글씨로 함께 보여 줍니다.
  if (info.notifiable && isRecurring_(event)) info.recurrence = recurrenceText_(calendarId, String(event.getId()).split('@')[0], info.start);
  return info;
}

function isRecurring_(event) {
  try {
    return event.isRecurringEvent();
  } catch (err) {
    return false;
  }
}

// ─── 반복 규칙 문장 ───────────────────────────────────────
//
// CalendarApp은 반복 규칙을 주지 않아 Google Calendar API(고급 서비스)로 원래 일정의 RRULE을 읽습니다.
// 같은 반복 일정은 6시간 동안 저장해 두고 다시 읽지 않습니다. API가 없거나 읽지 못하면 표시하지 않습니다.

const RECURRENCE_CACHE_SECONDS = 6 * 60 * 60;
const RRULE_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const ORDINALS = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', 5: '다섯째', '-1': '마지막' };

/** seriesId: 반복 일정 원본의 ID. recurrence를 주면 API를 부르지 않습니다. */
function recurrenceText_(calendarId, seriesId, startMs, recurrence) {
  if (recurrence) return describeRecurrence_(recurrence, startMs);
  if (typeof Calendar === 'undefined' || !seriesId) return null;
  const cache = CacheService.getScriptCache();
  const key = `rr|${hash_(`${calendarId}|${seriesId}`)}`;
  let rules = cache.get(key);
  if (rules === null) {
    try {
      rules = (Calendar.Events.get(calendarId, seriesId).recurrence || []).join('\n');
    } catch (err) {
      rules = '';
    }
    cache.put(key, rules || '-', RECURRENCE_CACHE_SECONDS);
  }
  if (!rules || rules === '-') return null;
  return describeRecurrence_(rules.split('\n'), startMs);
}

/** ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=13"] → "매주 화요일, 13회". 문장으로 만들 수 없는 규칙은 "반복 일정"입니다. */
function describeRecurrence_(lines, startMs) {
  const line = lines.find((l) => /^RRULE:/.test(l));
  if (!line) return null;
  const r = {};
  line.slice(6).split(';').forEach((part) => {
    const [k, v] = part.split('=');
    r[k] = v;
  });
  const n = Number(r.INTERVAL || 1);
  const start = kstParts_(startMs);
  const dayName = (code) => `${DAY_NAMES[RRULE_DAYS[code]]}요일`;
  let text = null;
  if (!r.BYSETPOS && !r.BYWEEKNO && !r.BYYEARDAY && !r.BYHOUR) {
    if (r.FREQ === 'DAILY' && !r.BYDAY) {
      text = n === 1 ? '매일' : `${n}일마다`;
    } else if (r.FREQ === 'WEEKLY' || (r.FREQ === 'DAILY' && r.BYDAY)) {
      const codes = r.BYDAY ? r.BYDAY.split(',') : [Object.keys(RRULE_DAYS).find((c) => RRULE_DAYS[c] === start.dow)];
      if (codes.every((c) => c in RRULE_DAYS)) {
        const sorted = WEEK_ORDER.filter((d) => codes.some((c) => RRULE_DAYS[c] === d));
        const days = sorted.join() === WEEKDAYS.join() ? '월-금' : sorted.map((d) => `${DAY_NAMES[d]}요일`).join(', ');
        text = `${n === 1 ? '매주' : `${n}주마다`} ${days}`;
      }
    } else if (r.FREQ === 'MONTHLY') {
      const base = n === 1 ? '매월' : `${n}개월마다`;
      const nth = r.BYDAY && /^(-?\d)([A-Z]{2})$/.exec(r.BYDAY);
      if (nth && ORDINALS[nth[1]] && nth[2] in RRULE_DAYS) text = `${base} ${ORDINALS[nth[1]]} ${dayName(nth[2])}`;
      else if (!r.BYDAY && (!r.BYMONTHDAY || /^\d+$/.test(r.BYMONTHDAY))) text = `${base} ${r.BYMONTHDAY || start.d}일`;
    } else if (r.FREQ === 'YEARLY' && !r.BYDAY) {
      text = `${n === 1 ? '매년' : `${n}년마다`} ${r.BYMONTH || start.m}월 ${r.BYMONTHDAY || start.d}일`;
    }
  }
  if (!text) return '반복 일정';
  if (r.COUNT) text += `, ${r.COUNT}회`;
  else if (r.UNTIL) {
    const u = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(r.UNTIL);
    if (u) {
      const ms = u[4] ? Date.UTC(+u[1], +u[2] - 1, +u[3], +u[5], +u[6], +u[7]) : Date.UTC(+u[1], +u[2] - 1, +u[3]) - KST_OFFSET;
      const p = kstParts_(ms);
      text += `, ${p.y}년 ${p.m}월 ${p.d}일까지`;
    }
  }
  return text;
}

/**
 * 구글 캘린더 일정 링크. Apps Script가 링크를 주지 않아 "일정 ID + 캘린더 ID"로 만듭니다.
 * 반복 일정은 그 회차의 ID(일정 ID_시작 시각)를 씁니다. 캘린더 권한이 있는 사람만 열 수 있습니다.
 */
function eventLink_(event, calendarId, info) {
  try {
    let id = String(event.getId()).split('@')[0];
    if (event.isRecurringEvent()) {
      id += info.allDay
        ? `_${dayKey_(info.start).replace(/-/g, '')}`
        : `_${new Date(info.start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
    }
    const eid = Utilities.base64EncodeWebSafe(`${id} ${calendarId}`).replace(/=+$/, '');
    return `https://www.google.com/calendar/event?eid=${eid}`;
  } catch (err) {
    return null;
  }
}

/** 구글 캘린더 설명의 서식(HTML)을 지우고 일반 글자로 바꿉니다. */
function cleanDescription_(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  text = text.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > DESCRIPTION_LIMIT) text = `${text.slice(0, DESCRIPTION_LIMIT).trim()}…`;
  return text;
}

/*
 * 메시지 모양:
 *
 *   ┃ 오늘 요약 | 11월 9일 월요일 | 디자인팀 | 총 2건   ← 머리글: 첫 색 막대 첨부의 첫 줄
 *   ┃ 종일 창립기념일                                    ← 일정: 색 막대 첨부 안의 rich_text 블록 (제목은 일정 링크)
 *   ┃ 12:00 - 15:00 주간 회의
 *   ┃ 매주 화요일                                        ← 반복 규칙·설명: 같은 첨부 안의 작은 회색 글씨(context)
 *
 * iOS Slack 앱 때문에 이렇게 만듭니다(실제 기기에서 확인한 내용):
 * - 일정 줄을 mrkdwn 링크(<url|제목>)로 만들면 제목 안 이모지 앞 글자가 지워져서, rich_text 링크를 씁니다.
 * - 첨부에 블록을 넣으면 pretext를 같이 쓸 수 없고(invalid_attachments), 머리글만 있는 첨부는 빈 회색 줄이 남습니다.
 * - 머리글을 메시지 본문 블록에 두면 슬랙 알림 탭이 그 블록(머리글)만 보여 줘 일정 제목이 빠집니다.
 * 그래서 메시지 본문(text, blocks)은 비우고, 머리글을 첫 첨부 안에 넣습니다.
 * 잠금화면과 알림 탭은 첫 첨부의 fallback(서식 없는 글자)을 보여 주므로 거기에 캘린더·일정 제목을 넣습니다.
 * 알림이 늦게 도착할 수 있어 "N분 후" 같은 표현은 쓰지 않습니다.
 */

/** 보낼 메시지 하나: 첫 첨부의 맨 위에 머리글을 넣고, 그 첨부의 fallback을 알림 글자로 씁니다. */
function eventMessage_(header, notify, attachments) {
  const [first, ...rest] = attachments;
  const head = Object.assign({}, first, { fallback: notify, blocks: [section_(header)].concat(first.blocks) });
  return { text: '', attachments: [head].concat(rest) };
}

/** 일정 알림 하나(연결 확인용): "일정 알림 | 캘린더 이름" */
function reminderMessage_(conn, color, info, day) {
  const name = escapeSlack_(conn.calendarName);
  return eventMessage_(`*일정 알림* | ${name}`, notifyLine_(conn, info), [eventAttachment_(color, info, day)]);
}

/**
 * 하루 요약. 캘린더마다 메시지 하나(머리글 + 일정들)를 만듭니다.
 * 보낼 내용이 없으면 빈 배열입니다. sendAt을 주면 그 시각 기준으로 "오늘"/"내일"을 붙입니다.
 */
function dailyMessages_(day, entries, sendAt) {
  const messages = [];
  entries.forEach((entry) => {
    const { conn, infos, color } = entry;
    const scope = conn.daily.scope;
    const items = infos
      .filter((i) => scope === 'all' || (scope === 'allday') === i.allDay)
      .filter((i) => (i.allDay ? i.start <= day && i.end > day : i.start >= day && i.start < day + DAY))
      .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
    if (!items.length && conn.daily.empty !== 'send') return;
    const label = `${relativeDay_(day, sendAt) || '하루'} 요약`;
    const header = `${dayHeader_(conn, day, label)} | 총 ${items.length}건`;
    const notify = [`${escapeSlack_(conn.calendarName)} · ${label} · 총 ${items.length}건`]
      .concat(items.map((info) => escapeSlack_(`${whenText_(info)} ${info.title}`)))
      .join('\n');
    let attachments = items.length
      ? items.map((info) => eventAttachment_(color, info, day))
      : [lineAttachment_(color, [{ text: '일정 없음' }])];
    if (attachments.length > MESSAGE_ATTACHMENT_LIMIT) {
      const rest = attachments.length - (MESSAGE_ATTACHMENT_LIMIT - 1);
      attachments = attachments.slice(0, MESSAGE_ATTACHMENT_LIMIT - 1).concat(lineAttachment_(null, [{ text: `외 ${rest}건` }]));
    }
    messages.push(eventMessage_(header, notify, attachments));
  });
  return messages;
}

/** "오늘 요약 | 11월 9일 월요일 | 캘린더 이름" */
function dayHeader_(conn, day, label) {
  return `*${label}* | ${formatDayLong_(day)} | ${escapeSlack_(conn.calendarName)}`;
}

/** 일정 한 줄(+반복 규칙·설명)에 캘린더 색 막대를 붙인 첨부 */
function eventAttachment_(color, info, day) {
  const index = info.allDay ? Math.round((day - info.start) / DAY) : 0;
  return lineAttachment_(color, [
    { text: `${whenText_(info)} | ` },
    { text: info.title, url: info.link },
    { text: info.allDay ? partLabel_(info, index) : '' },
  ], { footer: descriptionText_(info) });
}

/**
 * 색 막대 첨부 하나: 글자 조각들을 rich_text 한 줄로 잇고(url이 있는 조각은 링크),
 * footer가 있으면 그 아래 작은 회색 글씨로 붙입니다. strike면 줄 전체에 취소선을 긋습니다.
 * rich_text 글자는 Slack 서식으로 읽지 않으므로 escapeSlack_를 하지 않습니다.
 */
function lineAttachment_(color, pieces, options) {
  const opts = options || {};
  const elements = pieces.filter((p) => p.text).map((p) => {
    const el = p.url ? { type: 'link', url: p.url, text: p.text } : { type: 'text', text: p.text };
    if (opts.strike) el.style = { strike: true };
    return el;
  });
  const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] }];
  if (opts.footer) blocks.push(context_(opts.footer));
  return withColor_({ fallback: pieces.map((p) => p.text || '').join(''), blocks }, color);
}

/** 알림(잠금화면 등)에 보이는 한 줄: "캘린더 · 14:00 - 15:00 제목" */
function notifyLine_(conn, info) {
  return escapeSlack_(`${conn.calendarName} · ${whenText_(info)} ${info.title}`);
}

function whenText_(info) {
  return info.allDay ? '종일' : `${formatClock_(info.start)} - ${formatClock_(info.end)}`;
}

function withColor_(attachment, color) {
  if (color) attachment.color = color;
  return attachment;
}

function relativeDay_(day, sendAt) {
  if (sendAt === undefined) return null;
  const diff = Math.round((day - kstDayStart_(sendAt)) / DAY);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  return null;
}

function calendarColor_(calendar) {
  try {
    return calendar.getColor() || null;
  } catch (err) {
    return null;
  }
}

/**
 * 반복 규칙("매주 화요일, 13회")과 설명. 색 막대 안 아래쪽의 작은 회색 글씨로 붙입니다.
 * 인용(>)을 쓰면 색 막대 안에 세로줄이 하나 더 생겨서 쓰지 않습니다. 300자까지입니다.
 */
function descriptionText_(info) {
  const text = [info.recurrence, info.description].filter(Boolean).map(escapeSlack_).join('\n');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function partLabel_(info, index) {
  return info.days > 1 ? ` (${index + 1}/${info.days})` : '';
}

function escapeSlack_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 시간 계산 (한국 시간 고정) ───────────────────────────

function kstParts_(ms) {
  const d = new Date(ms + KST_OFFSET);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    dow: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function kstDayStart_(ms) {
  return Math.floor((ms + KST_OFFSET) / DAY) * DAY - KST_OFFSET;
}

function pad2_(n) {
  return String(n).padStart(2, '0');
}

function formatHm_(minutes) {
  return `${pad2_(Math.floor(minutes / 60))}:${pad2_(minutes % 60)}`;
}

function formatClock_(ms) {
  return formatHm_(kstParts_(ms).minutes);
}

function formatDay_(ms) {
  const p = kstParts_(ms);
  return `${p.m}월 ${p.d}일 (${DAY_NAMES[p.dow]})`;
}

function formatDayLong_(ms) {
  const p = kstParts_(ms);
  return `${p.m}월 ${p.d}일 ${DAY_NAMES[p.dow]}요일`;
}

function dayKey_(ms) {
  const p = kstParts_(ms);
  return `${p.y}-${pad2_(p.m)}-${pad2_(p.d)}`;
}

/** "2026/11/09 오후 8:12" */
function formatLogTime_(ms) {
  const p = kstParts_(ms);
  return `${p.y}/${pad2_(p.m)}/${pad2_(p.d)} ${formatAmPm_(p.minutes)}`;
}

// ─── Slack 요청 받기 ──────────────────────────────────────

function doPost(e) {
  try {
    return handleRequest_(e) || text_('');
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return text_('');
  }
}

function handleRequest_(e) {
  const params = (e && e.parameter) || {};
  if (params.payload) {
    const payload = JSON.parse(params.payload);
    return isFromSlack_(payload.token) ? handleInteraction_(payload) : null;
  }
  if (params.command) {
    return isFromSlack_(params.token) ? handleCommand_(params) : null;
  }
  const raw = e && e.postData && e.postData.contents;
  if (!raw) return null;
  const body = JSON.parse(raw);
  if (!isFromSlack_(body.token)) return null;
  if (body.type === 'url_verification') return text_(body.challenge);
  if (body.type === 'event_callback' && body.event) handleEvent_(body.event);
  return null;
}

/** Apps Script는 요청 헤더를 읽지 못해, Slack이 본문에 넣어 보내는 Verification Token으로 확인합니다. */
function isFromSlack_(token) {
  return typeof token === 'string' && token === getRequiredProperty_('SLACK_VERIFICATION_TOKEN');
}

function handleEvent_(event) {
  switch (event.type) {
    case 'app_home_opened':
      if (event.tab === 'home') {
        registerInstallerIfNone_(event.user);
        publishHome_(event.user);
      }
      break;
    case 'member_joined_channel':
      if (event.user === botUserId_()) onBotJoined_(event.channel, event.inviter);
      break;
    case 'channel_left':
    case 'group_left':
      onBotRemoved_(event.channel);
      break;
    default:
      break;
  }
}

/** 봇을 초대한 사람이 그 채널의 첫 관리자가 됩니다. */
function onBotJoined_(chId, inviter) {
  const ch = loadChannel_(chId);
  if (ch && ch.admins.length) {
    // 다시 초대된 경우: 나갈 때 일시정지된 연결이 있으면 재개 방법을 알려 줍니다.
    if (inviter && ch.connections.some((c) => c.pausedReason === 'removed')) {
      postEphemeral_(chId, inviter, '봇이 나가 있던 동안 이 채널의 연결이 일시정지되었습니다. 채널 관리자가 `/checky`에서 [다시 시작]을 누르면 됩니다.');
    }
    return;
  }
  if (!inviter || ineligibleReason_(inviter)) {
    if (!ch) updateChannel_(chId, () => {});
    return;
  }
  updateChannel_(chId, (c) => {
    if (c.admins.length) return;
    c.admins.push(inviter);
    addLog_(c, inviter, '봇을 초대해 첫 관리자가 됨');
  });
  registerInstallerIfNone_(inviter);
  postEphemeral_(chId, inviter, 'Checky Bot을 초대하셨습니다. 이 채널의 관리자로 지정되었습니다. `/checky`를 입력해 캘린더를 연결하세요.');
}

function handleCommand_(p) {
  const text = (p.text || '').trim();
  if (text === 'help' || text === '도움말') return ephemeralJson_(HELP_TEXT);
  registerInstallerIfNone_(p.user_id);
  if (p.channel_name === 'directmessage' || String(p.channel_id).charAt(0) === 'D') {
    return ephemeralJson_('알림을 받을 채널에서 `/checky`를 입력하세요.');
  }

  if (text === 'today' || text === 'today-all') return sendToday_(p, text === 'today-all');

  const ch = loadChannel_(p.channel_id);
  if (!ch || !ch.admins.length) {
    if (!isBotMember_(p.channel_id)) {
      return ephemeralJson_('먼저 이 채널에 Checky Bot을 초대하세요: `/invite @Checky Bot`');
    }
    // 초대 기록이 없는 채널(예: 설치를 마치기 전에 초대된 채널)은 처음 /checky를 실행한 사람이 관리자가 됩니다.
    if (!ineligibleReason_(p.user_id)) {
      updateChannel_(p.channel_id, (c) => {
        if (c.admins.length) return;
        c.admins.push(p.user_id);
        addLog_(c, p.user_id, '첫 관리자로 지정됨');
      });
    }
  }
  slackApi_('views.open', { trigger_id: p.trigger_id, view: channelModal_(p.channel_id, p.user_id) });
  return null;
}

/**
 * /checky today: 이 채널에 연결된 캘린더의 오늘 일정을 나에게만 보이게 보냅니다(채널 멤버 누구나).
 * /checky today-all: 같은 내용을 채널에 보냅니다(채널봇 관리자만).
 * 하루 요약 설정(범위, 요일, 켜짐/꺼짐)과 관계없이 오늘의 모든 일정을 보여 주고, 일정이 없으면 "일정 없음"을 보여 줍니다.
 * 캘린더를 읽느라 Slack의 3초 제한을 넘길 수 있어, 응답 대신 메시지 API로 보냅니다.
 * today-all은 채널 전체에 가므로 확인 창을 먼저 띄우고, [발송]을 누르면 보냅니다(submitTodayAll_).
 */
function sendToday_(p, toChannel) {
  const ch = loadChannel_(p.channel_id);
  const connections = ch ? ch.connections.filter((c) => !c.paused) : [];
  if (!connections.length) return ephemeralJson_('이 채널에 연결된 캘린더가 없습니다. `/checky`에서 캘린더를 추가하세요.');
  if (toChannel && !isAdmin_(ch, p.user_id)) {
    return ephemeralJson_('채널에 보내기는 이 채널의 관리자만 할 수 있습니다. 나만 보려면 `/checky today`를 입력하세요.');
  }
  if (toChannel) {
    slackApi_('views.open', { trigger_id: p.trigger_id, view: todayAllModal_(p.channel_id) });
    return null;
  }
  const error = postToday_(p.channel_id, p.user_id, false);
  return error ? ephemeralJson_(error) : null;
}

function todayAllModal_(chId) {
  return {
    type: 'modal',
    callback_id: 'today_all',
    title: plain_('오늘 일정 발송'),
    submit: plain_('발송'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId }),
    blocks: [section_(`<#${chId}>에 오늘의 전체 일정을 발송하시겠습니까?`)],
  };
}

/** 확인 창의 [발송]. 문제가 있으면 확인 창을 안내로 바꿉니다. */
function submitTodayAll_(meta, userId) {
  const ch = loadChannel_(meta.channelId);
  if (!isAdmin_(ch, userId)) return json_({ response_action: 'update', view: noticeModal_('오늘 일정 발송', '이 채널의 관리자만 보낼 수 있습니다.') });
  const error = postToday_(meta.channelId, userId, true);
  return error ? json_({ response_action: 'update', view: noticeModal_('오늘 일정 발송', error) }) : null;
}

/** 오늘 일정을 채널(toChannel) 또는 나에게만 보냅니다. 실패하면 안내 문구, 성공하면 null. */
function postToday_(chId, userId, toChannel) {
  const ch = loadChannel_(chId);
  const connections = ch ? ch.connections.filter((c) => !c.paused) : [];
  if (!connections.length) return '이 채널에 연결된 캘린더가 없습니다. `/checky`에서 캘린더를 추가하세요.';
  const now = Date.now();
  const day = kstDayStart_(now);
  const entries = [];
  connections.forEach((conn) => {
    const calendar = openCalendar_(conn.calendarId);
    if (!calendar) return;
    entries.push({
      conn: Object.assign({}, conn, { daily: Object.assign({}, conn.daily, { scope: 'all', empty: 'send' }) }),
      infos: readEvents_(calendar, day, day + DAY),
      color: calendarColor_(calendar),
    });
  });
  if (!entries.length) return '연결된 캘린더를 읽지 못했습니다. 공용 구글 계정에 캘린더가 공유돼 있는지 확인하세요.';
  try {
    dailyMessages_(day, entries, now).forEach((m) => {
      if (toChannel) postMessage_(chId, m.text, m.attachments, m.blocks);
      else postEphemeral_(chId, userId, m.text, m.attachments, m.blocks);
    });
  } catch (err) {
    return `보내지 못했습니다: ${err.message}`;
  }
  if (toChannel) updateChannel_(chId, (c) => addLog_(c, userId, '오늘 일정 채널에 발송'));
  return null;
}

function isBotMember_(chId) {
  try {
    return !!slackApi_('conversations.info', { channel: chId }).channel.is_member;
  } catch (err) {
    return false;
  }
}

/**
 * 봇이 채널에서 나간 게 확실할 때만 true. Slack이 "멤버 아님" 또는 "채널 없음"이라고 답한 경우입니다.
 * 그 밖의 오류(일시 장애 등)는 확실하지 않으므로 false입니다.
 */
function botLeftChannel_(chId) {
  try {
    return slackApi_('conversations.info', { channel: chId }).channel.is_member === false;
  } catch (err) {
    return ['channel_not_found', 'is_archived'].includes(err.slackError);
  }
}

function handleInteraction_(payload) {
  const userId = payload.user && payload.user.id;
  if (payload.type === 'block_actions') {
    handleBlockAction_(payload, userId);
    return null;
  }
  if (payload.type === 'view_submission') return handleSubmission_(payload, userId);
  if (payload.type === 'message_action' && payload.callback_id === 'delete_message') {
    handleDeleteMessage_(payload, userId);
  }
  return null;
}

function handleBlockAction_(payload, userId) {
  const action = payload.actions[0];
  const view = payload.view;

  if (action.action_id === 'transfer_installer') {
    if (loadMeta_().installer === userId) {
      slackApi_('views.open', { trigger_id: payload.trigger_id, view: installerModal_(userId) });
    }
    return;
  }

  if (action.action_id === 'open_channel') {
    if (isAdmin_(loadChannel_(action.value), userId)) {
      slackApi_('views.open', { trigger_id: payload.trigger_id, view: channelModal_(action.value, userId) });
    }
    return;
  }

  if (action.action_id === 'home_menu') return; // 홈의 [⋯] 메뉴는 링크만 엽니다.

  const meta = view ? JSON.parse(view.private_metadata || '{}') : {};
  const chId = meta.channelId;
  if (!chId) return;
  const ch = loadChannel_(chId);
  if (!isAdmin_(ch, userId)) return; // 관리자가 아니면 무시합니다.
  if (['toggle_routine', 'pick_tab', 'add_change_set', 'remove_change_set'].includes(action.action_id)) {
    editDraft_(payload, ch, chId, action);
    return;
  }
  if (action.action_id === 'conn_menu') {
    // [⋯] 메뉴: "⚙️ 설정"은 알림 설정 창을, "연결 끊기"는 확인 창을 엽니다.
    // "구글 캘린더 열기"는 Slack이 링크를 바로 열어 할 일이 없습니다.
    const [what, connId] = String((action.selected_option && action.selected_option.value) || '').split('|');
    const target = ch.connections.find((c) => c.id === connId);
    if (what === 'settings' && target) slackApi_('views.push', { trigger_id: payload.trigger_id, view: connModal_(chId, target, view.id) });
    if (what === 'delete' && target) slackApi_('views.push', { trigger_id: payload.trigger_id, view: disconnectModal_(chId, target, view.id) });
    return;
  }
  const conn = ch.connections.find((c) => c.id === action.value);

  switch (action.action_id) {
    case 'add_conn':
      slackApi_('views.push', { trigger_id: payload.trigger_id, view: addConnModal_(chId, view.id) });
      return;
    case 'edit_conn':
      if (conn) slackApi_('views.push', { trigger_id: payload.trigger_id, view: connModal_(chId, conn, view.id) });
      return;
    case 'change_calendar':
      if (conn) slackApi_('views.push', { trigger_id: payload.trigger_id, view: changeCalendarModal_(chId, conn, view.id) });
      return;
    case 'edit_admins':
      slackApi_('views.push', { trigger_id: payload.trigger_id, view: adminsModal_(chId, ch, view.id) });
      return;
    case 'test_conn':
      if (conn) runTest_(chId, conn, userId);
      return;
    case 'toggle_conn':
      if (!conn) return;
      updateChannel_(chId, (c) => {
        const target = c.connections.find((x) => x.id === conn.id);
        if (!target) return;
        target.paused = !target.paused;
        target.pausedReason = target.paused ? 'manual' : null;
        target.updatedAt = Date.now();
        addLog_(c, userId, `${target.paused ? '일시정지' : '다시 시작'}: ${escapeSlack_(target.calendarName)}`);
      });
      break;
    case 'delete_conn':
      if (!conn) return;
      updateChannel_(chId, (c) => {
        c.connections = c.connections.filter((x) => x.id !== conn.id);
        addLog_(c, userId, `연결 끊기: ${escapeSlack_(conn.calendarName)}`);
      });
      invalidateSchedule_();
      // 삭제 버튼은 ⚙️ 설정 화면(위에 쌓인 창)에 있습니다. 아래 채널 화면을 새로 고치고, 설정 화면은 안내로 바꿉니다.
      if (meta.parentViewId) {
        updateView_(meta.parentViewId, channelModal_(chId, userId));
        updateView_(view.id, noticeModal_('알림 설정', `*${escapeSlack_(conn.calendarName)}* 연결을 끊었습니다.`));
      } else {
        updateView_(view.id, channelModal_(chId, userId));
      }
      return;
    default:
      return;
  }
  invalidateSchedule_();
  updateView_(view.id, channelModal_(chId, userId));
}

function handleSubmission_(payload, userId) {
  const view = payload.view;
  const meta = JSON.parse(view.private_metadata || '{}');
  const values = view.state.values;
  try {
    if (view.callback_id === 'installer') return submitInstaller_(values, userId);
    if (view.callback_id === 'delete_message') return submitDeleteMessage_(meta, userId);
    const ch = loadChannel_(meta.channelId);
    if (view.callback_id === 'disconnect') return submitDisconnect_(meta, ch, userId);
    if (view.callback_id === 'today_all') return submitTodayAll_(meta, userId);
    const firstBlock = { add_conn: 'calendar_id', change_calendar: 'calendar_id', conn_settings: 'notice', admins: 'admins' }[view.callback_id];
    if (!firstBlock) return null;
    if (!isAdmin_(ch, userId)) {
      if (view.callback_id === 'conn_settings') return json_({ response_action: 'update', view: noticeModal_('알림 설정', '이 채널의 관리자만 바꿀 수 있습니다.') });
      return errorsJson_({ [firstBlock]: '이 채널의 관리자만 바꿀 수 있습니다.' });
    }
    if (view.callback_id === 'add_conn') return submitAddConn_(meta, ch, values, userId);
    if (view.callback_id === 'conn_settings') return submitConnSettings_(meta, ch, values, userId);
    if (view.callback_id === 'change_calendar') return submitChangeCalendar_(meta, ch, values, userId);
    return submitAdmins_(meta, ch, values, userId);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (view.callback_id === 'conn_settings') return json_({ response_action: 'update', view: noticeModal_('알림 설정', `처리하지 못했습니다: ${err.message}`) });
    const block = { add_conn: 'calendar_id', change_calendar: 'calendar_id', admins: 'admins', installer: 'installer' }[view.callback_id];
    return block ? errorsJson_({ [block]: `처리하지 못했습니다: ${err.message}` }) : null;
  }
}

function submitAddConn_(meta, ch, values, userId) {
  const calendarId = (values.calendar_id.v.value || '').trim();
  if (!calendarId) return errorsJson_({ calendar_id: '캘린더 ID를 입력하세요.' });
  if (ch.connections.some((c) => c.calendarId === calendarId)) {
    return errorsJson_({ calendar_id: '이 채널에 이미 연결된 캘린더입니다.' });
  }
  const calendar = openCalendar_(calendarId);
  if (!calendar) {
    return errorsJson_({
      calendar_id: `공용 구글 계정(${accountEmail_()})이 볼 수 없는 캘린더입니다. 캘린더를 이 계정에 공유했는지, ID가 맞는지 확인하세요.`,
    });
  }

  const conn = newConnection_(calendarId, calendar.getName(), userId);
  updateChannel_(meta.channelId, (c) => {
    c.connections.push(conn);
    addLog_(c, userId, `새 캘린더 추가: ${escapeSlack_(conn.calendarName)}`);
  });
  invalidateSchedule_();
  sendConnectionPreview_(meta.channelId, conn, calendar, userId);
  // 연결 직후 바로 알림 설정 화면을 보여 줍니다. 저장하면 채널 설정 화면도 새로 고칩니다.
  return json_({ response_action: 'update', view: connModal_(meta.channelId, conn, meta.parentViewId) });
}

/** 연결 끊기 확인 창의 [연결 끊기]. 아래 채널 설정 화면을 새로 고치고 확인 창을 닫습니다. */
function submitDisconnect_(meta, ch, userId) {
  if (!isAdmin_(ch, userId)) return json_({ response_action: 'update', view: noticeModal_('연결 끊기', '이 채널의 관리자만 연결을 끊을 수 있습니다.') });
  const conn = ch.connections.find((c) => c.id === meta.connId);
  if (conn) {
    updateChannel_(meta.channelId, (c) => {
      c.connections = c.connections.filter((x) => x.id !== conn.id);
      addLog_(c, userId, `연결 끊기: ${escapeSlack_(conn.calendarName)}`);
    });
    invalidateSchedule_();
  }
  refreshParent_(meta.parentViewId, meta.channelId, userId);
  return null;
}

/**
 * 연결의 캘린더만 바꿉니다. 알림 설정과 일시정지 상태는 그대로 둡니다.
 * 새 캘린더의 변경 감지 트리거는 10분마다 도는 rebuildSchedule이 맞춥니다.
 */
function submitChangeCalendar_(meta, ch, values, userId) {
  const conn = ch.connections.find((c) => c.id === meta.connId);
  if (!conn) return errorsJson_({ calendar_id: '이 연결은 이미 삭제되었습니다.' });
  const calendarId = (values.calendar_id.v.value || '').trim();
  if (!calendarId) return errorsJson_({ calendar_id: '캘린더 ID를 입력하세요.' });
  if (calendarId === conn.calendarId) return null; // 바뀐 게 없으면 그냥 닫습니다.
  if (ch.connections.some((c) => c.calendarId === calendarId)) {
    return errorsJson_({ calendar_id: '이 채널에 이미 연결된 캘린더입니다.' });
  }
  const calendar = openCalendar_(calendarId);
  if (!calendar) {
    return errorsJson_({
      calendar_id: `공용 구글 계정(${accountEmail_()})이 볼 수 없는 캘린더입니다. 캘린더를 이 계정에 공유했는지, ID가 맞는지 확인하세요.`,
    });
  }

  let changed = null;
  updateChannel_(meta.channelId, (c) => {
    const target = c.connections.find((x) => x.id === conn.id);
    if (!target) return;
    const before = target.calendarName;
    target.calendarId = calendarId;
    target.calendarName = calendar.getName();
    target.error = null;
    target.updatedAt = Date.now();
    // 변경 알림은 새 캘린더의 지금 일정을 기준으로 다시 시작합니다.
    if (target.changes) target.changes.since = Date.now();
    addLog_(c, userId, `캘린더 변경: ${escapeSlack_(before)} → ${escapeSlack_(target.calendarName)}`);
    changed = target;
  });
  if (!changed) return errorsJson_({ calendar_id: '이 연결은 이미 삭제되었습니다.' });
  invalidateSchedule_();
  sendConnectionPreview_(meta.channelId, changed, calendar, userId);
  refreshParent_(meta.parentViewId, meta.channelId, userId);
  return null;
}

/**
 * 알림 설정 화면에서 지금 고른 값. 켜기/끄기는 버튼이라 화면 메타데이터(draft)에,
 * 나머지는 입력 값에 있습니다. 숨겨진(꺼진) 루틴의 값은 draft에 남아 있습니다.
 */
function draftFromView_(meta, values, conn) {
  const base = meta.draft || { daily: conn.daily, reminder: conn.reminder, changes: changesOf_(conn) };
  const draft = JSON.parse(JSON.stringify(base));
  draft.changes = normalizeChanges_(draft.changes);
  const pick = (block) => {
    const b = values && values[block];
    return b && b.v && b.v.selected_option ? b.v.selected_option.value : null;
  };
  draft.daily.time = pickedTime_(values || {}, 'daily_time', draft.daily.time);
  draft.daily.scope = pick('daily_scope') || draft.daily.scope;
  draft.daily.empty = pick('daily_empty') || draft.daily.empty;
  const offset = pick('reminder_offset');
  if (offset !== null) draft.reminder.offset = Number(offset);
  draft.reminder.allDayTime = pickedTime_(values || {}, 'reminder_allday_time', draft.reminder.allDayTime);
  const daysIn = (block, current) => {
    const b = values && values[block];
    return b && b.v ? WEEK_ORDER.filter((d) => (b.v.selected_options || []).some((o) => Number(o.value) === d)) : current;
  };
  draft.daily.days = daysIn('daily_days', draft.daily.days);
  draft.reminder.days = daysIn('reminder_days', draft.reminder.days);
  // 변경 알림 세트: 입력칸 이름은 changes_{세트 id}_...
  draft.changes.sets.forEach((s) => {
    const p = `changes_${s.id}`;
    s.days = daysIn(`${p}_days`, s.days);
    const types = values && values[`${p}_types`];
    if (types && types.v) s.types = Object.keys(CHANGE_KINDS).filter((k) => (types.v.selected_options || []).some((o) => o.value === k));
    const wait = pick(`${p}_wait`);
    if (wait !== null) s.wait = Number(wait);
    const past = pick(`${p}_past`);
    if (past !== null) s.past = past === 'on';
    s.holdTime = pickedTime_(values || {}, `${p}_hold_time`, s.holdTime);
  });
  return draft;
}

/** 저장을 막는 문제. 변경 알림의 값은 문제가 있는 세트 순서(1부터)나 겹친 종류 이름 목록입니다. */
function draftProblems_(draft) {
  const problems = {};
  if (!draft.daily.enabled && !draft.reminder.enabled && !draft.changes.enabled) problems.none = true;
  if (draft.daily.enabled && !draft.daily.days.length) problems.daily = true;
  if (draft.reminder.enabled && !draft.reminder.days.length) problems.reminder = true;
  if (draft.changes.enabled) {
    const sets = draft.changes.sets;
    const noTypes = sets.map((s, i) => (s.types.length ? 0 : i + 1)).filter(Boolean);
    const noDays = sets.map((s, i) => (s.days.length ? 0 : i + 1)).filter(Boolean);
    const dup = Object.keys(CHANGE_KINDS).filter((k) => sets.filter((s) => s.types.includes(k)).length > 1).map((k) => CHANGE_KINDS[k]);
    if (noTypes.length) problems.changes = noTypes;
    if (noDays.length) problems.changesDays = noDays;
    if (dup.length) problems.changesDup = dup;
  }
  return problems;
}

/** 켜짐/꺼짐 버튼이나 알림 유형을 고르면 화면을 다시 그립니다. 저장은 [저장]을 눌러야 됩니다. */
function editDraft_(payload, ch, chId, action) {
  const view = payload.view;
  const meta = JSON.parse(view.private_metadata || '{}');
  const conn = ch.connections.find((c) => c.id === meta.connId);
  if (!conn) return;
  const draft = draftFromView_(meta, view.state && view.state.values, conn);
  // 켜짐/꺼짐 버튼은 value에, 알림 유형 드롭다운은 고른 항목(selected_option)에 루틴 이름이 있습니다.
  const name = action.action_id === 'pick_tab' ? action.selected_option && action.selected_option.value : action.value;
  if (action.action_id === 'toggle_routine' && name === 'allday') {
    draft.reminder.allDay = !draft.reminder.allDay; // 일정 알림 안의 "종일 일정 알림"
  } else if (action.action_id === 'toggle_routine' && /^hold:/.test(name)) {
    // 변경 알림 세트 안의 "미설정요일 알림 모아보내기"
    const set = draft.changes.sets.find((s) => String(s.id) === name.slice(5));
    if (set) set.hold = !set.hold;
  } else if (action.action_id === 'add_change_set') {
    // 새 세트는 아직 어느 세트에도 없는 종류를 골라 둔 채로 추가합니다.
    const sets = draft.changes.sets;
    if (sets.length >= Object.keys(CHANGE_KINDS).length) return;
    const set = defaultChangeSet_(Math.max(...sets.map((s) => s.id)) + 1);
    set.types = Object.keys(CHANGE_KINDS).filter((k) => !sets.some((s) => s.types.includes(k)));
    sets.push(set);
  } else if (action.action_id === 'remove_change_set') {
    draft.changes.sets = draft.changes.sets.filter((s, i) => i === 0 || String(s.id) !== String(action.value));
  } else {
    if (!draft[name]) return;
    if (action.action_id === 'toggle_routine') draft[name].enabled = !draft[name].enabled;
    else draft.tab = name;
  }
  updateView_(view.id, connModal_(chId, conn, meta.parentViewId, draft));
}

function submitConnSettings_(meta, ch, values, userId) {
  const current = ch.connections.find((x) => x.id === meta.connId);
  if (!current) return json_({ response_action: 'update', view: noticeModal_('알림 설정', '이 연결은 이미 삭제되었습니다.') });
  const draft = draftFromView_(meta, values, current);
  // 문제가 있으면 같은 화면을 경고와 함께 다시 보여 줍니다(버튼 항목에는 Slack 오류 표시를 붙일 수 없습니다).
  if (Object.keys(draftProblems_(draft)).length) {
    return json_({ response_action: 'update', view: connModal_(meta.channelId, current, meta.parentViewId, draft) });
  }
  const daily = draft.daily;
  const reminder = draft.reminder;
  const changes = draft.changes;

  const saved = updateChannel_(meta.channelId, (c) => {
    const target = c.connections.find((x) => x.id === meta.connId);
    if (!target) return false;
    target.daily = daily;
    target.reminder = reminder;
    // 변경 알림을 새로 켜면 그 시점의 일정을 기준으로 삼아, 그 뒤의 변경부터 알립니다.
    const wasOn = changesOf_(target).enabled;
    target.changes = {
      enabled: changes.enabled,
      since: changes.enabled && !wasOn ? Date.now() : changesOf_(target).since,
      sets: changes.sets.map((s) => {
        const set = { id: s.id };
        CHANGE_SET_KEYS.forEach((k) => (set[k] = s[k]));
        return set;
      }),
    };
    target.updatedAt = Date.now();
    addLog_(c, userId, `알림 설정 변경: ${escapeSlack_(target.calendarName)}`);
    return true;
  });
  if (!saved) return json_({ response_action: 'update', view: noticeModal_('알림 설정', '이 연결은 이미 삭제되었습니다.') });
  invalidateSchedule_();
  refreshParent_(meta.parentViewId, meta.channelId, userId);
  return null;
}

function submitAdmins_(meta, ch, values, userId) {
  const users = values.admins.v.selected_users || [];
  if (!users.length) return errorsJson_({ admins: '관리자는 최소 1명이어야 합니다.' });
  for (const user of users.filter((u) => !ch.admins.includes(u))) {
    const reason = ineligibleReason_(user);
    if (reason) return errorsJson_({ admins: `${reason}은(는) 관리자가 될 수 없습니다.` });
  }
  updateChannel_(meta.channelId, (c) => {
    c.admins = users;
    addLog_(c, userId, `관리자 변경: ${users.map((u) => `<@${u}>`).join(', ')}`);
  });
  refreshParent_(meta.parentViewId, meta.channelId, userId);
  return null;
}

function submitInstaller_(values, userId) {
  const next = values.installer.v.selected_user;
  if (loadMeta_().installer !== userId) return errorsJson_({ installer: '현재 앱 설치자만 바꿀 수 있습니다.' });
  if (!next) return errorsJson_({ installer: '새 앱 설치자를 고르세요.' });
  const reason = ineligibleReason_(next);
  if (reason) return errorsJson_({ installer: `${reason}은(는) 앱 설치자가 될 수 없습니다.` });
  withLock_(() => {
    const meta = loadMeta_();
    meta.installer = next;
    saveJson_('META', meta);
  });
  publishHome_(userId);
  return null;
}

function handleDeleteMessage_(payload, userId) {
  const chId = payload.channel.id;
  const message = payload.message || {};
  const respond = (text) => respondEphemeral_(payload.response_url, text);
  if (!isAdmin_(loadChannel_(chId), userId)) {
    respond('이 채널의 관리자만 Checky Bot 메시지를 지울 수 있습니다.');
    return;
  }
  const fromBot = message.user === botUserId_()
    || (message.bot_profile && message.bot_profile.app_id === payload.api_app_id)
    || (message.app_id && message.app_id === payload.api_app_id);
  if (!fromBot) {
    respond('Checky Bot이 보낸 메시지만 지울 수 있습니다.');
    return;
  }
  // 실수로 지우지 않도록 확인 창을 먼저 띄웁니다. 삭제는 확인 창의 [삭제]를 눌러야 실행됩니다.
  slackApi_('views.open', { trigger_id: payload.trigger_id, view: deleteConfirmModal_(chId, message, payload.response_url) });
}

function submitDeleteMessage_(meta, userId) {
  const respond = (text) => {
    if (meta.responseUrl) respondEphemeral_(meta.responseUrl, text);
  };
  if (!isAdmin_(loadChannel_(meta.channelId), userId)) return null;
  try {
    slackApi_('chat.delete', { channel: meta.channelId, ts: meta.ts });
  } catch (err) {
    respond(err.slackError === 'message_not_found' ? '이미 삭제된 메시지입니다.' : `메시지를 삭제하지 못했습니다: ${err.message}`);
    return null;
  }
  updateChannel_(meta.channelId, (c) => addLog_(c, userId, '봇 메시지 삭제'));
  respond('메시지를 삭제했습니다.');
  return null;
}

// ─── 연결 확인과 테스트 ───────────────────────────────────

function newConnection_(calendarId, calendarName, userId) {
  return {
    id: Utilities.getUuid().slice(0, 8),
    calendarId,
    calendarName,
    paused: false,
    pausedReason: null,
    error: null,
    createdBy: userId,
    updatedAt: Date.now(),
    daily: { enabled: true, time: 9 * 60, scope: 'all', days: WEEKDAYS.slice(), empty: 'skip' },
    reminder: { enabled: false, offset: 15, allDay: false, allDayTime: 9 * 60, days: WEEKDAYS.slice() },
    changes: defaultChanges_(),
  };
}

/** 목록에 없는 캘린더는 구독을 시도합니다. 공유받지 않았으면 null입니다. */
function openCalendar_(calendarId) {
  try {
    return CalendarApp.getCalendarById(calendarId) || CalendarApp.subscribeToCalendar(calendarId) || null;
  } catch (err) {
    return null;
  }
}

function sendConnectionPreview_(chId, conn, calendar, userId) {
  const now = Date.now();
  const next = readEvents_(calendar, now, now + PREVIEW_LOOKAHEAD_DAYS * DAY)
    .filter((i) => i.end > now)
    .sort((a, b) => a.start - b.start)[0];
  const head = `[연결 확인] *${escapeSlack_(conn.calendarName)}* 캘린더를 연결했습니다.`;
  if (!next) {
    postEphemeral_(chId, userId, `${head}\n예정된 일정이 없습니다.`);
    return;
  }
  const index = next.allDay ? Math.max(0, Math.round((kstDayStart_(now) - next.start) / DAY)) : 0;
  const day = next.allDay ? next.start + index * DAY : kstDayStart_(next.start);
  const message = reminderMessage_(conn, calendarColor_(calendar), next, day);
  postEphemeral_(chId, userId, `${head}\n가장 가까운 일정:`, message.attachments);
}

/** 일정이 있었던 가장 최근 지난 하루를 현재 설정 형식으로, 누른 관리자에게만 보여 줍니다. */
function runTest_(chId, conn, userId) {
  // 실제 알림과 같은 모양으로 보냅니다. 나에게만 보이는 메시지라 "[테스트]" 같은 표시는 붙이지 않습니다.
  const say = (text, attachments, blocks) => postEphemeral_(chId, userId, text, attachments, blocks);
  const name = escapeSlack_(conn.calendarName);
  const calendar = openCalendar_(conn.calendarId);
  if (!calendar) {
    say(`*${name}* 캘린더에 접근할 수 없습니다. 공용 구글 계정(${accountEmail_()})에 공유돼 있는지 확인하세요.`);
    return;
  }
  const today = kstDayStart_(Date.now());
  const infos = readEvents_(calendar, today - TEST_LOOKBACK_DAYS * DAY, today);
  const days = [];
  infos.forEach((i) => {
    if (i.allDay) {
      for (let k = 0; k < i.days; k++) if (i.start + k * DAY < today) days.push(i.start + k * DAY);
    } else if (i.start < today) {
      days.push(kstDayStart_(i.start));
    }
  });
  if (!days.length) {
    say(`*${name}* 캘린더에 최근 ${TEST_LOOKBACK_DAYS}일 동안 보낼 일정이 없습니다.`);
    return;
  }

  const day = Math.max(...days);
  const color = calendarColor_(calendar);
  const messages = [];
  if (conn.daily.enabled) {
    const daily = dailyMessages_(day, [{ conn, infos, color }]);
    if (daily.length) daily.forEach((m) => messages.push(m));
    else messages.push({ text: `${formatDay_(day)}에는 하루 요약 범위(${DAILY_SCOPES[conn.daily.scope]})에 맞는 일정이 없어 보내지 않습니다.` });
  }
  if (conn.reminder.enabled) {
    mergeItems_(reminderItems_(conn, infos, -Infinity, Infinity, day, color))
      .sort((a, b) => a.at - b.at)
      .forEach((item) => messages.push(item));
  }
  say(`*${name}*, *${formatDay_(day)}* 에 등록된 일정입니다.`);
  messages.slice(0, TEST_MESSAGE_LIMIT).forEach((m) => say(m.text, m.attachments, m.blocks));
  if (messages.length > TEST_MESSAGE_LIMIT) say(`외 ${messages.length - TEST_MESSAGE_LIMIT}건은 생략했습니다.`);
}

// ─── 변경 알림 ───────────────────────────────────────────
//
// 1. 캘린더가 바뀌면(onCalendarChanged) 또는 10분마다, 변경 알림을 켠 캘린더를 Google Calendar API로
//    "지난번 이후 바뀐 일정"만 받아 옵니다(syncToken). 고급 서비스 "Google Calendar API"가 필요합니다.
// 2. 일정마다 저장해 둔 요약(제목·시간·설명)과 비교해 등록/변경/삭제를 판단하고 대기 목록에 넣습니다.
//    참석자 응답처럼 이 셋이 아닌 변경은 무시합니다.
// 3. 1분마다(dispatchDue) 마지막 변경 뒤 대기 시간이 지난 것만 보냅니다. 대기 중에 또 바뀌면 다시 기다립니다.

const CHANGE_WAITS = [0, 1, 3]; // 분
const CHANGE_KINDS = { created: '등록', updated: '변경', deleted: '삭제' };
const SNAPSHOT_KEEP = 30 * DAY; // 이보다 오래 지난 일정의 요약은 지웁니다(저장 공간 절약).
const CHUNK_SIZE = 2500; // 스크립트 속성 한 칸(9KB)에 한글이 들어가도 넘지 않는 글자 수

/**
 * 변경 알림은 세트 목록(sets)입니다. 기본은 세트 1개이고, [+ 세트 추가]로 최대 3개까지 늘립니다.
 * 알림 종류(등록·변경·삭제)마다 한 세트에만 넣을 수 있어, 알림 하나는 많아야 한 세트의 설정을 따릅니다.
 * 세트의 값:
 *   id: 세트를 지워도 바뀌지 않는 번호(화면 입력칸 이름에 씁니다). 화면의 "세트 N"은 순서입니다.
 *   days: 변경 알림을 보내는 요일(보내는 날 기준).
 *   hold: 고르지 않은 요일에 생긴 알림을 모아 두었다가 돌아오는 첫 요일의 holdTime에 보낼지. 끄면 그 알림은 보내지 않습니다.
 */
function defaultChangeSet_(id) {
  return { id: id || 1, types: [], wait: 1, past: false, days: WEEKDAYS.slice(), hold: false, holdTime: 9 * 60 };
}

function defaultChanges_() {
  return { enabled: false, since: 0, sets: [defaultChangeSet_(1)] };
}

const CHANGE_SET_KEYS = ['types', 'wait', 'past', 'days', 'hold', 'holdTime'];

/** 빠진 값을 기본값으로 채웁니다. */
function normalizeChanges_(saved) {
  if (!saved) return defaultChanges_();
  const sets = Array.isArray(saved.sets) && saved.sets.length ? saved.sets : [{}];
  return {
    enabled: !!saved.enabled,
    since: saved.since || 0,
    sets: sets.map((s, i) => Object.assign(defaultChangeSet_(i + 1), s)),
  };
}

function changesOf_(conn) {
  return normalizeChanges_(conn.changes);
}

/** 이 알림 종류(created/updated/deleted)를 고른 세트. 없으면 그 종류는 알리지 않습니다. */
function changeSetFor_(changes, kind) {
  return changes.sets.find((s) => s.types.includes(kind)) || null;
}

/** 고르지 않은 요일에 모은 알림을 보낼 시각: now 다음으로 오는 고른 요일의 holdTime */
function nextHoldRelease_(set, now) {
  for (let i = 1; i <= 7; i++) {
    const day = kstDayStart_(now) + i * DAY;
    if (set.days.includes(kstParts_(day).dow)) return day + set.holdTime * MINUTE;
  }
  return null;
}

/** 캘린더 ID → 변경 알림을 켠 연결 목록 */
function watchedCalendars_() {
  const watched = {};
  loadMeta_().channels.forEach((chId) => {
    const ch = loadChannel_(chId);
    if (!ch) return;
    ch.connections.forEach((conn) => {
      if (conn.paused || !changesOf_(conn).enabled) return;
      (watched[conn.calendarId] = watched[conn.calendarId] || []).push({ chId, conn });
    });
  });
  return watched;
}

/** calendarId를 주면 그 캘린더만, 없으면 변경 알림을 켠 모든 캘린더를 확인합니다. */
function syncChanges_(calendarId) {
  const watched = watchedCalendars_();
  const ids = calendarId ? [calendarId].filter((id) => watched[id]) : Object.keys(watched);
  if (!calendarId) cleanupCalendarStates_(watched);
  if (!ids.length) return [];
  if (typeof Calendar === 'undefined') {
    notifyInstallerOnce_('calendar-api', ':warning: 변경 알림을 쓰려면 Apps Script 편집기 왼쪽 *서비스 +* 에서 *Google Calendar API*를 추가해야 합니다. 추가하기 전까지 변경 알림은 보내지 않습니다.');
    return [];
  }
  const failures = [];
  ids.forEach((id) => {
    try {
      syncCalendar_(id, watched[id]);
    } catch (err) {
      failures.push(`변경 알림 ${id}: ${err.message}`);
    }
  });
  return failures;
}

function syncCalendar_(calendarId, watchers) {
  const key = calendarStateKey_(calendarId);
  const now = Date.now();
  const state = loadChunked_(key);
  let changes;
  let next;
  if (!state) {
    // 처음: 지금 일정을 기준으로 저장합니다. 켠 뒤 첫 확인 전에 바뀐 일정은 알립니다.
    ({ state: next, changes } = fullSync_(calendarId, now, Math.min(...watchers.map((w) => changesOf_(w.conn).since || now))));
  } else {
    let listed;
    try {
      listed = listEvents_(calendarId, { syncToken: state.token }); // 이어 받기에는 삭제된 일정도 함께 옵니다.
    } catch (err) {
      if (!/410|sync ?token/i.test(err.message)) throw err;
      // 구글이 확인 기록을 지웠으면 처음부터 다시 받습니다. 마지막 확인 이후 바뀐 일정만 알립니다.
      ({ state: next, changes } = fullSync_(calendarId, now, state.syncedAt));
      listed = null;
    }
    if (listed) {
      next = state;
      changes = listed.items.map((ev) => diffEvent_(calendarId, ev, next, now)).filter(Boolean);
      next.token = listed.token;
    }
  }
  next.syncedAt = now;
  pruneSnapshots_(next, now);
  saveChunked_(key, next);
  if (changes.length) queueChanges_(watchers, changes, now);
}

function fullSync_(calendarId, now, since) {
  const listed = listEvents_(calendarId, {});
  const state = { token: listed.token, baselineAt: now, syncedAt: now, ev: {} };
  const changes = [];
  listed.items.forEach((ev) => {
    const snap = snapshot_(ev);
    if (!snap) return;
    state.ev[ev.id] = snap;
    const updated = Date.parse(ev.updated || '') || 0;
    if (since && updated >= since) {
      const created = Date.parse(ev.created || '') || 0;
      changes.push(changeOf_(calendarId, ev, snap, created >= since ? 'created' : 'updated', now));
    }
  });
  return { state, changes };
}

function listEvents_(calendarId, params) {
  const items = [];
  let pageToken;
  let token = null;
  do {
    const res = Calendar.Events.list(calendarId, Object.assign({ maxResults: 250, singleEvents: false, pageToken }, params));
    (res.items || []).forEach((item) => items.push(item));
    pageToken = res.nextPageToken;
    token = res.nextSyncToken || token;
  } while (pageToken);
  return { items, token };
}

/** 비교용 요약. 비공개이거나 제목이 없어(세부정보를 볼 수 없어) 알리지 않을 일정은 null입니다. */
function snapshot_(ev) {
  if (ev.status === 'cancelled') return null;
  if (ev.visibility === 'private' || ev.visibility === 'confidential') return null;
  const title = (ev.summary || '').trim();
  if (!title) return null;
  const time = apiTimes_(ev.start, ev.end);
  return {
    t: title.slice(0, 80),
    s: time.start,
    e: time.end,
    a: time.allDay ? 1 : 0,
    r: ev.recurrence ? 1 : 0,
    rt: ev.recurrence ? describeRecurrence_(ev.recurrence, time.start) : undefined, // 삭제 알림에 쓸 반복 규칙 문장
    h: hash_([title, JSON.stringify(ev.start), JSON.stringify(ev.end), ev.description || ''].join('\u0001')),
  };
}

function apiTimes_(start, end) {
  if (start && start.date) {
    const s = Date.parse(`${start.date}T00:00:00+09:00`);
    const e = end && end.date ? Date.parse(`${end.date}T00:00:00+09:00`) : s + DAY;
    return { allDay: true, start: s, end: e };
  }
  return { allDay: false, start: Date.parse(start.dateTime), end: Date.parse(end.dateTime) };
}

/** 바뀐 일정 하나를 등록/변경/삭제로 판단합니다. 알릴 것이 없으면 null. */
function diffEvent_(calendarId, ev, state, now) {
  const prev = state.ev[ev.id];
  if (ev.status === 'cancelled') {
    if (prev) {
      delete state.ev[ev.id];
      return { id: ev.id, kind: 'deleted', info: infoFromSnap_(prev), past: !prev.r && prev.e < now };
    }
    // 반복 일정의 한 회차만 삭제: 원래 일정의 제목과 그 회차 시각으로 알립니다.
    const master = ev.recurringEventId && state.ev[ev.recurringEventId];
    if (!master || !ev.originalStartTime) return null;
    const start = apiTimes_(ev.originalStartTime, ev.originalStartTime).start;
    const info = { title: master.t, start, end: start + (master.e - master.s), allDay: !!master.a, recurring: false };
    return { id: ev.id, kind: 'deleted', info, past: info.end < now };
  }
  const snap = snapshot_(ev);
  if (!snap) {
    // 공개 일정을 비공개로 바꾸면 삭제로 봅니다.
    if (!prev) return null;
    delete state.ev[ev.id];
    return { id: ev.id, kind: 'deleted', info: infoFromSnap_(prev), past: !prev.r && prev.e < now };
  }
  state.ev[ev.id] = snap;
  if (prev && prev.h === snap.h) return null; // 제목·시간·설명이 그대로면(예: 참석자 응답) 알리지 않습니다.
  const created = Date.parse(ev.created || '') || 0;
  const existedBefore = prev || ev.recurringEventId || (created && created < state.baselineAt);
  return changeOf_(calendarId, ev, snap, existedBefore ? 'updated' : 'created', now);
}

function changeOf_(calendarId, ev, snap, kind, now) {
  const info = {
    title: snap.t,
    start: snap.s,
    end: snap.e,
    allDay: !!snap.a,
    recurring: !!snap.r,
    link: ev.htmlLink || null,
    description: cleanDescription_(ev.description),
  };
  if (snap.r) {
    // 반복 일정은 다음 회차를 보여 줍니다. 다음 회차가 없으면 끝난 반복 일정입니다.
    const next = nextOccurrence_(calendarId, ev.id, now);
    if (next) Object.assign(info, next);
    info.recurrence = describeRecurrence_(ev.recurrence, snap.s);
  } else if (ev.recurringEventId) {
    // 반복 일정의 한 회차만 바꾼 경우에도 어떤 반복 일정인지 보여 줍니다.
    info.recurrence = recurrenceText_(calendarId, ev.recurringEventId, snap.s);
  }
  return { id: ev.id, kind, info, past: snap.r ? !info.upcoming : info.end < now };
}

function nextOccurrence_(calendarId, eventId, now) {
  try {
    const res = Calendar.Events.instances(calendarId, eventId, { timeMin: new Date(now).toISOString(), maxResults: 1 });
    const item = res.items && res.items[0];
    if (!item) return null;
    const time = apiTimes_(item.start, item.end);
    return { start: time.start, end: time.end, upcoming: true };
  } catch (err) {
    return null;
  }
}

function infoFromSnap_(snap) {
  return { title: snap.t, start: snap.s, end: snap.e, allDay: !!snap.a, recurring: !!snap.r, recurrence: snap.rt || null, link: null, description: '' };
}

function pruneSnapshots_(state, now) {
  Object.keys(state.ev).forEach((id) => {
    const snap = state.ev[id];
    if (!snap.r && snap.e < now - SNAPSHOT_KEEP) delete state.ev[id];
  });
}

/** 같은 일정의 변경을 합칩니다. 등록 뒤 변경은 등록, 등록 뒤 삭제는 알림 없음(null)입니다. */
function mergeKind_(before, after) {
  if (!before) return after;
  if (before === 'created') return after === 'deleted' ? null : 'created';
  if (before === 'deleted') return after === 'deleted' ? 'deleted' : 'updated';
  return after === 'deleted' ? 'deleted' : 'updated';
}

function queueChanges_(watchers, changes, now) {
  withLock_(() => {
    const pending = loadChunked_('PENDING') || {};
    watchers.forEach(({ chId, conn }) => {
      changes.forEach((change) => {
        const key = `${conn.id}|${change.id}`;
        const kind = mergeKind_(pending[key] && pending[key].kind, change.kind);
        if (!kind) {
          delete pending[key];
          return;
        }
        // 이미 다음 요일로 미뤄 둔 알림이면 그 시각(holdUntil)을 유지합니다.
        // 종류가 바뀌면(예: 변경 → 삭제) 다른 세트를 따를 수 있어 미룬 시각을 새로 정합니다.
        const holdUntil = pending[key] && pending[key].kind === kind && pending[key].holdUntil;
        pending[key] = { chId, connId: conn.id, kind, info: change.info, past: change.past, at: now };
        if (holdUntil) pending[key].holdUntil = holdUntil;
      });
    });
    saveChunked_('PENDING', pending);
  });
}

/** 1분마다: 대기 시간이 지난 변경 알림을 보냅니다. */
function dispatchChanges_(now) {
  const failures = [];
  const ready = [];
  withLock_(() => {
    const pending = loadChunked_('PENDING');
    if (!pending || !Object.keys(pending).length) return;
    const channels = {};
    Object.keys(pending).forEach((key) => {
      const p = pending[key];
      if (!(p.chId in channels)) channels[p.chId] = loadChannel_(p.chId);
      const conn = channels[p.chId] && channels[p.chId].connections.find((c) => c.id === p.connId);
      const settings = conn && changesOf_(conn);
      // 알림 종류를 고른 세트의 설정(요일·대기·과거 일정·모아 보내기)을 보내는 순간 기준으로 따릅니다.
      const set = settings && changeSetFor_(settings, p.kind);
      if (!conn || conn.paused || !settings.enabled || !set) {
        delete pending[key];
        return;
      }
      if (now < p.at + set.wait * MINUTE) return; // 아직 기다리는 중
      if (p.holdUntil && now < p.holdUntil) return; // 다음 요일로 미뤄 둔 알림
      if (!p.holdUntil && !set.days.includes(kstParts_(now).dow)) {
        // 고르지 않은 요일: 모아 보내기를 켰으면 돌아오는 첫 요일로 미루고, 아니면 보내지 않습니다.
        const release = set.hold && nextHoldRelease_(set, now);
        if (release) p.holdUntil = release;
        else delete pending[key];
        return;
      }
      delete pending[key];
      if (p.past && !set.past) return;
      ready.push(Object.assign({ conn }, p));
    });
    saveChunked_('PENDING', pending);
  });

  // 등록·변경·삭제는 일정마다 메시지를 따로 보냅니다(같은 시각이어도 묶지 않습니다). 일정 시각 순서로 보냅니다.
  const colors = {};
  ready.sort((a, b) => a.info.start - b.info.start).forEach((p) => {
    const { chId, conn, kind } = p;
    if (!(conn.calendarId in colors)) colors[conn.calendarId] = calendarColor_(openCalendar_(conn.calendarId));
    try {
      const message = changeMessage_(conn, colors[conn.calendarId], kind, p.info);
      postMessage_(chId, message.text, message.attachments, message.blocks);
    } catch (err) {
      failures.push(`${chId}: ${err.message}`);
      handleSendFailure_(chId, err);
    }
  });
  return failures;
}

/** "일정 등록 | 캘린더" 머리글 + 일정 한 줄(색 막대) */
function changeMessage_(conn, color, kind, info) {
  const label = `일정 ${CHANGE_KINDS[kind]}`;
  const name = escapeSlack_(conn.calendarName);
  return eventMessage_(`*${label}* | ${name}`, escapeSlack_(`${conn.calendarName} · ${label} · ${info.title}`), [changeAttachment_(color, kind, info)]);
}

function changeAttachment_(color, kind, info) {
  const deleted = kind === 'deleted';
  const lastDay = info.allDay ? info.end - DAY : info.start;
  let date = formatDay_(info.start);
  if (info.allDay && kstDayStart_(lastDay) > kstDayStart_(info.start)) date += ` - ${formatDay_(lastDay)}`;
  // 삭제된 반복 일정은 저장해 둔 날짜가 첫 회차라 날짜를 빼고 시간만 보여 줍니다.
  if (deleted && info.recurring) date = '';
  return lineAttachment_(color, [
    // "11월 11일 (수) | 16:10 - 20:10 | 제목": 날짜·시간·제목을 | 로 나눠 읽기 쉽게 합니다.
    { text: `${date ? `${date} | ` : ''}${whenText_(info)} | ` },
    { text: info.title, url: deleted ? null : info.link }, // 삭제된 일정은 링크가 없습니다.
    // 반복 규칙 문장(작은 회색 줄)을 만들지 못했을 때만 제목 뒤에 "(반복)"을 붙입니다.
    { text: info.recurring && !info.recurrence ? ' (반복)' : '' },
  ], {
    strike: deleted, // 삭제된 일정은 날짜·시간·제목 줄 전체에 취소선을 긋습니다.
    footer: descriptionText_(deleted ? { recurrence: info.recurrence } : info), // 삭제 알림에는 반복 규칙만 남깁니다.
  });
}

function calendarStateKey_(calendarId) {
  return `CS_${hash_(calendarId)}`;
}

/** 변경 알림을 끈 캘린더의 저장 기록을 지웁니다. 다시 켜면 그때 일정을 새 기준으로 삼습니다. */
function cleanupCalendarStates_(watched) {
  const index = loadJson_('CS_INDEX', {});
  let changed = false;
  Object.keys(index).forEach((id) => {
    if (watched[id]) return;
    deleteChunked_(index[id]);
    delete index[id];
    changed = true;
  });
  Object.keys(watched).forEach((id) => {
    if (index[id]) return;
    index[id] = calendarStateKey_(id);
    changed = true;
  });
  if (changed) saveJson_('CS_INDEX', index);
}

/** 짧은 해시(비교·키 용도). 보안 용도가 아닙니다. */
function hash_(text) {
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = (a * 33) ^ c;
    b = (b * 31) ^ c;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

// 스크립트 속성은 한 칸에 9KB까지라, 큰 값은 여러 칸에 나눠 저장합니다.
function loadChunked_(key) {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(`${key}#n`) || 0);
  if (!count) return null;
  let raw = '';
  for (let i = 0; i < count; i++) raw += props.getProperty(`${key}#${i}`) || '';
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null; // 깨진 기록은 버리고 새로 만듭니다.
  }
}

function saveChunked_(key, value) {
  const props = PropertiesService.getScriptProperties();
  const raw = JSON.stringify(value);
  const count = Math.max(1, Math.ceil(raw.length / CHUNK_SIZE));
  const old = Number(props.getProperty(`${key}#n`) || 0);
  for (let i = 0; i < count; i++) props.setProperty(`${key}#${i}`, raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  for (let i = count; i < old; i++) props.deleteProperty(`${key}#${i}`);
  props.setProperty(`${key}#n`, String(count));
}

function deleteChunked_(key) {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(`${key}#n`) || 0);
  for (let i = 0; i < count; i++) props.deleteProperty(`${key}#${i}`);
  props.deleteProperty(`${key}#n`);
}

// ─── 장애 처리 ────────────────────────────────────────────

function setConnectionError_(chId, conn, error) {
  if ((conn.error || null) === error) return;
  updateChannel_(chId, (c) => {
    const target = c.connections.find((x) => x.id === conn.id);
    if (target) target.error = error;
  });
  const where = `<#${chId}> 채널의 *${escapeSlack_(conn.calendarName)}*`;
  notifyInstaller_(error
    ? `:warning: ${where} 캘린더에 접근할 수 없어 알림을 건너뜁니다. 공용 구글 계정(${accountEmail_()})에 캘린더가 공유돼 있는지 확인하세요. 권한이 돌아오면 자동으로 다시 보냅니다.`
    : `:white_check_mark: ${where} 캘린더에 다시 접근할 수 있어 알림을 재개합니다.`);
}

function handleSendFailure_(chId, err) {
  if (REMOVED_ERRORS.includes(err.slackError)) {
    onBotRemoved_(chId);
    return;
  }
  notifyInstallerOnce_(`send|${chId}|${err.slackError || 'unknown'}`, `:warning: <#${chId}> 채널에 알림을 보내지 못했습니다: ${err.message}`);
}

/** 봇이 채널에서 나가면 그 채널의 연결을 모두 일시정지하고 설치자에게 알립니다. */
/**
 * 봇이 채널에서 나가면: 연결이 없는 채널은 기록(관리자·변경 기록)을 지워 홈 목록에서도 빠지게 하고,
 * 연결이 있는 채널은 다시 초대했을 때 이어 쓰도록 기록을 남긴 채 모두 일시정지합니다.
 */
function onBotRemoved_(chId) {
  const ch = loadChannel_(chId);
  if (!ch) return;
  if (!ch.connections.length) {
    forgetChannel_(chId);
    return;
  }
  const targets = ch.connections.filter((c) => c.pausedReason !== 'removed');
  if (!targets.length) return;
  updateChannel_(chId, (c) => {
    c.connections.forEach((x) => {
      x.paused = true;
      x.pausedReason = 'removed';
    });
    addLog_(c, null, '봇이 채널에서 나가 모든 연결을 일시정지함');
  });
  invalidateSchedule_();
  notifyInstaller_(`⏸️ Checky Bot이 <#${chId}> 채널에서 나가, 이 채널의 연결 ${targets.length}개를 일시정지했습니다. 봇을 다시 초대한 뒤 채널 관리자가 \`/checky\`에서 [다시 시작]을 누르세요.`);
}

function notifyInstaller_(text) {
  const installer = loadMeta_().installer;
  if (!installer) {
    console.warn(`설치자가 없어 알리지 못했습니다: ${text}`);
    return;
  }
  try {
    postMessage_(installer, text);
  } catch (err) {
    console.error(`설치자에게 DM을 보내지 못했습니다: ${err.message}`);
  }
}

/** 같은 문제는 6시간에 한 번만 알립니다. */
function notifyInstallerOnce_(key, text) {
  const now = Date.now();
  const notified = loadJson_('NOTIFIED', {});
  Object.keys(notified).forEach((k) => {
    if (notified[k] <= now) delete notified[k];
  });
  if (notified[key]) return;
  notified[key] = now + NOTIFY_COOLDOWN;
  saveJson_('NOTIFIED', notified);
  notifyInstaller_(text);
}

// ─── 실행 시간 기록 ───────────────────────────────────────
// 개인 Gmail 계정은 자동 실행 시간이 하루 90분으로 제한됩니다. 넘으면 그날은 알림이 멈춥니다.
// 자동 실행마다 걸린 시간을 USAGE에 날짜별로 더하고, USAGE_WARN_MINUTES를 넘으면 앱 설치자에게 하루 한 번 DM을 보냅니다.
// 실행 준비 시간 등은 빠지므로 구글이 세는 시간보다 조금 적게 나옵니다. 겹쳐 실행되면 일부가 빠질 수도 있습니다.

const USAGE_KEEP_DAYS = 14;
const USAGE_WARN_MINUTES = 60;
const USAGE_LIMIT_MINUTES = 90;

function withUsage_(name, run) {
  const start = Date.now();
  try {
    run();
  } finally {
    try {
      recordUsage_(name, Date.now() - start, start);
    } catch (err) {
      console.warn(`실행 시간을 기록하지 못했습니다: ${err.message}`);
    }
  }
}

function recordUsage_(name, ms, at) {
  const usage = loadJson_('USAGE', {});
  const day = dayKey_(at);
  const today = (usage[day] = usage[day] || {});
  today[name] = (today[name] || 0) + ms;
  Object.keys(usage).sort().slice(0, -USAGE_KEEP_DAYS).forEach((d) => delete usage[d]);
  const total = usageTotal_(today);
  const warn = !today.warned && total >= USAGE_WARN_MINUTES * MINUTE;
  if (warn) today.warned = true;
  saveJson_('USAGE', usage);
  if (warn) {
    notifyInstaller_(`:warning: Checky Bot의 오늘 자동 실행 시간이 ${Math.round(total / MINUTE)}분입니다. 하루 ${USAGE_LIMIT_MINUTES}분을 넘으면 그날 남은 시간 동안 알림이 멈춥니다. 연결한 캘린더 수를 줄이거나 Apps Script 실행 기록을 확인하세요.`);
  }
}

function usageTotal_(day) {
  return TRIGGER_HANDLERS.reduce((sum, name) => sum + (day[name] || 0), 0);
}

/** 편집기에서 실행: 최근 7일의 하루 자동 실행 시간을 로그에 보여 줍니다. */
function usageReport() {
  const usage = loadJson_('USAGE', {});
  const days = Object.keys(usage).sort().slice(-7);
  const minutes = (ms) => `${Math.round((ms / MINUTE) * 10) / 10}분`;
  const lines = days.map((d) => {
    const parts = TRIGGER_HANDLERS.filter((n) => usage[d][n]).map((n) => `${n} ${minutes(usage[d][n])}`);
    return `${d}  ${minutes(usageTotal_(usage[d]))}  (${parts.join(', ')})`;
  });
  const text = lines.length
    ? `하루 자동 실행 시간 (한도 ${USAGE_LIMIT_MINUTES}분)\n${lines.join('\n')}`
    : '아직 기록이 없습니다. 자동 실행이 돌기 시작하면 쌓입니다.';
  console.log(text);
  return text;
}

// ─── 저장소 ───────────────────────────────────────────────

function loadJson_(key, fallback) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? JSON.parse(raw) : fallback;
}

function saveJson_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function loadMeta_() {
  return loadJson_('META', { installer: null, botUserId: null, channels: [] });
}

function loadChannel_(chId) {
  const ch = chId ? loadJson_(`CH_${chId}`, null) : null;
  return ch;
}

function newChannel_(chId) {
  return { id: chId, admins: [], connections: [], log: [] };
}

function loadSent_(now) {
  const sent = loadJson_('SENT', {});
  Object.keys(sent).forEach((key) => {
    if (sent[key] <= now) delete sent[key];
  });
  return sent;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('다른 변경이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function updateChannel_(chId, fn) {
  return withLock_(() => {
    const ch = loadChannel_(chId) || newChannel_(chId);
    const result = fn(ch);
    saveJson_(`CH_${chId}`, ch);
    const meta = loadMeta_();
    if (!meta.channels.includes(chId)) {
      meta.channels.push(chId);
      saveJson_('META', meta);
    }
    return result;
  });
}

/** 채널 기록을 지우고 채널 목록에서 뺍니다. 다시 초대하면 처음부터 시작합니다. */
function forgetChannel_(chId) {
  withLock_(() => {
    PropertiesService.getScriptProperties().deleteProperty(`CH_${chId}`);
    const meta = loadMeta_();
    if (meta.channels.includes(chId)) {
      meta.channels = meta.channels.filter((id) => id !== chId);
      saveJson_('META', meta);
    }
  });
}

function addLog_(ch, userId, text) {
  ch.log.unshift({ at: Date.now(), user: userId, text });
  ch.log = ch.log.slice(0, LOG_LIMIT);
}

function isAdmin_(ch, userId) {
  return !!ch && ch.admins.includes(userId);
}

function registerInstallerIfNone_(userId) {
  if (!userId || loadMeta_().installer || ineligibleReason_(userId)) return;
  withLock_(() => {
    const meta = loadMeta_();
    if (meta.installer) return;
    meta.installer = userId;
    saveJson_('META', meta);
  });
}

function botUserId_() {
  const meta = loadMeta_();
  if (meta.botUserId) return meta.botUserId;
  const id = slackApi_('auth.test', {}).user_id;
  withLock_(() => {
    const m = loadMeta_();
    m.botUserId = id;
    saveJson_('META', m);
  });
  return id;
}

function getRequiredProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`스크립트 속성 ${name}이(가) 설정되지 않았습니다.`);
  return value.trim();
}

function accountEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '공용 구글 계정';
  } catch (err) {
    return '공용 구글 계정';
  }
}

// ─── Slack API ────────────────────────────────────────────

function slackApi_(method, params) {
  const payload = {};
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null) return;
    payload[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  const response = UrlFetchApp.fetch(`https://slack.com/api/${method}`, {
    method: 'post',
    headers: { Authorization: `Bearer ${getRequiredProperty_('SLACK_BOT_TOKEN')}` },
    payload,
    muteHttpExceptions: true,
  });
  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error(`Slack ${method} 응답을 읽지 못했습니다 (${response.getResponseCode()})`);
  }
  if (!data.ok) {
    const error = new Error(`Slack ${method} 실패: ${data.error}`);
    error.slackError = data.error;
    throw error;
  }
  return data;
}

/** 채널 ID 대신 사용자 ID를 주면 그 사람에게 DM으로 갑니다. */
/** blocks가 있으면 text는 본문에 보이지 않고 알림에만 쓰입니다. */
function postMessage_(channel, text, attachments, blocks) {
  return slackApi_('chat.postMessage', { channel, text, blocks, attachments, unfurl_links: false, unfurl_media: false });
}

function postEphemeral_(channel, user, text, attachments, blocks) {
  try {
    slackApi_('chat.postEphemeral', { channel, user, text, blocks, attachments });
  } catch (err) {
    console.error(`나에게만 보이는 메시지를 보내지 못했습니다: ${err.message}`);
  }
}

function respondEphemeral_(responseUrl, text) {
  UrlFetchApp.fetch(responseUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ response_type: 'ephemeral', text }),
    muteHttpExceptions: true,
  });
}

function ineligibleReason_(userId) {
  const user = slackApi_('users.info', { user: userId }).user || {};
  if (user.deleted) return '비활성화된 계정';
  if (user.is_bot || user.id === 'USLACKBOT') return '봇';
  if (user.is_restricted || user.is_ultra_restricted) return '게스트 계정';
  return null;
}

function updateView_(viewId, view) {
  slackApi_('views.update', { view_id: viewId, view });
}

function refreshParent_(parentViewId, chId, userId) {
  if (!parentViewId) return;
  try {
    updateView_(parentViewId, channelModal_(chId, userId));
  } catch (err) {
    console.warn(`설정 화면을 새로 고치지 못했습니다: ${err.message}`);
  }
}

function text_(text) {
  return ContentService.createTextOutput(text);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ephemeralJson_(text) {
  return json_({ response_type: 'ephemeral', text });
}

function errorsJson_(errors) {
  return json_({ response_action: 'errors', errors });
}

// ─── 화면 ─────────────────────────────────────────────────

function plain_(text) {
  return { type: 'plain_text', text, emoji: true };
}

function section_(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context_(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/** 끝 글자에 받침이 있으면 "을", 없으면 "를"을 붙입니다: 등록을, 삭제를 */
function withObjectParticle_(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}을(를)`;
  return `${word}${code % 28 ? '을' : '를'}`;
}

function button_(text, actionId, value) {
  // Slack은 버튼 값이 문자열이 아니면 화면 전체를 거부합니다.
  return { type: 'button', text: plain_(text), action_id: actionId, value: String(value) };
}

function confirm_(title, text, ok) {
  return { title: plain_(title), text: plain_(text), confirm: plain_(ok), deny: plain_('취소'), style: 'danger' };
}

function input_(blockId, label, element, optional) {
  return { type: 'input', block_id: blockId, label: plain_(label), optional: !!optional, element: Object.assign({ action_id: 'v' }, element) };
}

function option_(text, value) {
  return { text: plain_(text), value: String(value) };
}

function findOption_(options, value) {
  return options.find((o) => o.value === String(value));
}

/**
 * 시각 고르기: Slack 기본 시간 선택기. 목록 간격은 Slack이 정해 바꿀 수 없지만,
 * 칸에 "9:15"처럼 직접 입력하면 분 단위로 고를 수 있습니다.
 */
function timePicker_(blockId, label, minutes) {
  return input_(blockId, label, { type: 'timepicker', initial_time: formatHm_(minutes) });
}

/** timePicker_로 고른 "HH:mm"을 자정부터의 분으로 바꿉니다. 값이 없으면 fallback을 씁니다. */
function pickedTime_(values, blockId, fallback) {
  const block = values[blockId];
  const time = block && block.v && block.v.selected_time;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "오전 9:00", "오후 12:30" */
function formatAmPm_(minutes) {
  const hour = Math.floor(minutes / 60) % 12 || 12;
  return `${minutes >= 12 * 60 ? '오후' : '오전'} ${hour}:${pad2_(minutes % 60)}`;
}

function select_(options, value) {
  return { type: 'static_select', options, initial_option: findOption_(options, value) };
}

/** "월-금", "매일", "월, 화, 금" */
function describeDays_(days) {
  const sorted = WEEK_ORDER.filter((d) => days.includes(d));
  if (sorted.length === 7) return '매일';
  if (sorted.join() === WEEKDAYS.join()) return '월-금';
  return sorted.map((d) => DAY_NAMES[d]).join(', ');
}

function offsetChoiceLabel_(offset) {
  if (offset === 0) return '시작 시간';
  if (offset === 60) return '1시간 전';
  return `${offset}분 전`;
}

// 채널 설정 화면의 루틴 요약 한 줄씩. 맨 앞에 이모지와 루틴 이름을 붙입니다.
const SEP = '  |  ';

/** "📅 하루 요약 (월-금)  |  오전 7:00  |  모든 일정  |  일정없음 알림 O" (요일은 일정 알림처럼 이름 옆에) */
function describeDaily_(d) {
  if (!d.enabled) return null;
  return [`📅 하루 요약 (${describeDays_(d.days)})`, formatAmPm_(d.time), DAILY_SCOPES[d.scope], `일정없음 알림 ${d.empty === 'send' ? 'O' : 'X'}`].join(SEP);
}

/**
 * "🔔 일정 알림 (월, 화, 금)  |  일정 5분 전에  |  종일 일정 알림 O (오후 2:00)"
 * 요일은 시간 일정과 종일 일정에 함께 적용되므로, 줄 끝이 아니라 루틴 이름 옆에 적습니다.
 */
function describeReminder_(r) {
  if (!r.enabled) return null;
  const when = r.offset === 0 ? '일정 시작 시간에' : `일정 ${offsetChoiceLabel_(r.offset)}에`;
  const allDay = r.allDay ? `종일 일정 알림 O (${formatAmPm_(r.allDayTime)})` : '종일 일정 알림 X';
  return [`🔔 일정 알림 (${describeDays_(r.days)})`, when, allDay].join(SEP);
}

/**
 * 세트마다 한 줄:
 * "✏️ 변경 알림 (월-금)  |  등록, 삭제만  |  1분 대기 후 알림  |  과거 일정 변경 알림 X  |  미설정요일 알림 모아보내기 O (오전 9:00)"
 */
function describeChanges_(c) {
  if (!c.enabled) return [];
  return c.sets.map((s) => {
    const picked = Object.keys(CHANGE_KINDS).filter((k) => s.types.includes(k)).map((k) => CHANGE_KINDS[k]);
    const types = picked.length === Object.keys(CHANGE_KINDS).length ? picked.join(', ') : `${picked.join(', ')}만`;
    const held = s.hold ? `미설정요일 알림 모아보내기 O (${formatAmPm_(s.holdTime)})` : '미설정요일 알림 모아보내기 X';
    return [`✏️ 변경 알림 (${describeDays_(s.days)})`, types, `${changeWaitLabel_(s.wait)} 알림`, `과거 일정 변경 알림 ${s.past ? 'O' : 'X'}`, held].join(SEP);
  });
}

function changeWaitLabel_(wait) {
  return wait === 0 ? '즉시' : `${wait}분 대기 후`;
}

/** 알림 중일 때는 상태 줄을 따로 보여 주지 않습니다. */
function connectionStatus_(conn) {
  // Slack에는 :pause_button: 이름이 없어(⏸는 :double_vertical_bar:) 문자 그대로 넣습니다.
  if (conn.paused) return conn.pausedReason === 'removed' ? '⏸️ 봇이 채널에서 나가 일시정지 중' : '⏸️ 일시정지 중';
  if (conn.error === 'calendar') return ':warning: 캘린더 접근 불가';
  return null;
}

/** 캘린더 이름에 거는 링크. 캘린더를 볼 권한이 있는 사람만 열 수 있습니다. */
function calendarLink_(calendarId) {
  return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendarId)}&ctz=${encodeURIComponent(TIME_ZONE)}`;
}

/** 변경 기록 한 건: "*디자인팀  |  알림 설정 변경*\n@사람  |  2026/11/09 오후 8:12" */
function formatLog_(entry) {
  const at = entry.text.indexOf(': ');
  const head = at > 0 ? `${entry.text.slice(at + 2)}${SEP}${entry.text.slice(0, at)}` : entry.text;
  return `*${head}*\n${entry.user ? `<@${entry.user}>` : 'Checky Bot'}${SEP}${formatLogTime_(entry.at)}`;
}

function channelModal_(chId, userId) {
  const ch = loadChannel_(chId) || newChannel_(chId);
  const admin = isAdmin_(ch, userId);
  const top = section_(`현재 채널: <#${chId}>`);
  if (admin) top.accessory = Object.assign(button_('캘린더 추가', 'add_conn', 'add'), { style: 'primary' });
  // 채널봇 관리자는 맨 위 "현재 채널" 바로 아래에 둡니다.
  const admins = section_(`관리자: ${ch.admins.map((u) => `<@${u}>`).join(', ') || '없음'}`);
  if (admin) admins.accessory = button_('관리자 변경', 'edit_admins', 'admins');
  const blocks = [top, admins, { type: 'divider' }];

  if (!ch.connections.length) blocks.push(context_('연결된 캘린더가 없습니다.'), { type: 'divider' });
  ch.connections.forEach((conn) => {
    // 캘린더 이름(구글 캘린더 링크) + 켜 둔 루틴 요약 + 일시정지·오류일 때만 상태 줄. 꺼 둔 루틴은 줄을 뺍니다.
    // 일시정지 중이면 루틴 줄마다 취소선을 긋습니다.
    const routines = [describeDaily_(conn.daily), describeReminder_(conn.reminder), ...describeChanges_(changesOf_(conn))]
      .filter(Boolean)
      .map((line) => (conn.paused ? `~${line}~` : line));
    const summary = section_(`*<${calendarLink_(conn.calendarId)}|${escapeSlack_(conn.calendarName)}>*`);
    if (admin) {
      summary.accessory = {
        type: 'overflow',
        action_id: 'conn_menu',
        options: [
          { text: plain_('⚙️ 설정'), value: `settings|${conn.id}` },
          { text: plain_('구글 캘린더 열기'), value: `open|${conn.id}`, url: calendarLink_(conn.calendarId) },
          { text: plain_('연결 끊기'), value: `delete|${conn.id}` },
        ],
      };
    }
    blocks.push(summary);
    // 루틴 줄과 상태 줄은 작은 회색 글씨(context 블록)로 보여 줍니다.
    const details = [...routines, connectionStatus_(conn)].filter(Boolean);
    if (details.length) blocks.push(context_(details.join('\n')));
    if (admin) {
      blocks.push({
        type: 'actions',
        elements: [
          button_('연결상태 테스트', 'test_conn', conn.id),
          Object.assign(button_(conn.paused ? '다시 시작' : '일시정지', 'toggle_conn', conn.id), conn.paused ? { style: 'primary' } : {}),
          button_('캘린더 바꾸기', 'change_calendar', conn.id),
          button_('⚙️ 설정', 'edit_conn', conn.id),
        ],
      });
    }
    blocks.push({ type: 'divider' });
  });

  // 연결 목록은 구분선으로 끝나므로, 변경사항은 바로 이어 붙입니다.
  if (ch.log.length) {
    // 연결 목록과 변경사항 사이 여백. Slack 블록에는 여백 설정이 없어 작은 빈 이미지로 띄웁니다.
    blocks.push({ type: 'context', elements: [{ type: 'image', image_url: SPACER_IMAGE, alt_text: ' ' }] });
    blocks.push(context_('변경사항 (최근 5건까지 표시)'));
    ch.log.slice(0, 5).forEach((entry, i) => {
      if (i > 0) blocks.push({ type: 'divider' });
      blocks.push(context_(formatLog_(entry))); // 작은 회색 글씨
    });
  }

  return {
    type: 'modal',
    callback_id: 'channel',
    title: plain_('Checky Bot 설정'),
    close: plain_('닫기'),
    private_metadata: JSON.stringify({ channelId: chId }),
    blocks,
  };
}

/** [⋯] > 연결 끊기를 누르면 여는 확인 창 */
function disconnectModal_(chId, conn, parentViewId) {
  return {
    type: 'modal',
    callback_id: 'disconnect',
    title: plain_('연결 끊기'),
    submit: plain_('연결 끊기'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, connId: conn.id, parentViewId }),
    blocks: [
      section_(`*${escapeSlack_(conn.calendarName)}* 캘린더와 <#${chId}> 채널의 연결을 끊을까요?`),
      context_('알림 설정도 함께 지워지며 되돌릴 수 없습니다. 캘린더의 일정은 지워지지 않습니다.'),
    ],
  };
}

function addConnModal_(chId, parentViewId) {
  return {
    type: 'modal',
    callback_id: 'add_conn',
    title: plain_('캘린더 추가'),
    submit: plain_('추가'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, parentViewId }),
    blocks: [
      input_('calendar_id', '캘린더 ID', { type: 'plain_text_input', placeholder: plain_('예: abc123@group.calendar.google.com') }),
      context_(`공용 구글 계정 *${accountEmail_()}* 에 캘린더를 공유한 뒤, 구글 캘린더의 설정 및 공유 > 캘린더 통합에 있는 캘린더 ID를 넣으세요.`),
    ],
  };
}

/** 캘린더 이름 버튼을 누르면 여는 화면. 지금 캘린더 ID를 채워 둡니다. */
function changeCalendarModal_(chId, conn, parentViewId) {
  return {
    type: 'modal',
    callback_id: 'change_calendar',
    title: plain_('캘린더 변경'),
    submit: plain_('변경'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, connId: conn.id, parentViewId }),
    blocks: [
      section_(`지금 연결: *${escapeSlack_(conn.calendarName)}*`),
      input_('calendar_id', '캘린더 ID', { type: 'plain_text_input', initial_value: conn.calendarId }),
      context_(`알림 설정은 그대로 두고 캘린더만 바꿉니다. 새 캘린더는 공용 구글 계정 *${accountEmail_()}* 에 공유돼 있어야 합니다.`),
    ],
  };
}

/**
 * 알림 설정 화면. draft는 저장 전 고른 값이며, 없으면 저장된 설정으로 그립니다.
 * Slack에는 토글 스위치가 없어 켜기/끄기는 버튼으로 만들고, 누를 때마다 화면을 다시 그립니다(editDraft_).
 * 꺼진 루틴은 세부 항목을 숨깁니다. 알림 유형 드롭다운에서 고른 유형만 보여 줍니다.
 */
function connModal_(chId, conn, parentViewId, draft) {
  draft = draft || JSON.parse(JSON.stringify({ daily: conn.daily, reminder: conn.reminder, changes: changesOf_(conn) }));
  draft.changes = normalizeChanges_(draft.changes);
  const d = draft.daily;
  const r = draft.reminder;
  const c = draft.changes;
  const problems = draftProblems_(draft);
  const scopes = Object.keys(DAILY_SCOPES).map((k) => option_(DAILY_SCOPES[k], k));
  const empties = [option_('보내지 않음', 'skip'), option_('"일정 없음"으로 보내기', 'send')];
  const offsets = REMINDER_OFFSETS.map((o) => option_(offsetChoiceLabel_(o), o));

  const tab = ['reminder', 'changes'].includes(draft.tab) ? draft.tab : 'daily';
  // 알림 유형 드롭다운: 고른 유형의 설정만 보여 줍니다. 숨긴 유형의 값은 draft에 남아 함께 저장됩니다.
  // 드롭다운 항목은 일반 글자라 굵게(*) 표시할 수 없습니다.
  const kinds = [
    option_(`📅 하루 요약  |  ${d.enabled ? '켜짐' : '꺼짐'}`, 'daily'),
    option_(`🔔 일정 알림  |  ${r.enabled ? '켜짐' : '꺼짐'}`, 'reminder'),
    option_(`✏️ 변경 알림  |  ${c.enabled ? '켜짐' : '꺼짐'}`, 'changes'),
  ];
  const blocks = [
    // 맨 위 줄 오른쪽에 [연결 끊기]를 둡니다. Slack 모달 아래쪽 [취소]/[저장] 영역에는 버튼을 더할 수 없습니다.
    Object.assign(section_(`*${escapeSlack_(conn.calendarName)}* 일정을 <#${chId}>에 발송합니다.`), {
      block_id: 'danger',
      accessory: Object.assign(button_('연결 끊기', 'delete_conn', conn.id), {
        style: 'danger',
        confirm: confirm_('연결 끊기', `${conn.calendarName} 연결을 끊을까요? 알림 설정도 함께 지워지며 되돌릴 수 없습니다.`, '연결 끊기'),
      }),
    }),
    Object.assign(section_('알림 유형'), {
      block_id: 'tabs',
      accessory: { type: 'static_select', action_id: 'pick_tab', options: kinds, initial_option: findOption_(kinds, tab) },
    }),
  ];
  // 경고는 지금 보이지 않는 유형의 문제도 보이도록 알림 유형 바로 아래에 둡니다.
  if (problems.none) blocks.push(context_(':warning: 하루 요약, 일정 알림, 변경 알림 중 하나 이상 켜야 저장됩니다.'));
  if (problems.daily) blocks.push(context_(':warning: 하루 요약의 요일을 하나 이상 고르세요.'));
  if (problems.reminder) blocks.push(context_(':warning: 일정 알림의 요일을 하나 이상 고르세요.'));
  const setNames = (nums) => nums.map((n) => `세트 ${n}`).join(', ');
  // 변경 알림 경고는 변경 알림을 보고 있을 때는 [켜짐] 버튼 바로 아래에, 다른 유형을 보고 있을 때는 여기에 둡니다.
  const onChanges = tab === 'changes';
  const where = onChanges ? '' : '변경 알림 ';
  const changeWarnings = [];
  if (problems.changes) changeWarnings.push(context_(`:warning: ${where}${setNames(problems.changes)}의 알림 종류를 하나 이상 고르세요.`));
  if (problems.changesDays) changeWarnings.push(context_(`:warning: ${where}${setNames(problems.changesDays)}의 요일을 하나 이상 고르세요.`));
  if (problems.changesDup) changeWarnings.push(context_(`:warning: ${where}${withObjectParticle_(problems.changesDup.join(', '))} 여러 세트에서 골랐습니다. 알림 종류마다 한 세트에만 넣으세요.`));
  if (!onChanges) blocks.push(...changeWarnings);
  blocks.push({ type: 'divider' });

  if (tab === 'daily') {
    blocks.push(routineHeader_('daily', '*하루 요약*\n등록되어있는 당일 일정을 일정한 시각에 알립니다.', d.enabled));
    if (d.enabled) {
      // 채널 설정 화면의 요약 줄과 같은 순서: 요일 → 시각 → 범위 → 그 밖의 설정
      blocks.push(
        dayPicker_('daily', d.days),
        timePicker_('daily_time', '보내는 시각', d.time),
        { type: 'divider' },
        input_('daily_scope', '범위', select_(scopes, d.scope)),
        input_('daily_empty', '일정이 없는 날', { type: 'radio_buttons', options: empties, initial_option: findOption_(empties, d.empty) }),
      );
    }
  } else if (tab === 'reminder') {
    blocks.push(routineHeader_('reminder', '*일정 알림*\n일정에 등록된 시간에 맞춰 알림을 받습니다.', r.enabled));
    if (r.enabled) {
      // 요약 줄과 같은 순서: 요일 → 알림 시점 → 종일 일정 알림
      blocks.push(dayPicker_('reminder', r.days), input_('reminder_offset', '시간 일정 알림 시점', select_(offsets, r.offset)));
      // 종일 일정은 시작 시각이 없어 따로 켜고, 켜면 알릴 시각을 고릅니다.
      const allDay = section_('*종일 일정 알림*\n종일로 설정된 일정은 일정한 시각에 알립니다.');
      allDay.block_id = 'reminder_allday_enabled';
      allDay.accessory = Object.assign(button_(r.allDay ? '● 켜짐' : '○ 꺼짐', 'toggle_routine', 'allday'), r.allDay ? { style: 'primary' } : {});
      blocks.push({ type: 'divider' }, allDay);
      if (r.allDay) blocks.push(timePicker_('reminder_allday_time', '종일 일정 알림 시각', r.allDayTime));
    }
  } else {
    blocks.push(routineHeader_('changes', '*변경 알림*\n일정이 등록·변경·삭제되면 알림을 받습니다. 발송 시점으로 설정된 시간 동안 다시 변경하면 마지막 상태만 알림을 받습니다.', c.enabled));
    if (c.enabled) blocks.push(...changeWarnings);
    if (c.enabled) {
      const kinds = Object.keys(CHANGE_KINDS).map((k) => option_(CHANGE_KINDS[k], k));
      const waits = CHANGE_WAITS.map((w) => option_(changeWaitLabel_(w), w));
      const pasts = [option_('알리지 않음', 'off'), option_('알림', 'on')];
      // 세트마다 같은 항목을 둡니다. 입력칸 이름에는 순서가 아닌 세트 id를 넣어, 세트를 지워도 Slack이 다른 세트의 입력값을 옮겨 붙이지 않게 합니다.
      c.sets.forEach((s, i) => {
        const p = `changes_${s.id}`;
        const head = section_(`*세트 ${i + 1}*`);
        head.block_id = `${p}_set`;
        if (i > 0) head.accessory = button_('삭제', 'remove_change_set', s.id);
        const kindPicker = { type: 'multi_static_select', options: kinds, placeholder: plain_('알림 종류 고르기') };
        const picked = kinds.filter((o) => s.types.includes(o.value));
        if (picked.length) kindPicker.initial_options = picked;
        // 요약 줄과 같은 순서: 요일 → 알림 종류 → 발송 시점 → 과거 일정 → 미설정요일 알림 모아보내기
        blocks.push(
          { type: 'divider' },
          // 세트 제목 위 여백: 채널 설정 화면과 같은 여백용 이미지를 씁니다.
          { type: 'context', elements: [{ type: 'image', image_url: SPACER_IMAGE, alt_text: ' ' }] },
          head,
          dayPicker_(p, s.days),
          input_(`${p}_types`, '알림 종류', kindPicker),
          input_(`${p}_wait`, '발송 시점', select_(waits, s.wait)),
          { type: 'divider' },
          input_(`${p}_past`, '과거 일정에 대한 변경 알림', { type: 'radio_buttons', options: pasts, initial_option: findOption_(pasts, s.past ? 'on' : 'off') }),
          { type: 'divider' },
        );
        const hold = section_('*미설정요일 알림 모아보내기*\n설정하지 않은 요일에 발생한 변경은 알림을 보내지 않고 모아 두었다가, 돌아오는 첫 요일에 한 번에 알림을 받습니다.');
        hold.block_id = `${p}_hold_enabled`;
        hold.accessory = Object.assign(button_(s.hold ? '● 켜짐' : '○ 꺼짐', 'toggle_routine', `hold:${s.id}`), s.hold ? { style: 'primary' } : {});
        blocks.push(hold);
        if (s.hold) blocks.push(timePicker_(`${p}_hold_time`, '모아 보내는 시각', s.holdTime));
      });
      // 종류마다 한 세트에만 넣을 수 있어 세트는 최대 3개입니다.
      if (c.sets.length < Object.keys(CHANGE_KINDS).length) {
        blocks.push({ type: 'divider' }, { type: 'actions', block_id: 'changes_add_set', elements: [button_('+ 세트 추가', 'add_change_set', 'add')] });
      }
    }
  }

  return {
    type: 'modal',
    callback_id: 'conn_settings',
    title: plain_('알림 설정'),
    submit: plain_('저장'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, connId: conn.id, parentViewId, draft }),
    blocks,
  };
}

/** 루틴 제목 오른쪽의 켜짐/꺼짐 버튼 */
function routineHeader_(routine, text, enabled) {
  const block = section_(text);
  block.block_id = `${routine}_enabled`;
  block.accessory = button_(enabled ? '● 켜짐' : '○ 꺼짐', 'toggle_routine', routine);
  if (enabled) block.accessory.style = 'primary';
  return block;
}

/** 요일: 여러 개 고르는 칸 하나에 고른 요일이 가로로 나열됩니다. 비워 두면 Slack이 저장을 막습니다. */
function dayPicker_(routine, days) {
  const options = WEEK_ORDER.map((d) => option_(DAY_NAMES[d], d));
  const element = { type: 'multi_static_select', options, placeholder: plain_('요일 고르기') };
  const initial = options.filter((o) => days.map(String).includes(o.value));
  if (initial.length) element.initial_options = initial;
  return input_(`${routine}_days`, '요일', element);
}

function noticeModal_(title, text) {
  return { type: 'modal', title: plain_(title), close: plain_('닫기'), blocks: [section_(text)] };
}

function adminsModal_(chId, ch, parentViewId) {
  return {
    type: 'modal',
    callback_id: 'admins',
    title: plain_('채널 봇 관리자 변경'),
    submit: plain_('저장'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, parentViewId }),
    blocks: [
      section_(`<#${chId}> 채널의 봇 관리자`),
      input_('admins', '채널 봇 관리자', { type: 'multi_users_select', initial_users: ch.admins }),
      context_('채널 봇 관리자는 이 채널의 캘린더 연결과 알림 설정을 바꿀 수 있습니다. 게스트 계정과 봇은 채널 봇 관리자가 될 수 없습니다.'),
    ],
  };
}

function deleteConfirmModal_(chId, message, responseUrl) {
  return {
    type: 'modal',
    callback_id: 'delete_message',
    title: plain_('메시지 삭제'),
    submit: plain_('삭제'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, ts: message.ts, responseUrl }),
    blocks: [
      section_('이 Checky Bot 메시지를 삭제할까요? 삭제하면 되돌릴 수 없습니다.'),
      context_(messagePreview_(message)),
    ],
  };
}

/** 확인 창에 보여 줄 메시지 내용. 너무 길면 앞부분만 보여 줍니다. */
function messagePreview_(message) {
  const parts = [];
  // 블록이 있으면 본문은 블록이고 text는 알림용이라, 블록에서 글자를 모읍니다.
  const fromBlocks = (blocks) => (blocks || []).forEach((b) => {
    if (b.type === 'section' && b.text) parts.push(b.text.text);
    if (b.type === 'context') parts.push((b.elements || []).map((e) => e.text || '').join(' '));
    if (b.type === 'rich_text') {
      parts.push((b.elements || []).map((s) => (s.elements || []).map((e) => escapeSlack_(e.text || '')).join('')).join('\n'));
    }
  });
  if (message.blocks && message.blocks.length) fromBlocks(message.blocks);
  else parts.push(message.text || '');
  (message.attachments || []).forEach((a) => {
    if (a.pretext) parts.push(a.pretext);
    if (a.text) parts.push(a.text);
    fromBlocks(a.blocks);
  });
  const text = parts.join('\n').trim() || '(내용 없음)';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function installerModal_(userId) {
  return {
    type: 'modal',
    callback_id: 'installer',
    title: plain_('앱 설치자 변경'),
    submit: plain_('저장'),
    close: plain_('취소'),
    blocks: [
      input_('installer', '앱 설치자', { type: 'users_select', initial_user: userId }),
      context_('서비스에 문제가 생기면 앱 설치자에게 DM이 발송됩니다.'),
      { type: 'divider' },
      section_('*문제 발생 시*\n설치 방법과 문제 해결은 아래 GitHub 문서를 참고하세요.'),
      context_(`<${GITHUB_URL}|github.com/boeunde/checky-bot>　|　MIT License`),
    ],
  };
}

function publishHome_(userId) {
  const meta = loadMeta_();
  // 맨 위 오른쪽 [⋯] 메뉴: 링크만 엽니다(누른 뒤 서버에서 할 일은 없습니다).
  // Slack 더보기 메뉴는 항목이 2개 이상이어야 해서 라이선스 링크를 함께 둡니다.
  const intro = section_('\n　\n공용 Google 캘린더의 일정을 Slack 채널로 발송합니다.\n　\n');
  intro.accessory = {
    type: 'overflow',
    action_id: 'home_menu',
    options: [
      { text: plain_('GitHub 열기'), value: 'github', url: GITHUB_URL },
      { text: plain_('라이선스 (MIT)'), value: 'license', url: `${GITHUB_URL}/blob/main/LICENSE` },
    ],
  };
  const blocks = [
    intro,
    { type: 'divider' },
    section_([
      '\n　\n*사용 방법*',
      '1. 알림을 받을 채널에 봇을 초대합니다: `/invite @Checky Bot`',
      '2. 해당 채널에서 `/checky` 명령어를 입력하고 캘린더를 연결합니다.',
      '3. 캘린더마다 알림 루틴을 설정합니다.',
    ].join('\n')),
    { type: 'divider' },
    section_('\n　\n*연결된 채널*\n현재 연결된 채널과 그에 따른 설정은 다음과 같습니다.'),
  ];

  // 캘린더가 연결된 채널과 내가 관리자인 채널을 보여 주고, 관리자인 채널에는 [설정] 버튼을 붙입니다.
  // 캘린더가 없는 채널에서 봇이 이미 나갔으면(나간 이벤트를 놓친 경우) 여기서 기록을 지웁니다.
  const loaded = meta.channels.map(loadChannel_).filter((ch) => {
    if (!ch) return false;
    if (ch.connections.length || !botLeftChannel_(ch.id)) return true;
    forgetChannel_(ch.id);
    return false;
  });
  const channels = loaded
    .filter((ch) => ch.connections.length || isAdmin_(ch, userId))
    .slice(0, HOME_CHANNEL_LIMIT);
  channels.forEach((ch) => {
    // 봇이 나가 일시정지된 채널은 다시 초대하면 이어 쓸 수 있어 목록에 남기고 상태를 붙입니다.
    const left = ch.connections.length && ch.connections.every((c) => c.pausedReason === 'removed');
    const parts = [`캘린더 ${ch.connections.length}개`, `관리자 ${ch.admins.map((u) => `<@${u}>`).join(', ') || '없음'}`];
    if (left) parts.push('⏸️ 봇이 채널에서 나감');
    const row = section_(`●  <#${ch.id}>\n　 ${parts.join(SEP)}`);
    if (isAdmin_(ch, userId)) row.accessory = button_('설정', 'open_channel', ch.id);
    blocks.push(row);
  });
  if (!channels.length) blocks.push(context_('아직 캘린더를 연결한 채널이 없습니다.'));

  // 앱 설치자는 채널 목록 아래에 둡니다.
  blocks.push({ type: 'divider' }, section_('\n　\n*앱 설치자*\n문제가 발생하면 시스템이 앱 설치자에게 DM을 전송합니다.\n설치자 권한은 다른 사람으로 변경할 수 있습니다.'));
  const installer = section_(meta.installer ? `●  <@${meta.installer}>` : '●  아직 없음');
  if (meta.installer === userId) installer.accessory = button_('변경', 'transfer_installer', 'installer');
  blocks.push(installer, { type: 'divider' });
  slackApi_('views.publish', { user_id: userId, view: { type: 'home', blocks } });
}
