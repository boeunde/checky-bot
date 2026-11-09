/**
 * checky-bot v2
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

const REMINDER_OFFSETS = [0, 5, 15, 30, 60];
const DAILY_SCOPES = { all: '모든 일정', allday: '종일 일정만', timed: '시간 일정만' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAYS = [1, 2, 3, 4, 5];
const REMOVED_ERRORS = ['not_in_channel', 'channel_not_found', 'is_archived'];
// 아래 둘은 v1 트리거 이름입니다. 같은 프로젝트에서 setup을 실행하면 함께 정리됩니다.
const TRIGGER_HANDLERS = ['dispatchDue', 'rebuildSchedule', 'onCalendarChanged', 'checkUpcomingEvents', 'sendDailySummary'];

const HELP_TEXT = [
  '*checky-bot 사용법*',
  '1. 알림을 받을 채널에 봇을 초대합니다: `/invite @checky-bot`',
  '2. 그 채널에서 `/checky`를 입력해 캘린더를 연결하고 알림을 설정합니다.',
  '• 봇 메시지 지우기: 메시지의 ⋯ 메뉴 > checky-bot 메시지 삭제 (채널 관리자만)',
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
  console.log(`Slack 봇 ${auth.user}(으)로 연결되었습니다. 이제 웹 앱으로 배포하세요.`);
}

/** 10분마다: 앞으로 보낼 알림 목록을 새로 만듭니다. */
function rebuildSchedule() {
  syncCalendarTriggers_();
  const { failures } = rebuildSchedule_();
  if (failures.length) throw new Error(`일부 캘린더를 읽지 못했습니다.\n${failures.join('\n')}`);
}

/** 캘린더가 바뀌면: 다음 1분 실행 때 목록을 다시 만들게 합니다. */
function onCalendarChanged() {
  invalidateSchedule_();
}

/** 1분마다: 목록에서 지금 보낼 알림만 보냅니다. 캘린더를 읽지 않아 가볍습니다. */
function dispatchDue() {
  const cache = CacheService.getScriptCache();
  if (cache.get('dispatching')) return; // 이전 실행이 아직 진행 중
  cache.put('dispatching', '1', 50);
  try {
    const failures = [];
    const raw = cache.get('schedule');
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
          postMessage_(item.channel, item.text, item.attachments);
          item.keys.forEach((key) => { sent[key] = item.at + SENT_KEEP; });
          saveJson_('SENT', sent);
        } catch (err) {
          failures.push(`${item.channel}: ${err.message}`);
          handleSendFailure_(item.channel, err);
        }
      });
    if (failures.length) console.error(failures.join('\n'));
  } finally {
    cache.remove('dispatching');
  }
}

function invalidateSchedule_() {
  CacheService.getScriptCache().remove('schedule');
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
    CacheService.getScriptCache().put('schedule', JSON.stringify(schedule), SCHEDULE_CACHE_SECONDS);
  } catch (err) {
    failures.push(`알림 목록 저장 실패: ${err.message}`);
  }
  return { schedule, failures };
}

/**
 * 일정별 알림. 요일은 일정이 있는 날 기준입니다.
 * onlyDay를 주면 그날 일정만, 요일 설정과 관계없이 만듭니다(테스트용).
 */
function reminderItems_(conn, infos, from, to, onlyDay, color) {
  const r = conn.reminder;
  const items = [];
  infos.forEach((info) => {
    if (info.allDay) {
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
          attachments: [reminderAttachment_(conn, color, info, day, onlyDay === undefined ? at : undefined)],
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
      attachments: [reminderAttachment_(conn, color, info, day, onlyDay === undefined ? at : undefined)],
    });
  });
  return items;
}

