// Runs Code.gs against mocked Apps Script and Slack services.
// Usage: node test/checky-bot.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const kst = (iso) => new Date(`${iso}:00+09:00`).getTime(); // 'YYYY-MM-DDTHH:mm' in Korea time

function createEnv(nowIso) {
  const RealDate = Date;
  let now = kst(nowIso);
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(now);
    }
    static now() {
      return now;
    }
  }

  const state = {
    props: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_VERIFICATION_TOKEN: 'vtok' },
    cache: {},
    calendars: {},
    triggers: [],
    calls: [],
    responses: [],
    users: {},
    members: new Set(),
    failChannels: {},
    tz: 'Asia/Seoul',
    uuid: 0,
  };

  const wrapEvent = (ev) => ({
    getId: () => ev.id,
    getTitle: () => ev.title || '',
    getDescription: () => ev.desc || '',
    isAllDayEvent: () => !!ev.allDay,
    getStartTime: () => new MockDate(ev.start),
    getEndTime: () => new MockDate(ev.end),
    getAllDayStartDate: () => new MockDate(ev.start),
    getAllDayEndDate: () => new MockDate(ev.end),
    getVisibility: () => ev.visibility || 'DEFAULT',
  });
  const calendar = (id) => state.calendars[id] && {
    getId: () => id,
    getName: () => state.calendars[id].name,
    getEvents: (s, e) => state.calendars[id].events.filter((ev) => ev.start < e.getTime() && ev.end > s.getTime()).map(wrapEvent),
  };

  function slack(method, params) {
    state.calls.push({ method, params });
    switch (method) {
      case 'auth.test':
        return { ok: true, user_id: 'UBOT', user: 'checky-bot' };
      case 'users.info':
        return { ok: true, user: Object.assign({ id: params.user }, state.users[params.user] || {}) };
      case 'conversations.info':
        return state.members.has(params.channel) ? { ok: true, channel: { id: params.channel, is_member: true } } : { ok: false, error: 'channel_not_found' };
      case 'chat.postMessage':
        return state.failChannels[params.channel] ? { ok: false, error: state.failChannels[params.channel] } : { ok: true, ts: '1.1' };
      default:
        return { ok: true };
    }
  }

  function triggerBuilder(handler) {
    const t = { handler, spec: {}, getHandlerFunction: () => handler, getTriggerSourceId: () => t.spec.calendar || null };
    const b = {
      timeBased: () => b,
      everyMinutes: (n) => { t.spec.minutes = n; return b; },
      forUserCalendar: (id) => { t.spec.calendar = id; return b; },
      onEventUpdated: () => b,
      create: () => { state.triggers.push(t); return t; },
    };
    return b;
  }

  const sandbox = {
    Date: MockDate,
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in state.props ? state.props[k] : null),
      setProperty: (k, v) => { state.props[k] = String(v); },
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in state.cache ? state.cache[k] : null),
      put: (k, v) => { state.cache[k] = v; },
      remove: (k) => { delete state.cache[k]; },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' },
    },
    Session: { getScriptTimeZone: () => state.tz, getEffectiveUser: () => ({ getEmail: () => 'team@example.com' }) },
    Utilities: { getUuid: () => `conn${++state.uuid}-0000-0000` },
    CalendarApp: {
      Visibility: { DEFAULT: 'DEFAULT', PRIVATE: 'PRIVATE', CONFIDENTIAL: 'CONFIDENTIAL', PUBLIC: 'PUBLIC' },
      getCalendarById: (id) => calendar(id) || null,
      subscribeToCalendar: (id) => { const c = calendar(id); if (!c) throw new Error('no access'); return c; },
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger: (t) => { state.triggers.splice(state.triggers.indexOf(t), 1); },
      newTrigger: triggerBuilder,
    },
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.startsWith('https://slack.com/api/')) {
        assert.strictEqual(opts.headers.Authorization, 'Bearer xoxb-test');
        const params = Object.assign({}, opts.payload);
        ['view', 'blocks'].forEach((k) => { if (params[k]) params[k] = JSON.parse(params[k]); });
        const res = slack(url.slice('https://slack.com/api/'.length), params);
        return { getContentText: () => JSON.stringify(res), getResponseCode: () => 200 };
      }
      state.responses.push({ url, body: JSON.parse(opts.payload) });
      return { getContentText: () => 'ok', getResponseCode: () => 200 };
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);

  const doPost = (e) => sandbox.doPost(e);
  const env = {
    state,
    setNow: (iso) => { now = kst(iso); },
    run: (fn) => sandbox[fn](),
    calls: (method) => state.calls.filter((c) => c.method === method),
    clearCalls: () => { state.calls.length = 0; state.responses.length = 0; },
    channel: (id) => JSON.parse(state.props[`CH_${id}`] || 'null'),
    meta: () => JSON.parse(state.props.META || 'null'),
    posts: (channel) => env.calls('chat.postMessage').filter((c) => !channel || c.params.channel === channel).map((c) => c.params.text),
    ephemerals: (user) => env.calls('chat.postEphemeral').filter((c) => !user || c.params.user === user).map((c) => c.params.text),
    addCalendar: (id, name, events = []) => { state.calendars[id] = { name, events }; },
    command: (p) => doPost({ parameter: Object.assign({ command: '/checky', token: 'vtok', trigger_id: 'TRIG', text: '', channel_name: 'general' }, p) }),
    interact: (payload) => doPost({ parameter: { payload: JSON.stringify(Object.assign({ token: 'vtok', trigger_id: 'TRIG' }, payload)) } }),
    event: (event) => doPost({ postData: { contents: JSON.stringify({ token: 'vtok', type: 'event_callback', event }) } }),
    raw: (body) => doPost({ postData: { contents: JSON.stringify(body) } }),
  };
  return env;
}

