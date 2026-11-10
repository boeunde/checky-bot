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
    apiCalls: [],
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
    isRecurringEvent: () => !!ev.recurring,
  });
  const isoDate = (ms) => new RealDate(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const apiEvent = (calId, ev) => {
    if (ev.deleted) return Object.assign({ id: ev.id, status: 'cancelled' }, ev.recurringEventId ? { recurringEventId: ev.recurringEventId, originalStartTime: { dateTime: new RealDate(ev.start).toISOString() } } : {});
    return {
      id: ev.id,
      status: 'confirmed',
      summary: ev.title,
      description: ev.desc || undefined,
      visibility: ev.visibility ? ev.visibility.toLowerCase() : 'default',
      start: ev.allDay ? { date: isoDate(ev.start) } : { dateTime: new RealDate(ev.start).toISOString() },
      end: ev.allDay ? { date: isoDate(ev.end) } : { dateTime: new RealDate(ev.end).toISOString() },
      created: new RealDate(ev.created || 0).toISOString(),
      updated: new RealDate(ev.updated || 0).toISOString(),
      htmlLink: `https://calendar.example/${ev.id}`,
      recurrence: ev.recurring ? [ev.rrule || 'RRULE:FREQ=WEEKLY'] : undefined,
      attendees: ev.attendees,
      recurringEventId: ev.recurringEventId,
    };
  };
  const calendar = (id) => state.calendars[id] && {
    getId: () => id,
    getName: () => state.calendars[id].name,
    getColor: () => state.calendars[id].color || '#4285F4',
    getEvents: (s, e) => state.calendars[id].events.filter((ev) => !ev.deleted && ev.start < e.getTime() && ev.end > s.getTime()).map(wrapEvent),
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
      deleteProperty: (k) => { delete state.props[k]; },
    }) },
    // Advanced service "Google Calendar API": every change bumps a per-calendar sequence;
    // a sync token is the sequence seen last, so an incremental list returns events changed after it.
    Calendar: {
      Events: {
        list: (calId, opts) => {
          const cal = state.calendars[calId];
          if (!cal) throw new Error('Not Found');
          state.apiCalls.push({ calId, opts });
          if (opts.syncToken === 'expired') throw new Error('Sync token is no longer valid, a full sync is required. (410)');
          const since = opts.syncToken ? Number(opts.syncToken) : -1;
          const items = cal.events
            .filter((ev) => (opts.syncToken ? (ev.seq || 0) > since : !ev.deleted))
            .map((ev) => apiEvent(calId, ev));
          return { items, nextSyncToken: String(cal.seq || 0) };
        },
        get: (calId, id) => {
          state.apiCalls.push({ calId, get: id });
          const ev = state.calendars[calId].events.find((e) => e.id === id);
          if (!ev) throw new Error('Not Found');
          return { recurrence: ev.recurring ? [ev.rrule || 'RRULE:FREQ=WEEKLY'] : undefined };
        },
        instances: (calId, id) => {
          const ev = state.calendars[calId].events.find((e) => e.id === id);
          return { items: ev && ev.next ? [{ start: { dateTime: new RealDate(ev.next[0]).toISOString() }, end: { dateTime: new RealDate(ev.next[1]).toISOString() } }] : [] };
        },
      },
    },
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
    Utilities: {
      getUuid: () => `conn${++state.uuid}-0000-0000`,
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
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
        ['view', 'blocks', 'attachments'].forEach((k) => { if (params[k]) params[k] = JSON.parse(params[k]); });
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
    run: (fn, arg) => sandbox[fn](arg),
    sandbox,
    calls: (method) => state.calls.filter((c) => c.method === method),
    clearCalls: () => { state.calls.length = 0; state.responses.length = 0; },
    channel: (id) => JSON.parse(state.props[`CH_${id}`] || 'null'),
    meta: () => JSON.parse(state.props.META || 'null'),
    // A message as one string: its text, then each attachment's text on following lines.
    posts: (channel) => env.calls('chat.postMessage').filter((c) => !channel || c.params.channel === channel).map(flatten),
    ephemerals: (user) => env.calls('chat.postEphemeral').filter((c) => !user || c.params.user === user).map(flatten),
    rawPosts: (channel) => env.calls('chat.postMessage').filter((c) => c.params.channel === channel).map((c) => c.params),
    addCalendar: (id, name, events = []) => { state.calendars[id] = { name, events, seq: 0 }; },
    // Calendar edits as Google would record them; each one fires the calendar's change trigger.
    calendarEdit: (calId, id, patch) => {
      const cal = state.calendars[calId];
      let ev = cal.events.find((e) => e.id === id);
      if (!ev) { ev = { id, created: now }; cal.events.push(ev); }
      Object.assign(ev, patch, { updated: now, seq: ++cal.seq });
      sandbox.onCalendarChanged({ calendarId: calId });
      return ev;
    },
    command: (p) => doPost({ parameter: Object.assign({ command: '/checky', token: 'vtok', trigger_id: 'TRIG', text: '', channel_name: 'general' }, p) }),
    interact: (payload) => doPost({ parameter: { payload: JSON.stringify(Object.assign({ token: 'vtok', trigger_id: 'TRIG' }, payload)) } }),
    event: (event) => doPost({ postData: { contents: JSON.stringify({ token: 'vtok', type: 'event_callback', event }) } }),
    raw: (body) => doPost({ postData: { contents: JSON.stringify(body) } }),
  };
  return env;
}

// A message as one string: its text, then each attachment's pretext and text, with links shown as their label.
function flatten(call) {
  const parts = [call.params.text || ''];
  (call.params.attachments || []).forEach((a) => {
    if (a.pretext) parts.push(a.pretext);
    parts.push(a.text);
    if (a.footer) parts.push(a.footer);
  });
  return parts.join('\n').replace(/<https?:[^|>]+\|([^>]+)>/g, '$1').trim();
}