/**
 * 같은 채널·같은 연결·같은 시각의 일정별 알림을 한 메시지로 묶습니다.
 * 머리글은 첫 일정에만 남깁니다. 보낸 기록은 일정마다 남기므로(keys),
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
      const attachments = chunk.map((p, index) => {
        const a = Object.assign({}, p.attachments[0]);
        if (index > 0) delete a.pretext;
        else if (a.pretext) a.pretext += ` | 총 ${parts.length}건`;
        return a;
      });
      result.push({ at: m.at, channel: m.channel, text: m.text, attachments, keys: chunk.map((p) => p.key) });
    }
  });
  return result;
}

/** 하루 요약. 같은 채널에서 같은 날 같은 시각에 보낼 캘린더는 한 메시지로 묶습니다. */
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
  return Object.keys(groups)
    .map((key) => {
      const g = groups[key];
      return { at: g.at, key, attachments: dailyAttachments_(g.day, g.entries, g.at) };
    })
    .filter((item) => item.attachments);
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
  return info;
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
 * 메시지 모양: 캘린더 이름 줄(머리글)은 색 막대 없이, 일정마다 캘린더 색 막대를 붙입니다.
 *
 *   오늘 | 디자인팀 | 11월 9일 월요일 | 총 2건     ← 머리글 (막대 없음)
 *   ┃ 종일 창립기념일                              ← 일정 (막대, 제목은 일정 링크)
 *   ┃ 12:00 - 15:00 주간 회의
 *
 * Slack 첨부의 pretext(막대 위 바깥 글자)에 머리글을 넣어 이 모양을 만듭니다.
 * 알림이 늦게 도착할 수 있어 "N분 후" 같은 표현은 쓰지 않습니다.
 */

/** 일정별 알림 하나. 일정이 있는 날을 머리글에 적습니다. */
function reminderAttachment_(conn, color, info, day, sendAt) {
  return eventAttachment_(conn, color, info, day, `:bell: ${dayHeader_(conn, day, relativeDay_(day, sendAt))}`);
}

/**
 * 하루 요약. 같은 메시지에 캘린더별 머리글과 일정들이 이어집니다.
 * 보낼 내용이 하나도 없으면 null입니다. sendAt을 주면 그 시각 기준으로 "오늘"/"내일"을 붙입니다.
 */
function dailyAttachments_(day, entries, sendAt) {
  const attachments = [];
  entries.forEach((entry) => {
    const { conn, infos, color } = entry;
    const scope = conn.daily.scope;
    const items = infos
      .filter((i) => scope === 'all' || (scope === 'allday') === i.allDay)
      .filter((i) => (i.allDay ? i.start <= day && i.end > day : i.start >= day && i.start < day + DAY))
      .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
    if (!items.length && conn.daily.empty !== 'send') return;
    const header = `${dayHeader_(conn, day, relativeDay_(day, sendAt))} | 총 ${items.length}건`;
    if (!items.length) {
      attachments.push(withColor_({ pretext: header, text: '일정 없음', fallback: `${conn.calendarName} 일정 없음`, mrkdwn_in: ['pretext', 'text'] }, color));
      return;
    }
    items.forEach((info, index) => attachments.push(eventAttachment_(conn, color, info, day, index === 0 ? header : undefined)));
  });
  if (!attachments.length) return null;
  if (attachments.length <= MESSAGE_ATTACHMENT_LIMIT) return attachments;
  const rest = attachments.length - (MESSAGE_ATTACHMENT_LIMIT - 1);
  return attachments.slice(0, MESSAGE_ATTACHMENT_LIMIT - 1).concat({ text: `외 ${rest}건`, fallback: `외 ${rest}건` });
}

/** "오늘 | 캘린더 이름 | 11월 9일 월요일" */
function dayHeader_(conn, day, dayLabel) {
  return `${dayLabel ? `*${dayLabel}* | ` : ''}*${escapeSlack_(conn.calendarName)}* | ${formatDayLong_(day)}`;
}