const ev = (id, title, startIso, endIso, extra = {}) => Object.assign({ id, title, start: kst(startIso), end: kst(endIso) }, extra);
const allDay = (id, title, startDate, endDateExclusive, extra = {}) => ev(id, title, `${startDate}T00:00`, `${endDateExclusive}T00:00`, Object.assign({ allDay: true }, extra));

function settingsValues({ daily = {}, reminder = {} } = {}) {
  const d = Object.assign({ enabled: true, time: 540, scope: 'all', days: [1, 2, 3, 4, 5], empty: 'skip' }, daily);
  const r = Object.assign({ enabled: false, offset: 15, allDayTime: 540, days: [1, 2, 3, 4, 5] }, reminder);
  const many = (arr) => arr.map((v) => ({ value: String(v) }));
  const one = (v) => ({ selected_option: { value: String(v) } });
  return {
    daily_enabled: { v: { selected_options: d.enabled ? [{ value: 'on' }] : [] } },
    daily_time: { v: one(d.time) },
    daily_scope: { v: one(d.scope) },
    daily_days: { v: { selected_options: many(d.days) } },
    daily_empty: { v: one(d.empty) },
    reminder_enabled: { v: { selected_options: r.enabled ? [{ value: 'on' }] : [] } },
    reminder_offset: { v: one(r.offset) },
    reminder_allday_time: { v: one(r.allDayTime) },
    reminder_days: { v: { selected_options: many(r.days) } },
  };
}

/** Bot set up, invited to C1 by UA (first admin + installer), calendar cal1 connected. */
function connectedEnv(nowIso, events = [], settings) {
  const env = createEnv(nowIso);
  env.addCalendar('cal1', '디자인팀', events);
  env.run('setup');
  env.state.members.add('C1');
  env.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UA' });
  addConnection(env, 'cal1');
  if (settings) configure(env, settings);
  env.clearCalls();
  return env;
}

function addConnection(env, calendarId, user = 'UA') {
  return env.interact({
    type: 'view_submission',
    user: { id: user },
    view: { id: 'V2', callback_id: 'add_conn', private_metadata: JSON.stringify({ channelId: 'C1', parentViewId: 'V1' }), state: { values: { calendar_id: { v: { value: calendarId } } } } },
  });
}

function configure(env, settings, user = 'UA') {
  const connId = env.channel('C1').connections[0].id;
  return env.interact({
    type: 'view_submission',
    user: { id: user },
    view: { id: 'V3', callback_id: 'conn_settings', private_metadata: JSON.stringify({ channelId: 'C1', connId, parentViewId: 'V1' }), state: { values: settingsValues(settings) } },
  });
}