const eidOf = (link) => Buffer.from(new URL(link).searchParams.get('eid').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const ev = (id, title, startIso, endIso, extra = {}) => Object.assign({ id, title, start: kst(startIso), end: kst(endIso) }, extra);
const allDay = (id, title, startDate, endDateExclusive, extra = {}) => ev(id, title, `${startDate}T00:00`, `${endDateExclusive}T00:00`, Object.assign({ allDay: true }, extra));

// The settings modal keeps on/off and weekdays (buttons) in private_metadata.draft and the rest in input state.
// Values are only present for routines that are on, as hidden blocks send nothing.
function settingsForm({ daily = {}, reminder = {}, changes = {} } = {}) {
  const d = Object.assign({ enabled: true, time: 540, scope: 'all', days: [1, 2, 3, 4, 5], empty: 'skip' }, daily);
  const r = Object.assign({ enabled: false, offset: 15, allDay: true, allDayTime: 540, days: [1, 2, 3, 4, 5] }, reminder);
  const c = Object.assign({ enabled: false, types: [], wait: 1, past: false, days: [0, 1, 2, 3, 4, 5, 6], hold: false, holdTime: 540 }, changes);
  const one = (v) => ({ selected_option: { value: String(v) } });
  const pad = (n) => String(n).padStart(2, '0');
  const time = (m) => ({ v: { selected_time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` } });
  const many = (arr) => ({ v: { selected_options: arr.map((v) => ({ value: String(v) })) } });
  const values = {};
  if (d.enabled) Object.assign(values, { daily_time: time(d.time), daily_scope: { v: one(d.scope) }, daily_days: many(d.days), daily_empty: { v: one(d.empty) } });
  if (r.enabled) Object.assign(values, { reminder_offset: { v: one(r.offset) }, reminder_days: many(r.days) }, r.allDay ? { reminder_allday_time: time(r.allDayTime) } : {});
  if (c.enabled) Object.assign(values, { changes_days: many(c.days), changes_types: many(c.types), changes_wait: { v: one(c.wait) }, changes_past: { v: one(c.past ? 'on' : 'off') } }, c.hold ? { changes_hold_time: time(c.holdTime) } : {});
  const draft = {
    daily: { enabled: d.enabled, time: 540, scope: 'all', days: d.days, empty: 'skip' },
    reminder: { enabled: r.enabled, offset: 15, allDay: r.allDay, allDayTime: 540, days: r.days },
    changes: { enabled: c.enabled, types: [], wait: 1, past: false, days: c.days, hold: c.hold, holdTime: 540 },
  };
  return { values, draft };
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

function configure(env, settings, user = 'UA', index = 0) {
  const connId = env.channel('C1').connections[index].id;
  const { values, draft } = settingsForm(settings);
  return env.interact({
    type: 'view_submission',
    user: { id: user },
    view: { id: 'V3', callback_id: 'conn_settings', private_metadata: JSON.stringify({ channelId: 'C1', connId, parentViewId: 'V1', draft }), state: { values } },
  });
}

function blockAction(env, actionId, value, user = 'UA') {
  return env.interact({
    type: 'block_actions',
    user: { id: user },
    view: { id: 'V1', private_metadata: JSON.stringify({ channelId: 'C1' }) },
    actions: [actionId === 'pick_tab' ? { action_id: actionId, selected_option: { value } } : { action_id: actionId, value }],
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
    assert.strictEqual(nonAdmin.blocks[1].text.text, '관리자: <@UA>', 'non-admins see who the admins are, without a button');
    assert.deepStrictEqual(actionIds(admin).sort(), ['add_conn', 'change_calendar', 'conn_menu', 'edit_admins', 'edit_conn', 'test_conn', 'toggle_conn']);
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

  'times use the Slack time picker and accept any minute': () => {
    const env = connectedEnv('2026-11-09T10:00');
    blockAction(env, 'edit_conn', env.channel('C1').connections[0].id);
    const modal = env.calls('views.push').at(-1).params.view;
    const picker = modal.blocks.find((b) => b.block_id === 'daily_time');
    assert.deepStrictEqual([picker.type, picker.element.type, picker.element.initial_time], ['input', 'timepicker', '09:00']);

    configure(env, { daily: { time: 0 }, reminder: { enabled: true, allDayTime: 12 * 60 + 47 } });
    let conn = env.channel('C1').connections[0];
    assert.strictEqual(conn.daily.time, 0, '자정');
    assert.strictEqual(conn.reminder.allDayTime, 767, '오후 12:47');
    configure(env, { daily: { time: 23 * 60 + 15 } });
    conn = env.channel('C1').connections[0];
    assert.strictEqual(conn.daily.time, 1395);
    env.command({ user_id: 'UA', channel_id: 'C1' });
    assert.ok(JSON.stringify(env.calls('views.open').at(-1).params.view).includes('오후 11:15'));

    configure(env, { daily: { time: 18 * 60 + 10, empty: 'send' }, reminder: { enabled: true, offset: 0, allDayTime: 18 * 60 + 12, days: [1, 3, 4] } });
    env.command({ user_id: 'UA', channel_id: 'C1' });
    // The calendar name line, then its routine lines as small gray context text.
    const summaryOf = () => {
      const blocks = env.calls('views.open').at(-1).params.view.blocks;
      const i = blocks.findIndex((b) => b.accessory && b.accessory.action_id === 'conn_menu');
      assert.strictEqual(blocks[i + 1].type, 'context');
      return `${blocks[i].text.text}\n${blocks[i + 1].elements[0].text}`;
    };
    const summary = summaryOf();
    assert.strictEqual(summary, [
      '*<https://calendar.google.com/calendar/embed?src=cal1&ctz=Asia%2FSeoul|디자인팀>*',
      '📅 하루 요약 (월-금)  |  오후 6:10  |  모든 일정  |  일정없음 알림 O',
      '🔔 일정 알림 (월, 수, 목)  |  일정 시작 시간에  |  종일 일정 알림 O (오후 6:12)',
    ].join('\n'));
    configure(env, { reminder: { enabled: false } });
    env.command({ user_id: 'UA', channel_id: 'C1' });
    assert.ok(summaryOf().includes('📅') && !summaryOf().includes('🔔'), 'a routine that is off has no summary line');
  },

  'on/off buttons redraw the settings screen, keeping picked values, without saving': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const connId = env.channel('C1').connections[0].id;
    blockAction(env, 'edit_conn', connId);
    let modal = env.calls('views.push').at(-1).params.view;
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'daily_enabled').accessory.text.text, '● 켜짐');
    // 알림 유형 dropdown: each option, with + on the one currently selected.
    const tabs = () => { const sel = modal.blocks.find((b) => b.block_id === 'tabs').accessory; return sel.options.map((o) => `${o.text.text}${o.value === sel.initial_option.value ? '+' : ''}`); };
    assert.deepStrictEqual(tabs(), ['📅 하루 요약  |  켜짐+', '🔔 일정 알림  |  꺼짐', '✏️ 변경 알림  |  꺼짐']);
    assert.ok(!modal.blocks.some((b) => b.block_id === 'reminder_enabled'), 'only the selected tab is shown');
    const days = modal.blocks.find((b) => b.block_id === 'daily_days');
    assert.strictEqual(days.element.type, 'multi_static_select');
    assert.deepStrictEqual(days.element.initial_options.map((o) => o.text.text), ['월', '화', '수', '목', '금']);
    assert.strictEqual(days.optional, false);
    assert.ok(!modal.blocks.some((b) => b.block_id === 'reminder_offset'), 'details of a routine that is off are hidden');

    const picked = { daily_days: { v: { selected_options: [{ value: '2' }, { value: '6' }] } } };
    const press = (actionId, value, values = {}) => {
      env.interact({ type: 'block_actions', user: { id: 'UA' }, view: { id: 'V3', private_metadata: modal.private_metadata, state: { values } }, actions: [actionId === 'pick_tab' ? { action_id: actionId, selected_option: { value } } : { action_id: actionId, value }] });
      modal = env.calls('views.update').at(-1).params.view;
    };
    const click = (routine, values) => press('toggle_routine', routine, values);
    press('pick_tab', 'reminder', picked);
    assert.deepStrictEqual(tabs(), ['📅 하루 요약  |  켜짐', '🔔 일정 알림  |  꺼짐+', '✏️ 변경 알림  |  꺼짐']);
    assert.ok(!modal.blocks.some((b) => b.block_id === 'daily_days'));
    click('reminder');
    assert.ok(modal.blocks.some((b) => b.block_id === 'reminder_offset'));
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'reminder_enabled').accessory.text.text, '● 켜짐');
    press('pick_tab', 'daily');
    assert.deepStrictEqual(modal.blocks.find((b) => b.block_id === 'daily_days').element.initial_options.map((o) => o.text.text), ['화', '토'], 'picks survive switching tabs');
    assert.deepStrictEqual(env.channel('C1').connections[0].daily.days, [1, 2, 3, 4, 5], 'nothing saved before 저장');

    click('daily');
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'daily_enabled').accessory.text.text, '○ 꺼짐');
    assert.ok(!modal.blocks.some((b) => b.block_id === 'daily_days'));
    click('daily');
    assert.deepStrictEqual(modal.blocks.find((b) => b.block_id === 'daily_days').element.initial_options.map((o) => o.text.text), ['화', '토'], 'turning back on restores picks');
    const before = env.calls('views.update').length;
    env.interact({ type: 'block_actions', user: { id: 'UB' }, view: { id: 'V3', private_metadata: modal.private_metadata }, actions: [{ action_id: 'toggle_routine', value: 'daily' }] });
    assert.strictEqual(env.calls('views.update').length, before, 'non-admin clicks are ignored');

    const saved = env.interact({ type: 'view_submission', user: { id: 'UA' }, view: { id: 'V3', callback_id: 'conn_settings', private_metadata: modal.private_metadata, state: { values: {} } } });
    assert.strictEqual(saved.content, '');
    const conn = env.channel('C1').connections[0];
    assert.deepStrictEqual(conn.daily.days, [2, 6]);
    assert.strictEqual(conn.reminder.enabled, true);
  },

  'routine settings require at least one routine and at least one day': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const warns = (out) => {
      const body = response(out);
      assert.strictEqual(body.response_action, 'update');
      return JSON.stringify(body.view.blocks);
    };
    assert.ok(warns(configure(env, { daily: { enabled: false } })).includes('하나 이상 켜야'));
    assert.ok(warns(configure(env, { daily: { days: [] } })).includes('요일을 하나 이상'));
    assert.ok(warns(configure(env, { reminder: { enabled: true, days: [] } })).includes('요일을 하나 이상'));
    assert.deepStrictEqual(env.channel('C1').connections[0].daily.days, [1, 2, 3, 4, 5]);
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
    const text = env.posts('C1')[0];
    assert.strictEqual(text, '*일정 알림* | 디자인팀 | 총 1건\n10:30 - 11:00 디자인 리뷰');
    const [attachment] = env.rawPosts('C1')[0].attachments;
    assert.ok(attachment.pretext.startsWith('*일정 알림*') && !attachment.text.includes('디자인팀'), 'calendar line sits outside the color bar');

    event.start = kst('2026-11-09T10:40');
    event.end = kst('2026-11-09T11:10');
    env.run('onCalendarChanged');
    env.setNow('2026-11-09T10:25');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 2);
  },

  'reminders from the same calendar at the same time share one message; a later addition is sent alone': () => {
    const events = [
      ev('b', '두번째', '2026-11-09T10:30', '2026-11-09T11:30'),
      ev('a', '첫번째', '2026-11-09T10:30', '2026-11-09T11:00'),
    ];
    const env = connectedEnv('2026-11-09T10:00', events, { daily: { enabled: false }, reminder: { enabled: true, offset: 15 } });
    env.addCalendar('cal2', '개발팀', [ev('c', '다른 캘린더', '2026-11-09T10:30', '2026-11-09T11:00')]);
    addConnection(env, 'cal2');
    configure(env, { daily: { enabled: false }, reminder: { enabled: true, offset: 15 } }, 'UA', 1);
    env.clearCalls();
    env.setNow('2026-11-09T10:15');
    env.run('dispatchDue');
    const posts = env.rawPosts('C1');
    assert.strictEqual(posts.length, 2, 'one message per calendar');
    const design = posts.find((p) => p.attachments[0].pretext.includes('디자인팀'));
    assert.strictEqual(design.attachments.length, 2);
    assert.ok(design.attachments[0].pretext.endsWith('| 총 2건') && !design.attachments[1].pretext, 'header once, with count');

    events.push(ev('n', '새 일정', '2026-11-09T10:30', '2026-11-09T11:00'));
    env.run('onCalendarChanged');
    env.setNow('2026-11-09T10:16');
    env.run('dispatchDue');
    const latest = env.rawPosts('C1');
    assert.strictEqual(latest.length, 3);
    assert.strictEqual(latest[2].attachments.length, 1);
    assert.ok(latest[2].attachments[0].text.includes('새 일정'));
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
    const [post] = env.rawPosts('C1');
    assert.strictEqual(env.rawPosts('C1').length, 1);
    assert.strictEqual(post.attachments.length, 2);
    const byTitle = (t) => post.attachments.find((a) => a.text.includes(t));
    const meeting = byTitle('공개 회의');
    assert.strictEqual(meeting.footer, '회의실 &amp; 링크', 'description goes to the small gray footer, not a quote');
    assert.ok(!meeting.text.includes('>') || meeting.text.includes('<https'), meeting.text);
    assert.strictEqual(byTitle('긴 설명').footer, `${'a'.repeat(299)}…`, 'footer is capped at 300 characters');
  },

  'daily summary respects scope and the empty-day option': () => {
    const events = [allDay('h', '창립기념일', '2026-11-09', '2026-11-10'), ev('t', '주간 회의', '2026-11-09T14:00', '2026-11-09T15:00')];
    const timed = connectedEnv('2026-11-09T08:50', events, { daily: { scope: 'timed' } });
    timed.setNow('2026-11-09T09:00');
    timed.run('dispatchDue');
    const summary = timed.posts('C1')[0];
    assert.strictEqual(summary, '*오늘 요약* | 11월 9일 월요일 | 디자인팀 | 총 1건\n14:00 - 15:00 주간 회의');
    assert.strictEqual(timed.rawPosts('C1')[0].attachments[0].color, '#4285F4');

    const skip = connectedEnv('2026-11-10T08:50', [], { daily: { empty: 'skip' } });
    skip.setNow('2026-11-10T09:00');
    skip.run('dispatchDue');
    assert.strictEqual(skip.posts('C1').length, 0);

    const send = connectedEnv('2026-11-10T08:50', [], { daily: { empty: 'send' } });
    send.setNow('2026-11-10T09:00');
    send.run('dispatchDue');
    assert.strictEqual(send.posts('C1')[0], '*오늘 요약* | 11월 10일 화요일 | 디자인팀 | 총 0건\n일정 없음');
  },

  'daily summaries for the same channel and time are grouped by calendar in one message': () => {
    const env = connectedEnv('2026-11-09T08:40', [ev('a1', 'A 회의', '2026-11-09T10:00', '2026-11-09T11:00'), ev('a2', 'A 리뷰', '2026-11-09T15:00', '2026-11-09T16:00')]);
    env.addCalendar('cal2', '개발팀', [ev('b1', 'B 배포', '2026-11-09T13:00', '2026-11-09T14:00')]);
    env.state.calendars.cal2.color = '#E67C73';
    env.addCalendar('cal3', '전사', [ev('c1', '전사 공지', '2026-11-09T17:00', '2026-11-09T18:00')]);
    addConnection(env, 'cal2');
    addConnection(env, 'cal3');
    configure(env, {}, 'UA', 0);
    configure(env, {}, 'UA', 1);
    configure(env, { daily: { time: 600 } }, 'UA', 2); // 10:00, a separate message
    env.setNow('2026-11-09T09:00');
    env.run('dispatchDue');
    const nine = env.posts('C1');
    assert.strictEqual(nine.length, 1);
    // One attachment per event; the calendar header rides only on each calendar's first event, outside the bar.
    const attachments = env.rawPosts('C1')[0].attachments;
    assert.deepStrictEqual(attachments.map((a) => a.pretext || null), [
      '*오늘 요약* | 11월 9일 월요일 | 디자인팀 | 총 2건', null, '*오늘 요약* | 11월 9일 월요일 | 개발팀 | 총 1건',
    ]);
    assert.deepStrictEqual(attachments.map((a) => a.color), ['#4285F4', '#4285F4', '#E67C73']);
    assert.strictEqual(nine[0], [
      '*오늘 요약* | 11월 9일 월요일 | 디자인팀 | 총 2건', '10:00 - 11:00 A 회의', '15:00 - 16:00 A 리뷰',
      '*오늘 요약* | 11월 9일 월요일 | 개발팀 | 총 1건', '13:00 - 14:00 B 배포',
    ].join('\n'));
    env.setNow('2026-11-09T10:00');
    env.run('rebuildSchedule');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 2);
    assert.ok(env.posts('C1')[1].startsWith('*오늘 요약* | 11월 9일 월요일 | 전사'));
  },

  'event titles link to the event, using the occurrence id for recurring events': () => {
    const events = [
      ev('abc123@google.com', '단건 <회의>', '2026-11-09T14:00', '2026-11-09T15:00'),
      ev('weekly9@google.com', '주간 회의', '2026-11-09T16:00', '2026-11-09T17:00', { recurring: true }),
      allDay('hol@google.com', '휴일', '2026-11-09', '2026-11-10', { recurring: true }),
    ];
    const env = connectedEnv('2026-11-09T08:50', events);
    env.setNow('2026-11-09T09:00');
    env.run('dispatchDue');
    const texts = env.rawPosts('C1')[0].attachments.map((a) => a.text);
    const link = (text) => text.match(/<(https:[^|]+)\|([^>]+)>/);
    const [, holLink, holTitle] = link(texts[0]);
    const [, oneLink, oneTitle] = link(texts[1]);
    const [, weeklyLink] = link(texts[2]);
    assert.strictEqual(holTitle, '휴일');
    assert.strictEqual(oneTitle, '단건 &lt;회의&gt;');
    assert.ok(oneLink.startsWith('https://www.google.com/calendar/event?eid='));
    assert.strictEqual(eidOf(oneLink), 'abc123 cal1');
    assert.strictEqual(eidOf(weeklyLink), 'weekly9_20261109T070000Z cal1');
    assert.strictEqual(eidOf(holLink), 'hol_20261109 cal1');
  },

  'a reminder that would arrive more than 5 minutes after the start is dropped': () => {
    const env = connectedEnv('2026-11-09T09:50', [], { daily: { enabled: false }, reminder: { enabled: true, offset: 0 } });
    env.state.calendars.cal1.events.push(ev('e1', '늦게 만든 일정', '2026-11-09T10:00', '2026-11-09T10:30'));
    env.setNow('2026-11-09T10:06');
    env.run('onCalendarChanged');
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 0);
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

  'deleting a bot message asks for confirmation; only channel admins, only bot messages': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const shortcut = (user, message) => env.interact({ type: 'message_action', callback_id: 'delete_message', user: { id: user }, channel: { id: 'C1' }, message, response_url: 'https://hooks.slack.com/actions/x', api_app_id: 'A1' });
    shortcut('UB', { user: 'UBOT', ts: '1.0' });
    shortcut('UA', { user: 'UX', ts: '2.0' });
    assert.strictEqual(env.calls('views.open').length, 0);

    shortcut('UA', { user: 'UBOT', ts: '3.0', attachments: [{ pretext: '*오늘* | *디자인팀*', text: '14:00 - 15:00 주간 회의' }] });
    assert.strictEqual(env.calls('chat.delete').length, 0, 'nothing is deleted before confirming');
    const modal = env.calls('views.open')[0].params.view;
    assert.strictEqual(modal.callback_id, 'delete_message');
    assert.ok(JSON.stringify(modal.blocks).includes('주간 회의'));

    const confirm = (user) => env.interact({ type: 'view_submission', user: { id: user }, view: { id: 'VD', callback_id: 'delete_message', private_metadata: modal.private_metadata, state: { values: {} } } });
    confirm('UB');
    assert.strictEqual(env.calls('chat.delete').length, 0);
    assert.strictEqual(confirm('UA').content, '');
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
    assert.ok(!msgs.some((m) => m.includes('[테스트')), 'no test label');
    assert.ok(msgs[0] === '*디자인팀*, *11월 6일 (금)* 에 등록된 일정입니다.');
    assert.ok(msgs.includes('*하루 요약* | 11월 6일 금요일 | 디자인팀 | 총 1건\n14:00 - 15:00 금요일 회의'), msgs.join('\n---\n'));
    assert.ok(msgs.includes('*일정 알림* | 디자인팀 | 총 1건\n14:00 - 15:00 금요일 회의'), msgs.join('\n---\n'));
    assert.ok(!msgs.join('\n').includes('목요일 회의') && !msgs.join('\n').includes('다음 회의'));
    assert.strictEqual(env.posts('C1').length, 0);
  },

  'the change-calendar button changes the calendar ID, keeping its settings': () => {
    const env = connectedEnv('2026-11-09T10:00', [], { daily: { time: 600 } });
    env.addCalendar('cal2', '개발팀', [ev('n', '배포', '2026-11-09T14:00', '2026-11-09T15:00')]);
    env.addCalendar('cal3', '전사', []);
    const connId = env.channel('C1').connections[0].id;

    env.command({ user_id: 'UA', channel_id: 'C1' });
    const blocks = env.calls('views.open').at(-1).params.view.blocks;
    assert.ok(blocks.some((b) => b.text && b.text.text.startsWith('*<https://calendar.google.com/calendar/embed?src=cal1&ctz=Asia%2FSeoul|디자인팀>*')));
    const row = blocks.find((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'change_calendar'));
    assert.deepStrictEqual(row.elements.map((e) => e.text.text), ['연결상태 테스트', '일시정지', '캘린더 바꾸기', '⚙️ 설정']);
    env.command({ user_id: 'UB', channel_id: 'C1' });
    assert.ok(!JSON.stringify(env.calls('views.open').at(-1).params.view).includes('change_calendar'), 'non-admins get no change button');

    blockAction(env, 'change_calendar', connId);
    const modal = env.calls('views.push').at(-1).params.view;
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'calendar_id').element.initial_value, 'cal1');

    const submit = (calendarId, user = 'UA') => env.interact({
      type: 'view_submission',
      user: { id: user },
      view: { id: 'V4', callback_id: 'change_calendar', private_metadata: modal.private_metadata, state: { values: { calendar_id: { v: { value: calendarId } } } } },
    });
    addConnection(env, 'cal3');
    assert.ok(response(submit('nope')).errors.calendar_id.includes('볼 수 없는'));
    assert.ok(response(submit('cal3')).errors.calendar_id.includes('이미 연결'));
    assert.ok(response(submit('cal2', 'UB')).errors.calendar_id.includes('관리자만'));
    assert.strictEqual(env.channel('C1').connections[0].calendarId, 'cal1');

    env.clearCalls();
    assert.strictEqual(submit(' cal2 ').content, '');
    const conn = env.channel('C1').connections[0];
    assert.deepStrictEqual([conn.id, conn.calendarId, conn.calendarName, conn.daily.time], [connId, 'cal2', '개발팀', 600]);
    assert.ok(env.channel('C1').log[0].text.includes('캘린더 변경: 디자인팀 → 개발팀'));
    assert.ok(env.ephemerals('UA').pop().includes('배포'), 'previews the new calendar');
    assert.strictEqual(env.calls('views.update').at(-1).params.view_id, 'V1');
  },

  'a connection is deleted from the top line of its settings screen': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const connId = env.channel('C1').connections[0].id;
    blockAction(env, 'edit_conn', connId);
    const modal = env.calls('views.push').at(-1).params.view;
    assert.ok(modal.blocks[0].text.text === '*디자인팀* 일정을 <#C1>에 발송합니다.' && modal.blocks[0].accessory.text.text === '연결 끊기');
    const danger = modal.blocks[0].accessory;
    assert.deepStrictEqual([danger.action_id, danger.style, !!danger.confirm], ['delete_conn', 'danger', true]);

    env.interact({ type: 'block_actions', user: { id: 'UA' }, view: { id: 'V3', private_metadata: modal.private_metadata }, actions: [{ action_id: 'delete_conn', value: connId }] });
    assert.strictEqual(env.channel('C1').connections.length, 0);
    const [parent, self] = env.calls('views.update').slice(-2).map((c) => c.params);
    assert.strictEqual(parent.view_id, 'V1');
    assert.strictEqual(parent.view.callback_id, 'channel');
    assert.strictEqual(self.view_id, 'V3');
    assert.ok(JSON.stringify(self.view).includes('연결을 끊었습니다'));
  },

  'change alerts wait for the last edit and send only the final content': () => {
    const env = connectedEnv('2026-11-09T10:00', [ev('old', '기존 회의', '2026-11-10T10:00', '2026-11-10T11:00')]);
    configure(env, { daily: { enabled: false }, changes: { enabled: true, types: ['created', 'updated', 'deleted'], wait: 1 } });
    env.run('rebuildSchedule'); // first check: existing events become the baseline, nothing is sent
    env.clearCalls();
    const dispatchAt = (iso) => { env.setNow(iso); env.run('dispatchDue'); };

    env.setNow('2026-11-09T10:05');
    env.calendarEdit('cal1', 'n1', { title: '주간 회의', start: kst('2026-11-12T14:00'), end: kst('2026-11-12T15:00'), desc: '3층' });
    env.setNow('2026-11-09T10:06');
    env.calendarEdit('cal1', 'n1', { title: '주간 회의 (수정)' });
    dispatchAt('2026-11-09T10:06');
    assert.strictEqual(env.posts('C1').length, 0, 'still waiting after the last edit');
    dispatchAt('2026-11-09T10:07');
    assert.deepStrictEqual(env.posts('C1'), ['*일정 등록* | 디자인팀\n11월 12일 (목) 14:00 - 15:00 주간 회의 (수정)\n3층']);
    assert.ok(env.rawPosts('C1')[0].attachments[0].text.includes('<https://calendar.example/n1|'), 'title links to the event');

    env.setNow('2026-11-09T10:10');
    env.calendarEdit('cal1', 'n2', { title: '오타', start: kst('2026-11-12T16:00'), end: kst('2026-11-12T17:00') });
    env.calendarEdit('cal1', 'n2', { deleted: true });
    env.calendarEdit('cal1', 'old', { attendees: ['someone'] }); // not a title/time/description change
    dispatchAt('2026-11-09T10:12');
    assert.strictEqual(env.posts('C1').length, 1, 'created then deleted, or attendee-only changes, send nothing');

    env.calendarEdit('cal1', 'old', { start: kst('2026-11-10T11:00'), end: kst('2026-11-10T12:00') });
    dispatchAt('2026-11-09T10:14');
    assert.strictEqual(env.posts('C1')[1], '*일정 변경* | 디자인팀\n11월 10일 (화) 11:00 - 12:00 기존 회의');

    env.calendarEdit('cal1', 'old', { deleted: true });
    dispatchAt('2026-11-09T10:16');
    assert.strictEqual(env.posts('C1')[2], '*일정 삭제* | 디자인팀\n~11월 10일 (화) 11:00 - 12:00 기존 회의~');
    assert.ok(!env.rawPosts('C1')[2].attachments[0].text.includes('<https'), 'deleted events have no link');
  },

  'change alert types and the past-event option filter what is sent': () => {
    const env = connectedEnv('2026-11-09T10:00', [ev('old', '기존 회의', '2026-11-10T10:00', '2026-11-10T11:00')]);
    assert.deepStrictEqual(env.channel('C1').connections[0].changes, { enabled: false, types: [], wait: 1, past: false, since: 0, days: [1, 2, 3, 4, 5], hold: false, holdTime: 540 }, 'off by default');
    configure(env, { changes: { enabled: true, types: ['created'], wait: 0 } });
    env.run('rebuildSchedule');
    env.clearCalls();

    env.calendarEdit('cal1', 'old', { title: '기존 회의 (변경)' });
    env.calendarEdit('cal1', 'p1', { title: '어제 일', start: kst('2026-11-08T14:00'), end: kst('2026-11-08T15:00') });
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 0, 'updates are off; past events are off');

    configure(env, { changes: { enabled: true, types: ['created'], wait: 0, past: true } });
    env.calendarEdit('cal1', 'p2', { title: '지난 일정 등록', start: kst('2026-11-08T16:00'), end: kst('2026-11-08T17:00') });
    env.run('dispatchDue');
    assert.deepStrictEqual(env.posts('C1'), ['*일정 등록* | 디자인팀\n11월 8일 (일) 16:00 - 17:00 지난 일정 등록']);
  },

  'making an event private counts as deleted; a recurring series change is one alert with its repeat rule': () => {
    const env = connectedEnv('2026-11-09T10:00', [
      ev('pub', '공개 회의', '2026-11-11T10:00', '2026-11-11T11:00'),
      ev('rec', '스탠드업', '2026-11-03T10:00', '2026-11-03T10:30', { recurring: true, next: [kst('2026-11-10T10:00'), kst('2026-11-10T10:30')] }),
    ]);
    configure(env, { changes: { enabled: true, types: ['updated', 'deleted'], wait: 0 } });
    env.run('rebuildSchedule');
    env.clearCalls();

    env.calendarEdit('cal1', 'pub', { visibility: 'PRIVATE' });
    env.calendarEdit('cal1', 'rec', { title: '스탠드업 회의' });
    env.run('dispatchDue');
    const posts = env.posts('C1');
    assert.ok(posts.includes('*일정 삭제* | 디자인팀\n~11월 11일 (수) 10:00 - 11:00 공개 회의~'), posts.join('\n---\n'));
    assert.ok(posts.includes('*일정 변경* | 디자인팀\n11월 10일 (화) 10:00 - 10:30 스탠드업 회의\n매주 화요일'), posts.join('\n---\n'));
  },

  'an expired sync token re-reads the calendar and still reports changes since the last check': () => {
    const env = connectedEnv('2026-11-09T10:00', [ev('old', '기존 회의', '2026-11-10T10:00', '2026-11-10T11:00')]);
    configure(env, { changes: { enabled: true, types: ['created'], wait: 0 } });
    env.run('rebuildSchedule');
    env.clearCalls();
    const key = Object.keys(env.state.props).find((k) => k.startsWith('CS_') && k.endsWith('#0'));
    env.state.props[key] = env.state.props[key].replace(/"token":"\d+"/, '"token":"expired"');
    env.setNow('2026-11-09T10:03');
    env.calendarEdit('cal1', 'n1', { title: '새 회의', start: kst('2026-11-12T14:00'), end: kst('2026-11-12T15:00') });
    env.run('dispatchDue');
    assert.strictEqual(env.posts('C1').length, 1);
    assert.ok(env.posts('C1')[0].includes('새 회의') && !env.posts('C1')[0].includes('기존 회의'));
  },

  'the change alerts tab needs a type, and its summary shows in the channel settings': () => {
    const env = connectedEnv('2026-11-09T10:00');
    blockAction(env, 'edit_conn', env.channel('C1').connections[0].id);
    let modal = env.calls('views.push').at(-1).params.view;
    const press = (actionId, value) => {
      env.interact({ type: 'block_actions', user: { id: 'UA' }, view: { id: 'V3', private_metadata: modal.private_metadata, state: { values: {} } }, actions: [actionId === 'pick_tab' ? { action_id: actionId, selected_option: { value } } : { action_id: actionId, value }] });
      modal = env.calls('views.update').at(-1).params.view;
    };
    press('pick_tab', 'changes');
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'changes_enabled').accessory.text.text, '○ 꺼짐');
    press('toggle_routine', 'changes');
    const order = modal.blocks.map((b) => b.block_id).filter((id) => /^changes_/.test(id || ''));
    assert.deepStrictEqual(order, ['changes_enabled', 'changes_days', 'changes_types', 'changes_wait', 'changes_past', 'changes_hold_enabled']);
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'changes_past').label.text, '과거 일정에 대한 변경 알림');
    assert.ok(JSON.stringify(modal.blocks).includes('알림 종류를 하나 이상'), 'no type picked yet');
    press('toggle_routine', 'hold');
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'changes_hold_enabled').accessory.text.text, '● 켜짐');
    assert.ok(modal.blocks.some((b) => b.block_id === 'changes_hold_time'), 'turning it on shows the send time');

    const blocked = response(configure(env, { changes: { enabled: true, types: [] } }));
    assert.strictEqual(blocked.response_action, 'update');
    assert.strictEqual(env.channel('C1').connections[0].changes.enabled, false);

    assert.strictEqual(configure(env, { daily: { enabled: false }, changes: { enabled: true, types: ['created', 'deleted'], wait: 0 } }).content, '', 'change alerts alone are enough to save');
    const conn = env.channel('C1').connections[0];
    assert.ok(conn.changes.since > 0);
    env.command({ user_id: 'UA', channel_id: 'C1' });
    const view = JSON.stringify(env.calls('views.open').at(-1).params.view);
    assert.ok(view.includes('✏️ 변경 알림 (매일)  |  등록, 삭제만  |  즉시 알림  |  과거 일정 변경 알림 X  |  설정요일 외 변경 재알림 X'), view);
  },

  'without the Calendar API service, change alerts DM the app admin once': () => {
    const env = connectedEnv('2026-11-09T10:00');
    configure(env, { changes: { enabled: true, types: ['created'], wait: 0 } });
    delete env.sandbox.Calendar;
    env.clearCalls();
    env.run('rebuildSchedule');
    env.run('rebuildSchedule');
    const dms = env.posts('UA');
    assert.strictEqual(dms.length, 1);
    assert.ok(dms[0].includes('Google Calendar API'));
  },

  'the ⋯ menu disconnects after confirming; paused status and the change log show in the channel settings': () => {
    const env = connectedEnv('2026-11-09T10:00');
    const connId = env.channel('C1').connections[0].id;
    blockAction(env, 'toggle_conn', connId);
    env.command({ user_id: 'UA', channel_id: 'C1' });
    let view = env.calls('views.open').at(-1).params.view;
    assert.deepStrictEqual([view.title.text, view.submit, view.close.text, view.blocks[0].text.text, view.blocks[0].accessory.text.text], ['Checky Bot 설정', undefined, '닫기', '현재 채널: <#C1>', '캘린더 추가']);
    assert.deepStrictEqual([view.blocks[1].text.text, view.blocks[1].accessory.action_id, view.blocks[1].accessory.text.text], ['관리자: <@UA>', 'edit_admins', '관리자 변경']);
    const row = view.blocks.find((b) => b.accessory && b.accessory.action_id === 'conn_menu');
    const details = view.blocks[view.blocks.indexOf(row) + 1];
    assert.strictEqual(details.type, 'context', 'routine and status lines are small gray text');
    assert.strictEqual(details.elements[0].text, '~📅 하루 요약 (월-금)  |  오전 9:00  |  모든 일정  |  일정없음 알림 X~\n⏸️ 일시정지 중');
    assert.deepStrictEqual(row.accessory.options.map((o) => o.text.text), ['⚙️ 설정', '구글 캘린더 열기', '연결 끊기']);
    const restart = view.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'toggle_conn');
    assert.deepStrictEqual([restart.text.text, restart.style], ['다시 시작', 'primary']);
    // Change log entries are small gray context text.
    const log = view.blocks.filter((b) => b.type === 'context' && /\n<@UA>  \|  2026\/11\/09 오전 10:00$/.test(b.elements[0].text)).map((b) => b.elements[0].text.split('\n')[0]);
    assert.deepStrictEqual(log.slice(0, 2), ['*디자인팀  |  일시정지*', '*디자인팀  |  새 캘린더 추가*']);

    const menu = (option) => env.interact({ type: 'block_actions', user: { id: 'UA' }, trigger_id: 'TRIG', view: { id: 'V1', private_metadata: JSON.stringify({ channelId: 'C1' }) }, actions: [{ action_id: 'conn_menu', selected_option: { value: `${option}|${connId}` } }] });
    menu('open');
    assert.strictEqual(env.calls('views.push').length, 0, 'opening Google Calendar is a plain link');
    menu('settings');
    assert.strictEqual(env.calls('views.push').at(-1).params.view.callback_id, 'conn_settings', '⚙️ 설정 opens the alert settings');
    menu('delete');
    const confirm = env.calls('views.push').at(-1).params.view;
    assert.strictEqual(confirm.callback_id, 'disconnect');
    assert.strictEqual(env.channel('C1').connections.length, 1, 'nothing is removed before confirming');
    const submit = (user) => env.interact({ type: 'view_submission', user: { id: user }, view: { id: 'V5', callback_id: 'disconnect', private_metadata: confirm.private_metadata, state: { values: {} } } });
    assert.strictEqual(response(submit('UB')).response_action, 'update', 'non-admins cannot disconnect');
    assert.strictEqual(submit('UA').content, '');
    assert.strictEqual(env.channel('C1').connections.length, 0);
    assert.strictEqual(env.channel('C1').log[0].text, '연결 끊기: 디자인팀');
    assert.strictEqual(env.calls('views.update').at(-1).params.view_id, 'V1');
  },

  'all-day events get reminders only when 종일 일정 알림 is on': () => {
    const event = allDay('w', '워크숍', '2026-11-10', '2026-11-11');
    const off = connectedEnv('2026-11-10T08:50', [event], { daily: { enabled: false }, reminder: { enabled: true, allDay: false } });
    off.setNow('2026-11-10T09:00');
    off.run('dispatchDue');
    assert.strictEqual(off.posts('C1').length, 0);
    off.command({ user_id: 'UA', channel_id: 'C1' });
    assert.ok(JSON.stringify(off.calls('views.open').at(-1).params.view).includes('🔔 일정 알림 (월-금)  |  일정 15분 전에  |  종일 일정 알림 X'));

    const fresh = createEnv('2026-11-10T08:50');
    fresh.addCalendar('cal1', '디자인팀', []);
    fresh.run('setup');
    fresh.event({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1', inviter: 'UA' });
    addConnection(fresh, 'cal1');
    assert.strictEqual(fresh.channel('C1').connections[0].reminder.allDay, false, 'off by default for new connections');

    // A connection saved before the switch existed keeps getting all-day reminders.
    const ch = JSON.parse(fresh.state.props.CH_C1);
    delete ch.connections[0].reminder.allDay;
    ch.connections[0].reminder.enabled = true;
    fresh.state.props.CH_C1 = JSON.stringify(ch);
    fresh.state.calendars.cal1.events.push(event);
    fresh.setNow('2026-11-10T09:00');
    fresh.run('rebuildSchedule');
    fresh.run('dispatchDue');
    assert.strictEqual(fresh.posts('C1').filter((p) => p.startsWith('*일정 알림*')).length, 1, 'besides the 09:00 daily summary');

    blockAction(fresh, 'edit_conn', ch.connections[0].id);
    let modal = fresh.calls('views.push').at(-1).params.view;
    fresh.interact({ type: 'block_actions', user: { id: 'UA' }, view: { id: 'V3', private_metadata: modal.private_metadata, state: { values: {} } }, actions: [{ action_id: 'pick_tab', selected_option: { value: 'reminder' } }] });
    modal = fresh.calls('views.update').at(-1).params.view;
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'reminder_allday_enabled').accessory.text.text, '● 켜짐');
    fresh.interact({ type: 'block_actions', user: { id: 'UA' }, view: { id: 'V3', private_metadata: modal.private_metadata, state: { values: {} } }, actions: [{ action_id: 'toggle_routine', value: 'allday' }] });
    modal = fresh.calls('views.update').at(-1).params.view;
    assert.strictEqual(modal.blocks.find((b) => b.block_id === 'reminder_allday_enabled').accessory.text.text, '○ 꺼짐');
    assert.ok(!modal.blocks.some((b) => b.block_id === 'reminder_allday_time'), 'the time picker hides when off');
  },

  '/checky today shows all of today only to me (anyone); today-all posts it to the channel (admins)': () => {
    const env = connectedEnv('2026-11-09T15:00', [
      allDay('h', '창립기념일', '2026-11-09', '2026-11-10'),
      ev('m', '주간 회의', '2026-11-09T10:00', '2026-11-09T11:00'),
      ev('t', '내일 회의', '2026-11-10T10:00', '2026-11-10T11:00'),
    ], { daily: { enabled: false }, reminder: { enabled: true } });
    env.addCalendar('cal2', '개발팀', []);
    addConnection(env, 'cal2');
    env.clearCalls();
    const expected = '*오늘 요약* | 11월 9일 월요일 | 디자인팀 | 총 2건\n종일 창립기념일\n10:00 - 11:00 주간 회의\n*오늘 요약* | 11월 9일 월요일 | 개발팀 | 총 0건\n일정 없음';

    assert.strictEqual(env.command({ user_id: 'UB', channel_id: 'C1', text: 'today' }).content, '');
    assert.deepStrictEqual(env.ephemerals('UB'), [expected], 'whole day regardless of daily summary settings; empty calendars say 일정 없음');
    assert.strictEqual(env.posts('C1').length, 0);

    assert.ok(response(env.command({ user_id: 'UB', channel_id: 'C1', text: 'today-all' })).text.includes('관리자만'));
    assert.strictEqual(env.posts('C1').length, 0);
    env.command({ user_id: 'UA', channel_id: 'C1', text: 'today-all' });
    const confirm = env.calls('views.open').at(-1).params.view;
    assert.deepStrictEqual([confirm.callback_id, confirm.submit.text, confirm.blocks[0].text.text], ['today_all', '발송', '<#C1>에 오늘의 전체 일정을 발송하시겠습니까?']);
    assert.strictEqual(env.posts('C1').length, 0, 'nothing is posted before confirming');
    const submit = (user) => env.interact({ type: 'view_submission', user: { id: user }, view: { id: 'V6', callback_id: 'today_all', private_metadata: confirm.private_metadata, state: { values: {} } } });
    assert.strictEqual(response(submit('UB')).response_action, 'update', 'non-admins cannot confirm');
    assert.strictEqual(submit('UA').content, '');
    assert.deepStrictEqual(env.posts('C1'), [expected]);
    assert.strictEqual(env.channel('C1').log[0].text, '오늘 일정 채널에 발송');

    assert.ok(response(env.command({ user_id: 'UA', channel_id: 'C9', text: 'today' })).text.includes('연결된 캘린더가 없습니다'));
  },

  'change alerts on unchosen weekdays are dropped, or held for the next chosen day when 쌓인 알림 is on': () => {
    // 2026-11-07 is a Saturday; weekdays only.
    const setup = (hold) => {
      const env = connectedEnv('2026-11-07T10:00', []);
      configure(env, { changes: { enabled: true, types: ['created'], wait: 0, days: [1, 2, 3, 4, 5], hold, holdTime: 9 * 60 } });
      env.run('rebuildSchedule');
      env.clearCalls();
      env.calendarEdit('cal1', 'n1', { title: '주말에 등록', start: kst('2026-11-12T14:00'), end: kst('2026-11-12T15:00') });
      env.run('dispatchDue');
      return env;
    };

    const dropped = setup(false);
    dropped.setNow('2026-11-09T09:00');
    dropped.run('dispatchDue');
    assert.strictEqual(dropped.posts('C1').length, 0, 'off: alerts from Saturday are not sent');

    const held = setup(true);
    assert.strictEqual(held.posts('C1').length, 0, 'nothing on Saturday');
    held.setNow('2026-11-08T12:00'); // Sunday: another change joins the held alert
    held.calendarEdit('cal1', 'n2', { title: '일요일에 등록', start: kst('2026-11-13T14:00'), end: kst('2026-11-13T15:00') });
    held.run('dispatchDue');
    held.setNow('2026-11-09T08:59');
    held.run('dispatchDue');
    assert.strictEqual(held.posts('C1').length, 0, 'held until 09:00 Monday');
    held.setNow('2026-11-09T09:00');
    held.run('dispatchDue');
    assert.deepStrictEqual(held.posts('C1'), ['*일정 등록* | 디자인팀\n11월 12일 (목) 14:00 - 15:00 주말에 등록', '*일정 등록* | 디자인팀\n11월 13일 (금) 14:00 - 15:00 일요일에 등록'], 'one message per event');

    held.command({ user_id: 'UA', channel_id: 'C1' });
    assert.ok(JSON.stringify(held.calls('views.open').at(-1).params.view).includes('✏️ 변경 알림 (월-금)  |  등록만  |  즉시 알림  |  과거 일정 변경 알림 X  |  설정요일 외 변경 재알림 O (오전 9:00)'));
  },

  'repeat rules read like Google Calendar, in the small gray line under the event': () => {
    const env = createEnv('2026-11-09T10:00');
    const say = (rule, startIso = '2026-11-10T10:00') => env.sandbox.describeRecurrence_([`RRULE:${rule}`], kst(startIso));
    assert.strictEqual(say('FREQ=DAILY'), '매일');
    assert.strictEqual(say('FREQ=DAILY;INTERVAL=2'), '2일마다');
    assert.strictEqual(say('FREQ=WEEKLY;BYDAY=TU;COUNT=13'), '매주 화요일, 13회');
    assert.strictEqual(say('FREQ=WEEKLY;BYDAY=MO,WE,FR'), '매주 월요일, 수요일, 금요일');
    assert.strictEqual(say('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), '매주 월-금');
    assert.strictEqual(say('FREQ=WEEKLY;INTERVAL=2'), '2주마다 화요일', 'no BYDAY: the day of the event');
    assert.strictEqual(say('FREQ=MONTHLY;BYMONTHDAY=15'), '매월 15일');
    assert.strictEqual(say('FREQ=MONTHLY;BYDAY=2TU'), '매월 둘째 화요일');
    assert.strictEqual(say('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T145959Z'), '매월 마지막 금요일, 2026년 12월 31일까지');
    assert.strictEqual(say('FREQ=YEARLY', '2026-11-09T10:00'), '매년 11월 9일');
    assert.strictEqual(say('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2'), '반복 일정', 'rules it cannot phrase');

    const daily = connectedEnv('2026-11-10T08:50', [
      ev('s', '스탠드업', '2026-11-10T09:30', '2026-11-10T10:00', { recurring: true, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=13', desc: '3층' }),
    ], { daily: { time: 540 } });
    daily.setNow('2026-11-10T09:00');
    daily.run('dispatchDue');
    const [att] = daily.rawPosts('C1')[0].attachments;
    assert.strictEqual(att.footer, '매주 화요일, 13회\n3층', 'repeat rule first, then the description');
    const reads = () => daily.state.apiCalls.filter((c) => c.get).length;
    const before = reads();
    daily.run('rebuildSchedule');
    assert.strictEqual(reads(), before, 'the rule is cached instead of read again');
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

  'app home shows a settings button only on channels the viewer administers': () => {
    const env = connectedEnv('2026-11-09T10:00');
    env.event({ type: 'app_home_opened', user: 'UA', tab: 'home' });
    env.event({ type: 'app_home_opened', user: 'UB', tab: 'home' });
    const [adminHome, memberHome] = env.calls('views.publish').map((c) => c.params.view);
    const settingsButtons = (view) => view.blocks.filter((b) => b.accessory && b.accessory.action_id === 'open_channel').map((b) => b.accessory.value);
    assert.deepStrictEqual(settingsButtons(adminHome), ['C1']);
    assert.deepStrictEqual(settingsButtons(memberHome), []);
    assert.ok(JSON.stringify(memberHome).includes('<#C1>'));

    const open = (user) => env.interact({ type: 'block_actions', user: { id: user }, view: { id: 'VH', type: 'home' }, actions: [{ action_id: 'open_channel', value: 'C1' }] });
    open('UB');
    assert.strictEqual(env.calls('views.open').length, 0);
    open('UA');
    const modal = env.calls('views.open')[0].params.view;
    assert.strictEqual(JSON.parse(modal.private_metadata).channelId, 'C1');
    assert.ok(actionIds(modal).includes('add_conn'));
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