/** 일정 한 줄(+설명)에 캘린더 색 막대를 붙인 첨부. pretext는 막대 위에 막대 없이 표시됩니다. */
function eventAttachment_(conn, color, info, day, pretext) {
  const index = info.allDay ? Math.round((day - info.start) / DAY) : 0;
  const when = info.allDay ? '종일' : `${formatClock_(info.start)} - ${formatClock_(info.end)}`;
  const title = escapeSlack_(info.title);
  const linked = info.link ? `<${info.link}|${title}>` : title;
  const line = `${when} ${linked}${info.allDay ? partLabel_(info, index) : ''}`;
  const attachment = {
    text: withDescription_([line], info),
    fallback: `${conn.calendarName} · ${when} ${info.title}`,
    mrkdwn_in: ['pretext', 'text'],
  };
  if (pretext) attachment.pretext = pretext;
  return withColor_(attachment, color);
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

function withDescription_(lines, info) {
  if (info.description) lines.push(quote_(info.description));
  return lines.join('\n');
}

function quote_(text) {
  return text.split('\n').map((line) => `> ${escapeSlack_(line)}`).join('\n');
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

function formatLogTime_(ms) {
  const p = kstParts_(ms);
  return `${p.m}/${p.d} ${formatHm_(p.minutes)}`;
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
      pauseChannelForRemoval_(event.channel);
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
      postEphemeral_(chId, inviter, '봇이 나가 있던 동안 이 채널의 연결이 일시정지되었습니다. 채널 관리자가 `/checky`에서 재개할 수 있습니다.');
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
  postEphemeral_(chId, inviter, 'checky-bot을 초대하셨습니다. 이 채널의 관리자로 지정되었습니다. `/checky`를 입력해 캘린더를 연결하세요.');
}

function handleCommand_(p) {
  const text = (p.text || '').trim();
  if (text === 'help' || text === '도움말') return ephemeralJson_(HELP_TEXT);
  registerInstallerIfNone_(p.user_id);
  if (p.channel_name === 'directmessage' || String(p.channel_id).charAt(0) === 'D') {
    return ephemeralJson_('알림을 받을 채널에서 `/checky`를 입력하세요.');
  }

  const ch = loadChannel_(p.channel_id);
  if (!ch || !ch.admins.length) {
    if (!isBotMember_(p.channel_id)) {
      return ephemeralJson_('먼저 이 채널에 checky-bot을 초대하세요: `/invite @checky-bot`');
    }
    // 초대 기록이 없는 채널(예: 예전에 초대된 채널)은 처음 /checky를 실행한 사람이 관리자가 됩니다.
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

function isBotMember_(chId) {
  try {
    return !!slackApi_('conversations.info', { channel: chId }).channel.is_member;
  } catch (err) {
    return false;
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

  const meta = view ? JSON.parse(view.private_metadata || '{}') : {};
  const chId = meta.channelId;
  if (!chId) return;
  const ch = loadChannel_(chId);
  if (!isAdmin_(ch, userId)) return; // 관리자가 아니면 무시합니다.
  if (action.action_id === 'toggle_routine' || action.action_id === 'tab_daily' || action.action_id === 'tab_reminder') {
    editDraft_(payload, ch, chId, action);
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
        addLog_(c, userId, `${target.paused ? '일시정지' : '재개'}: ${escapeSlack_(target.calendarName)}`);
      });
      break;
    case 'delete_conn':
      if (!conn) return;
      updateChannel_(chId, (c) => {
        c.connections = c.connections.filter((x) => x.id !== conn.id);
        addLog_(c, userId, `연결 삭제: ${escapeSlack_(conn.calendarName)}`);
      });
      break;
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
    const firstBlock = { add_conn: 'calendar_id', conn_settings: 'notice', admins: 'admins' }[view.callback_id];
    if (!firstBlock) return null;
    if (!isAdmin_(ch, userId)) {
      if (view.callback_id === 'conn_settings') return json_({ response_action: 'update', view: noticeModal_('알림 설정', '이 채널의 관리자만 바꿀 수 있습니다.') });
      return errorsJson_({ [firstBlock]: '이 채널의 관리자만 바꿀 수 있습니다.' });
    }
    if (view.callback_id === 'add_conn') return submitAddConn_(meta, ch, values, userId);
    if (view.callback_id === 'conn_settings') return submitConnSettings_(meta, ch, values, userId);
    return submitAdmins_(meta, ch, values, userId);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (view.callback_id === 'conn_settings') return json_({ response_action: 'update', view: noticeModal_('알림 설정', `처리하지 못했습니다: ${err.message}`) });
    const block = { add_conn: 'calendar_id', admins: 'admins', installer: 'installer' }[view.callback_id];
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
    addLog_(c, userId, `캘린더 연결: ${escapeSlack_(conn.calendarName)}`);
  });
  invalidateSchedule_();
  sendConnectionPreview_(meta.channelId, conn, calendar, userId);
  // 연결 직후 바로 알림 설정 화면을 보여 줍니다. 저장하면 채널 설정 화면도 새로 고칩니다.
  return json_({ response_action: 'update', view: connModal_(meta.channelId, conn, meta.parentViewId) });
}

/**
 * 알림 설정 화면에서 지금 고른 값. 켜기/끄기는 버튼이라 화면 메타데이터(draft)에,
 * 나머지는 입력 값에 있습니다. 숨겨진(꺼진) 루틴의 값은 draft에 남아 있습니다.
 */
function draftFromView_(meta, values, conn) {
  const base = meta.draft || { daily: conn.daily, reminder: conn.reminder };
  const draft = JSON.parse(JSON.stringify(base));
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
  ['daily', 'reminder'].forEach((name) => {
    const b = values && values[`${name}_days`];
    if (b && b.v) draft[name].days = WEEK_ORDER.filter((d) => (b.v.selected_options || []).some((o) => Number(o.value) === d));
  });
  return draft;
}

function draftProblems_(draft) {
  const problems = {};
  if (!draft.daily.enabled && !draft.reminder.enabled) problems.none = true;
  if (draft.daily.enabled && !draft.daily.days.length) problems.daily = true;
  if (draft.reminder.enabled && !draft.reminder.days.length) problems.reminder = true;
  return problems;
}

/** 켜짐/꺼짐 버튼이나 탭을 누르면 화면을 다시 그립니다. 저장은 [저장]을 눌러야 됩니다. */
function editDraft_(payload, ch, chId, action) {
  const view = payload.view;
  const meta = JSON.parse(view.private_metadata || '{}');
  const conn = ch.connections.find((c) => c.id === meta.connId);
  if (!conn) return;
  const draft = draftFromView_(meta, view.state && view.state.values, conn);
  if (!draft[action.value]) return;
  if (action.action_id === 'toggle_routine') draft[action.value].enabled = !draft[action.value].enabled;
  else draft.tab = action.value;
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

  const saved = updateChannel_(meta.channelId, (c) => {
    const target = c.connections.find((x) => x.id === meta.connId);
    if (!target) return false;
    target.daily = daily;
    target.reminder = reminder;
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
  if (loadMeta_().installer !== userId) return errorsJson_({ installer: '현재 설치자만 바꿀 수 있습니다.' });
  if (!next) return errorsJson_({ installer: '새 설치자를 고르세요.' });
  const reason = ineligibleReason_(next);
  if (reason) return errorsJson_({ installer: `${reason}은(는) 설치자가 될 수 없습니다.` });
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
    respond('이 채널의 관리자만 checky-bot 메시지를 지울 수 있습니다.');
    return;
  }
  const fromBot = message.user === botUserId_()
    || (message.bot_profile && message.bot_profile.app_id === payload.api_app_id)
    || (message.app_id && message.app_id === payload.api_app_id);
  if (!fromBot) {
    respond('checky-bot이 보낸 메시지만 지울 수 있습니다.');
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
    reminder: { enabled: false, offset: 15, allDayTime: 9 * 60, days: WEEKDAYS.slice() },
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
  postEphemeral_(chId, userId, `${head}\n가장 가까운 일정:`, [reminderAttachment_(conn, calendarColor_(calendar), next, day, now)]);
}

/** 일정이 있었던 가장 최근 지난 하루를 현재 설정 형식으로, 누른 관리자에게만 보여 줍니다. */
function runTest_(chId, conn, userId) {
  const say = (text, routine, attachments) => postEphemeral_(chId, userId, `[테스트${routine ? ` · ${routine}` : ''}] ${text}`.trim(), attachments);
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
    const attachments = dailyAttachments_(day, [{ conn, infos, color }]);
    messages.push(attachments
      ? { routine: '하루 요약', text: '', attachments }
      : { routine: '하루 요약', text: `${formatDay_(day)}에는 하루 요약 범위(${DAILY_SCOPES[conn.daily.scope]})에 맞는 일정이 없어 보내지 않습니다.` });
  }
  if (conn.reminder.enabled) {
    mergeItems_(reminderItems_(conn, infos, -Infinity, Infinity, day, color))
      .sort((a, b) => a.at - b.at)
      .forEach((item) => messages.push({ routine: '일정별 알림', text: '', attachments: item.attachments }));
  }
  say(`*${formatDay_(day)}* 일정으로 *${name}* 알림을 미리 보여 드립니다. 켜 둔 루틴마다 따로 오며, 요일 설정과 관계없이 보여 줍니다.`);
  messages.slice(0, TEST_MESSAGE_LIMIT).forEach((m) => say(m.text, m.routine, m.attachments));
  if (messages.length > TEST_MESSAGE_LIMIT) say(`외 ${messages.length - TEST_MESSAGE_LIMIT}건은 생략했습니다.`);
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
    pauseChannelForRemoval_(chId);
    return;
  }
  notifyInstallerOnce_(`send|${chId}|${err.slackError || 'unknown'}`, `:warning: <#${chId}> 채널에 알림을 보내지 못했습니다: ${err.message}`);
}

/** 봇이 채널에서 나가면 그 채널의 연결을 모두 일시정지하고 설치자에게 알립니다. */
function pauseChannelForRemoval_(chId) {
  const ch = loadChannel_(chId);
  if (!ch) return;
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
  notifyInstaller_(`:pause_button: checky-bot이 <#${chId}> 채널에서 나가, 이 채널의 연결 ${targets.length}개를 일시정지했습니다. 봇을 다시 초대한 뒤 채널 관리자가 \`/checky\`에서 재개하세요.`);
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
  return chId ? loadJson_(`CH_${chId}`, null) : null;
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
function postMessage_(channel, text, attachments) {
  return slackApi_('chat.postMessage', { channel, text, attachments, unfurl_links: false, unfurl_media: false });
}

function postEphemeral_(channel, user, text, attachments) {
  try {
    slackApi_('chat.postEphemeral', { channel, user, text, attachments });
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

function button_(text, actionId, value) {
  return { type: 'button', text: plain_(text), action_id: actionId, value };
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

function describeDays_(days) {
  const sorted = WEEK_ORDER.filter((d) => days.includes(d));
  if (sorted.length === 7) return '매일';
  if (sorted.join() === WEEKDAYS.join()) return '평일';
  if (sorted.join() === '6,0') return '주말';
  return sorted.map((d) => DAY_NAMES[d]).join('·');
}

function offsetChoiceLabel_(offset) {
  if (offset === 0) return '시작 시간';
  if (offset === 60) return '1시간 전';
  return `${offset}분 전`;
}

function describeDaily_(d) {
  if (!d.enabled) return '끔';
  return `${formatAmPm_(d.time)} · ${DAILY_SCOPES[d.scope]} · ${describeDays_(d.days)} · 일정 없는 날 ${d.empty === 'send' ? '"일정 없음" 보냄' : '안 보냄'}`;
}

function describeReminder_(r) {
  if (!r.enabled) return '끔';
  return `${offsetChoiceLabel_(r.offset)} · 종일 일정 ${formatAmPm_(r.allDayTime)} · ${describeDays_(r.days)}`;
}

function connectionStatus_(conn) {
  if (conn.paused) return conn.pausedReason === 'removed' ? ':pause_button: 봇이 채널에서 나가 일시정지됨' : ':pause_button: 일시정지';
  if (conn.error === 'calendar') return ':warning: 캘린더 접근 불가';
  return ':large_green_circle: 알림 중';
}

function formatLog_(entry) {
  return `${formatLogTime_(entry.at)}  ${entry.user ? `<@${entry.user}>` : 'checky-bot'}  ${entry.text}`;
}

function channelModal_(chId, userId) {
  const ch = loadChannel_(chId) || newChannel_(chId);
  const admin = isAdmin_(ch, userId);
  const blocks = [section_(`*<#${chId}>* 채널 알림 설정`)];

  if (!ch.connections.length) blocks.push(context_('연결된 캘린더가 없습니다.'));
  ch.connections.forEach((conn) => {
    blocks.push(section_([
      `*${escapeSlack_(conn.calendarName)}*  ·  ${connectionStatus_(conn)}`,
      `하루 요약: ${describeDaily_(conn.daily)}`,
      `일정별 알림: ${describeReminder_(conn.reminder)}`,
    ].join('\n')));
    if (admin) {
      blocks.push({
        type: 'actions',
        elements: [
          button_('설정', 'edit_conn', conn.id),
          button_('테스트', 'test_conn', conn.id),
          button_(conn.paused ? '재개' : '일시정지', 'toggle_conn', conn.id),
          Object.assign(button_('삭제', 'delete_conn', conn.id), {
            style: 'danger',
            confirm: confirm_('연결 삭제', `${conn.calendarName} 연결을 삭제할까요? 알림 설정도 함께 지워집니다.`, '삭제'),
          }),
        ],
      });
    }
  });
  if (admin) {
    if (ch.connections.length) blocks.push(context_('테스트 결과는 이 채널에 나에게만 보이는 메시지로 옵니다.'));
    blocks.push({ type: 'actions', elements: [Object.assign(button_('+ 캘린더 연결', 'add_conn', 'add'), { style: 'primary' })] });
  }

  blocks.push({ type: 'divider' });
  const admins = section_(`*관리자*  ${ch.admins.map((u) => `<@${u}>`).join(', ') || '없음'}`);
  if (admin) admins.accessory = button_('관리자 변경', 'edit_admins', 'admins');
  blocks.push(admins);
  if (!admin) blocks.push(context_('설정은 이 채널의 관리자만 바꿀 수 있습니다.'));
  if (ch.log.length) blocks.push(context_(`*최근 변경*\n${ch.log.slice(0, 5).map(formatLog_).join('\n')}`));

  return {
    type: 'modal',
    callback_id: 'channel',
    title: plain_('checky-bot 설정'),
    close: plain_('닫기'),
    private_metadata: JSON.stringify({ channelId: chId }),
    blocks,
  };
}

function addConnModal_(chId, parentViewId) {
  return {
    type: 'modal',
    callback_id: 'add_conn',
    title: plain_('캘린더 연결'),
    submit: plain_('연결'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, parentViewId }),
    blocks: [
      input_('calendar_id', '캘린더 ID', { type: 'plain_text_input', placeholder: plain_('예: abc123@group.calendar.google.com') }),
      context_(`공용 구글 계정 *${accountEmail_()}* 에 캘린더를 공유한 뒤, 구글 캘린더의 설정 및 공유 > 캘린더 통합에 있는 캘린더 ID를 넣으세요.`),
    ],
  };
}

/**
 * 알림 설정 화면. draft는 저장 전 고른 값이며, 없으면 저장된 설정으로 그립니다.
 * Slack에는 토글 스위치가 없어 켜기/끄기는 버튼으로 만들고, 누를 때마다 화면을 다시 그립니다(editDraft_).
 * 꺼진 루틴은 세부 항목을 숨깁니다. 하루 요약과 일정별 알림은 탭 버튼으로 나눠 한쪽만 보여 줍니다.
 */
function connModal_(chId, conn, parentViewId, draft) {
  draft = draft || JSON.parse(JSON.stringify({ daily: conn.daily, reminder: conn.reminder }));
  const d = draft.daily;
  const r = draft.reminder;
  const problems = draftProblems_(draft);
  const scopes = Object.keys(DAILY_SCOPES).map((k) => option_(DAILY_SCOPES[k], k));
  const empties = [option_('보내지 않음', 'skip'), option_('"일정 없음"으로 보내기', 'send')];
  const offsets = REMINDER_OFFSETS.map((o) => option_(offsetChoiceLabel_(o), o));

  const tab = draft.tab === 'reminder' ? 'reminder' : 'daily';
  const tabButton = (name, label, enabled) => {
    const b = button_(`${label} · ${enabled ? '켜짐' : '꺼짐'}`, `tab_${name}`, name);
    if (tab === name) b.style = 'primary';
    return b;
  };
  const blocks = [
    section_(`*${escapeSlack_(conn.calendarName)}* → <#${chId}>`),
    // 탭: 고른 쪽 설정만 보여 줍니다. 숨긴 탭의 값은 draft에 남아 함께 저장됩니다.
    { type: 'actions', block_id: 'tabs', elements: [tabButton('daily', '하루 요약', d.enabled), tabButton('reminder', '일정별 알림', r.enabled)] },
  ];
  // 경고는 숨긴 탭의 문제도 보이도록 탭 바로 아래에 둡니다.
  if (problems.none) blocks.push(context_(':warning: 하루 요약과 일정별 알림 중 하나 이상 켜야 저장됩니다.'));
  if (problems.daily) blocks.push(context_(':warning: 하루 요약의 요일을 하나 이상 고르세요.'));
  if (problems.reminder) blocks.push(context_(':warning: 일정별 알림의 요일을 하나 이상 고르세요.'));
  blocks.push({ type: 'divider' });

  if (tab === 'daily') {
    blocks.push(routineHeader_('daily', '*하루 요약*\n정한 시각에 그날 일정을 한 번에 보냅니다.', d.enabled));
    if (d.enabled) {
      blocks.push(
        timePicker_('daily_time', '보내는 시각', d.time),
        input_('daily_scope', '범위', select_(scopes, d.scope)),
        dayPicker_('daily', d.days),
        input_('daily_empty', '일정이 없는 날', { type: 'radio_buttons', options: empties, initial_option: findOption_(empties, d.empty) }),
      );
    }
  } else {
    blocks.push(routineHeader_('reminder', '*일정별 알림*\n일정마다 정한 시점에 알립니다. 요일은 일정이 있는 날 기준입니다.', r.enabled));
    if (r.enabled) {
      blocks.push(
        input_('reminder_offset', '시간 일정 알림 시점', select_(offsets, r.offset)),
        timePicker_('reminder_allday_time', '종일 일정 알림 시각', r.allDayTime),
        dayPicker_('reminder', r.days),
      );
    }
  }

  return {
    type: 'modal',
    callback_id: 'conn_settings',
    title: plain_('알림 설정'),
    submit: plain_('저장'),
    close: plain_('닫기'),
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
    title: plain_('관리자 변경'),
    submit: plain_('저장'),
    close: plain_('취소'),
    private_metadata: JSON.stringify({ channelId: chId, parentViewId }),
    blocks: [
      section_(`<#${chId}> 채널의 관리자`),
      input_('admins', '관리자', { type: 'multi_users_select', initial_users: ch.admins }),
      context_('관리자는 이 채널의 캘린더 연결과 알림 설정을 바꿀 수 있습니다. 게스트 계정과 봇은 관리자가 될 수 없습니다.'),
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
      section_('이 checky-bot 메시지를 삭제할까요? 삭제하면 되돌릴 수 없습니다.'),
      context_(messagePreview_(message)),
    ],
  };
}

/** 확인 창에 보여 줄 메시지 내용. 너무 길면 앞부분만 보여 줍니다. */
function messagePreview_(message) {
  const parts = [message.text || ''];
  (message.attachments || []).forEach((a) => {
    if (a.pretext) parts.push(a.pretext);
    if (a.text) parts.push(a.text);
  });
  const text = parts.join('\n').trim() || '(내용 없음)';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function installerModal_(userId) {
  return {
    type: 'modal',
    callback_id: 'installer',
    title: plain_('설치자 변경'),
    submit: plain_('저장'),
    close: plain_('취소'),
    blocks: [
      input_('installer', '새 설치자', { type: 'users_select', initial_user: userId }),
      context_('설치자는 장애가 생기면 DM을 받습니다.'),
    ],
  };
}

function publishHome_(userId) {
  const meta = loadMeta_();
  const blocks = [
    { type: 'header', text: plain_('checky-bot') },
    section_('공용 Google 캘린더의 일정을 Slack 채널로 알려 드립니다.\n1. 알림을 받을 채널에 봇을 초대합니다: `/invite @checky-bot`\n2. 그 채널에서 `/checky`를 입력해 캘린더를 연결합니다.'),
    { type: 'divider' },
  ];
  const installer = section_(`*설치자*  ${meta.installer ? `<@${meta.installer}>` : '아직 없음'}\n장애가 생기면 설치자에게 DM이 갑니다.`);
  if (meta.installer === userId) installer.accessory = button_('설치자 변경', 'transfer_installer', 'installer');
  blocks.push(installer, { type: 'divider' }, section_('*채널*'));

  // 캘린더가 연결된 채널과 내가 관리자인 채널을 보여 주고, 관리자인 채널에는 [설정] 버튼을 붙입니다.
  const channels = meta.channels
    .map(loadChannel_)
    .filter((ch) => ch && (ch.connections.length || isAdmin_(ch, userId)))
    .slice(0, HOME_CHANNEL_LIMIT);
  channels.forEach((ch) => {
    const row = section_(`<#${ch.id}>  캘린더 ${ch.connections.length}개 · 관리자 ${ch.admins.map((u) => `<@${u}>`).join(', ') || '없음'}`);
    if (isAdmin_(ch, userId)) row.accessory = button_('설정', 'open_channel', ch.id);
    blocks.push(row);
  });
  blocks.push(channels.length
    ? context_('설정은 각 채널의 관리자만 열 수 있습니다. 채널에서 `/checky`를 입력해도 됩니다.')
    : context_('아직 캘린더를 연결한 채널이 없습니다.'));
  slackApi_('views.publish', { user_id: userId, view: { type: 'home', blocks } });
}