function blockAction(env, actionId, value, user = 'UA') {
  return env.interact({
    type: 'block_actions',
    user: { id: user },
    view: { id: 'V1', private_metadata: JSON.stringify({ channelId: 'C1' }) },
    actions: [{ action_id: actionId, value }],
  });
}

const actionIds = (view) => view.blocks.flatMap((b) => (b.elements || []).concat(b.accessory ? [b.accessory] : [])).map((e) => e.action_id).filter(Boolean);
const response = (out) => JSON.parse(out.content);

const tests = {
  'rejects requests without the verification token': () => {
    const env = createEnv('2026-11-09T10:00');
    assert.strictEqual(env.raw({ token: 'bad', type: 'url_verification', challenge: 'c' }).content, '');
    assert.strictEqual(env.raw({ token: 'vtok', type: 'url_verification', challenge: 'c' }).content, 'c');
  },

  'setup registers 1-minute dispatch, 10-minute rebuild and a calendar trigger per calendar': () => {
    const env = connectedEnv('2026-11-09T10:00');
    env.run('rebuildSchedule');
    const specs = env.state.triggers.map((t) => `${t.handler}:${JSON.stringify(t.spec)}`).sort();
    assert.deepStrictEqual(specs, ['dispatchDue:{"minutes":1}', 'onCalendarChanged:{"calendar":"cal1"}', 'rebuildSchedule:{"minutes":10}']);
    env.run('setup');
    assert.strictEqual(env.state.triggers.length, 3);
  },

  'setup refuses a project not set to Seoul time': () => {
    const env = createEnv('2026-11-09T10:00');
    env.state.tz = 'America/New_York';
    assert.throws(() => env.run('setup'), /America\/New_York/);
    assert.strictEqual(env.state.triggers.length, 0);
  },

  'the inviter becomes the first channel admin and the installer': () => {
    const env = createEnv('2026-11-09T10:00');
    env.run('setup');
    env.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UA' });
    env.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UB' });
    assert.deepStrictEqual(env.channel('C1').admins, ['UA']);
    assert.strictEqual(env.meta().installer, 'UA');
    assert.ok(env.ephemerals('UA')[0].includes('관리자로 지정'));
  },

  'a guest who invites the bot does not become admin': () => {
    const env = createEnv('2026-11-09T10:00');
    env.state.users.UG = { is_restricted: true };
    env.run('setup');
    env.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UG' });
    assert.deepStrictEqual(env.channel('C1').admins, []);
  },

  '/checky asks to invite the bot first when it is not in the channel': () => {
    const env = createEnv('2026-11-09T10:00');
    env.run('setup');
    const out = env.command({ user_id: 'UA', channel_id: 'C9' });
    assert.ok(response(out).text.includes('/invite @checky-bot'));
    assert.strictEqual(env.calls('views.open').length, 0);
  },

  '/checky shows a read-only view to non-admins and edit controls to admins': () => {
    const env = connectedEnv('2026-11-09T10:00');
    env.command({ user_id: 'UB', channel_id: 'C1' });
    env.command({ user_id: 'UA', channel_id: 'C1' });
    const [nonAdmin, admin] = env.calls('views.open').map((c) => c.params.view);
    assert.deepStrictEqual(actionIds(nonAdmin), []);
    assert.ok(nonAdmin.blocks.some((b) => JSON.stringify(b).includes('관리자만')));
    assert.deepStrictEqual(actionIds(admin).sort(), ['add_conn', 'delete_conn', 'edit_admins', 'edit_conn', 'test_conn', 'toggle_conn']);
  },

  'non-admin button clicks are ignored': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const connId = env.channel('C1').connections[0].id;
    blockAction(env, 'add_conn', 'add', 'UB');
    blockAction(env, 'delete_conn', connId, 'UB');
    assert.strictEqual(env.calls('views.push').length, 0);
    assert.strictEqual(env.channel('C1').connections.length, 1);
  },

  'connecting a calendar validates access, previews the next event to the admin only, then opens its settings': () => {
    const env = createEnv('2026-11-09T10:00');
    env.addCalendar('cal1', '디자인팀', [ev('e1', '주간 회의', '2026-11-09T14:00', '2026-11-09T15:00'), ev('p', '비공개', '2026-11-09T11:00', '2026-11-09T12:00', { visibility: 'PRIVATE' })]);
    env.run('setup');
    env.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UA' });

    const bad = response(addConnection(env, 'nope'));
    assert.strictEqual(bad.response_action, 'errors');
    assert.ok(bad.errors.calendar_id.includes('team@example.com'));

    const ok = response(addConnection(env, 'cal1'));
    assert.strictEqual(ok.response_action, 'update');
    assert.strictEqual(ok.view.callback_id, 'conn_settings');
    assert.strictEqual(env.channel('C1').connections[0].calendarName, '디자인팀');
    const preview = env.ephemerals('UA').pop();
    assert.ok(preview.includes('[연결 확인]') && preview.includes('주간 회의') && !preview.includes('비공개'), preview);
    assert.strictEqual(env.posts('C1').length, 0);

    assert.ok(response(addConnection(env, 'cal1')).errors.calendar_id.includes('이미 연결'));
  },

  'routine settings require at least one routine and at least one day': () => {
    const env = connectedEnv('2026-11-09T10:00');
    assert.ok(response(configure(env, { daily: { enabled: false } })).errors.daily_enabled);
    assert.ok(response(configure(env, { daily: { days: [] } })).errors.daily_days);
    assert.ok(response(configure(env, { reminder: { enabled: true, days: [] } })).errors.reminder_days);
    assert.strictEqual(configure(env, { daily: { time: 510, scope: 'timed' }, reminder: { enabled: true, offset: 5 } }).content, '');
    const conn = env.channel('C1').connections[0];
    assert.strictEqual(conn.daily.time, 510);
    assert.strictEqual(conn.reminder.offset, 5);
    assert.strictEqual(env.calls('views.update').at(-1).params.view_id, 'V1');
  },

  'a timed reminder is sent once at its offset and again if the event moves': () => {
    const event = ev('e1', '디자인 리뷰', '2026-11-09T10:30', '2026-11-09T11:00');
    const env = connectedEnv('2026-11-09T10:00', [event], { daily: { enabled: false }, reminder: { enabled: true, offset: 15 } });
    env.setNow('2026-11-09T10:14');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 0);
    env.setNow('2026-11-09T10:15');
    env.run('dispatchDue');
    env.setNow('2026-11-09T10:16');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 1);
    assert.ok(env.posts('C1')[0].includes('15분 후 시작') && env.posts('C1')[0].includes('10:30 - 11:00'));

    event.start = kst('2026-11-09T10:40');
    event.end = kst('2026-11-09T11:10');
    env.run('onCalendarChanged');
    env.setNow('2026-11-09T10:25');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 2);
  },

  'weekday filter uses the event day, not the send day': () => {
    const event = ev('e1', '월요일 새벽', '2026-11-09T00:30', '2026-11-09T01:00'); // Monday
    const monday = connectedEnv('2026-11-08T23:00', [event], { daily: { enabled: false }, reminder: { enabled: true, offset: 60, days: [1] } });
    monday.setNow('2026-11-08T23:30'); // Sunday
    monday.run('dispatchDue');
    assert.strictEqual(monday.posts('C1').length, 1);

    const sunday = connectedEnv('2026-11-08T23:00', [event], { daily: { enabled: false }, reminder: { enabled: true, offset: 60, days: [0] } });
    sunday.setNow('2026-11-08T23:30');
    sunday.run('dispatchDue');
    assert.strictEqual(sunday.posts('C1').length, 0);
  },

  'a multi-day all-day event is announced each day with (n/N)': () => {
    const event = allDay('w', '워크숍', '2026-11-10', '2026-11-12'); // Tue-Wed
    const env = connectedEnv('2026-11-10T08:50', [event], { daily: { enabled: false }, reminder: { enabled: true, allDayTime: 540 } });
    env.setNow('2026-11-10T09:00');
    env.run('dispatchDue');
    env.setNow('2026-11-11T09:00');
    env.run('rebuildSchedule');
    env.run('dispatchDue');
    const posts = env.posts('C1');
    assert.strictEqual(posts.length, 2);
    assert.ok(posts[0].includes('워크숍 (1/2)') && posts[1].includes('워크숍 (2/2)'), posts.join('\n'));
  },

  'private and untitled events are skipped; descriptions are cleaned and shortened': () => {
    const long = 'a'.repeat(400);
    const events = [
      ev('p', '비밀', '2026-11-09T10:30', '2026-11-09T11:00', { visibility: 'PRIVATE' }),
      ev('n', '', '2026-11-09T10:30', '2026-11-09T11:00'),
      ev('ok', '공개 회의', '2026-11-09T10:30', '2026-11-09T11:00', { desc: '<p>회의실 &amp; 링크</p><br>' }),
      ev('long', '긴 설명', '2026-11-09T10:30', '2026-11-09T11:00', { desc: long }),
    ];
    const env = connectedEnv('2026-11-09T10:00', events, { daily: { enabled: false }, reminder: { enabled: true, offset: 15 } });
    env.setNow('2026-11-09T10:15');
    env.run('dispatchDue');
    const posts = env.posts('C1');
    assert.strictEqual(posts.length, 2);
    const meeting = posts.find((p) => p.includes('공개 회의'));
    assert.ok(meeting.includes('> 회의실 &amp; 링크') && !meeting.includes('<p>'), meeting);
    assert.ok(posts.find((p) => p.includes('긴 설명')).includes(`${'a'.repeat(300)}…`));
  },

  'daily summary respects scope and the empty-day option': () => {
    const events = [allDay('h', '창립기념일', '2026-11-09', '2026-11-10'), ev('t', '주간 회의', '2026-11-09T14:00', '2026-11-09T15:00')];
    const timed = connectedEnv('2026-11-09T08:50', events, { daily: { scope: 'timed' } });
    timed.setNow('2026-11-09T09:00');
    timed.run('dispatchDue');
    const summary = timed.posts('C1')[0];
    assert.ok(summary.includes('11월 9일 (월) 일정 1건') && summary.includes('14:00 - 15:00  주간 회의') && !summary.includes('창립기념일'), summary);

    const skip = connectedEnv('2026-11-10T08:50', [], { daily: { empty: 'skip' } });
    skip.setNow('2026-11-10T09:00');
    skip.run('dispatchDue');
    assert.strictEqual(skip.posts('C1').length, 0);

    const send = connectedEnv('2026-11-10T08:50', [], { daily: { empty: 'send' } });
    send.setNow('2026-11-10T09:00');
    send.run('dispatchDue');
    assert.ok(send.posts('C1')[0].includes('일정 없음'));
  },

  'paused connections and alerts before the last settings change are not sent': () => {
    const events = [ev('t', '주간 회의', '2026-11-09T14:00', '2026-11-09T15:00')];
    const paused = connectedEnv('2026-11-09T08:50', events);
    blockAction(paused, 'toggle_conn', paused.channel('C1').connections[0].id);
    assert.strictEqual(paused.channel('C1').connections[0].paused, true);
    paused.setNow('2026-11-09T09:00');
    paused.run('dispatchDue');
    assert.strictEqual(paused.posts('C1').length, 0);

    const late = connectedEnv('2026-11-09T09:05', events, {});
    late.setNow('2026-11-09T09:06');
    late.run('dispatchDue');
    assert.strictEqual(late.posts('C1').length, 0);
  },

  'losing calendar access DMs the installer once, and again on recovery': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const saved = env.state.calendars.cal1;
    delete env.state.calendars.cal1;
    env.run('rebuildSchedule');
    env.run('rebuildSchedule');
    assert.strictEqual(env.posts('UA').length, 1);
    assert.ok(env.posts('UA')[0].includes('접근할 수 없어'));
    assert.strictEqual(env.channel('C1').connections[0].error, 'calendar');
    env.state.calendars.cal1 = saved;
    env.run('rebuildSchedule');
    assert.ok(env.posts('UA')[1].includes('재개'));
    assert.strictEqual(env.channel('C1').connections[0].error, null);
  },

  'being removed from a channel pauses its connections and DMs the installer': () => {
    const events = [ev('t', '주간 회의', '2026-11-09T14:00', '2026-11-09T15:00')];
    const env = connectedEnv('2026-11-09T08:50', events);
    env.state.failChannels.C1 = 'not_in_channel';
    env.setNow('2026-11-09T09:00');
    env.run('dispatchDue');
    const conn = env.channel('C1').connections[0];
    assert.strictEqual(conn.paused, true);
    assert.strictEqual(conn.pausedReason, 'removed');
    assert.ok(env.posts('UA')[0].includes('일시정지'));

    const kicked = connectedEnv('2026-11-09T08:50', events);
    kicked.event({ type: 'channel_left', channel: 'C1' });
    assert.strictEqual(kicked.channel('C1').connections[0].pausedReason, 'removed');
  },

  'only channel admins can delete bot messages, and only bot messages': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const shortcut = (user, message) => env.interact({ type: 'message_action', callback_id: 'delete_message', user: { id: user }, channel: { id: 'C1' }, message, response_url: 'https://hooks.slack.com/actions/x', api_app_id: 'A1' });
    shortcut('UB', { user: 'UBOT', ts: '1.0' });
    shortcut('UA', { user: 'UX', ts: '2.0' });
    assert.strictEqual(env.calls('chat.delete').length, 0);
    shortcut('UA', { user: 'UBOT', ts: '3.0' });
    assert.deepStrictEqual(env.calls('chat.delete').map((c) => c.params.ts), ['3.0']);
    const replies = env.state.responses.map((r) => r.body.text);
    assert.ok(replies[0].includes('관리자만') && replies[1].includes('보낸 메시지만') && replies[2].includes('삭제했습니다'), replies.join('|'));
  },

  'the test button previews the most recent past day to the admin only': () => {
    const events = [
      ev('old', '목요일 회의', '2026-11-05T10:00', '2026-11-05T11:00'),
      ev('fri', '금요일 회의', '2026-11-06T14:00', '2026-11-06T15:00'),
      ev('future', '다음 회의', '2026-11-10T14:00', '2026-11-10T15:00'),
    ];
    const env = connectedEnv('2026-11-09T10:00', events, { reminder: { enabled: true } });
    blockAction(env, 'test_conn', env.channel('C1').connections[0].id);
    const msgs = env.ephemerals('UA');
    assert.ok(msgs.every((m) => m.startsWith('[테스트]')));
    assert.ok(msgs[0].includes('11월 6일 (금)'));
    assert.ok(msgs.some((m) => m.includes('일정 1건') && m.includes('금요일 회의')));
    assert.ok(msgs.some((m) => m.includes('15분 후 시작') && m.includes('금요일 회의')));
    assert.ok(!msgs.join('\n').includes('목요일 회의') && !msgs.join('\n').includes('다음 회의'));
    assert.strictEqual(env.posts('C1').length, 0);
  },

  'admin changes reject guests and an empty list': () => {
    const env = connectedEnv('2026-11-09T10:00');
    env.state.users.UG = { is_ultra_restricted: true };
    const submit = (users) => env.interact({ type: 'view_submission', user: { id: 'UA' }, view: { id: 'V4', callback_id: 'admins', private_metadata: JSON.stringify({ channelId: 'C1', parentViewId: 'V1' }), state: { values: { admins: { v: { selected_users: users } } } } } });
    assert.ok(response(submit([])).errors.admins);
    assert.ok(response(submit(['UA', 'UG'])).errors.admins.includes('게스트'));
    assert.strictEqual(submit(['UA', 'UB']).content, '');
    assert.deepStrictEqual(env.channel('C1').admins, ['UA', 'UB']);
  },

  'only the installer can hand the installer role to someone else': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const submit = (user, next) => env.interact({ type: 'view_submission', user: { id: user }, view: { id: 'V5', callback_id: 'installer', private_metadata: '', state: { values: { installer: { v: { selected_user: next } } } } } });
    assert.ok(response(submit('UB', 'UB')).errors.installer);
    assert.strictEqual(submit('UA', 'UB').content, '');
    assert.strictEqual(env.meta().installer, 'UB');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log('PASS', name);
  } catch (err) {
    failed++;
    console.log('FAIL', name, '\n  ', err.message);
  }
}
console.log(`${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
