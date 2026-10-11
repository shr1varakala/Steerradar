// tests/backend.test.js — runs Code.gs in Node against in-memory mocks of the Apps Script services.
//   node tests/backend.test.js
// It checks the SECURITY properties (auth, ownership, OTP binding, private rooms, rate limits),
// not Google's own services. Re-run it after every change to Code.gs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let clock = 1_800_000_000_000;
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
}

function makeEnv() {
  const props = {}, cache = {}, outbox = [], files = {}, formats = new Set();
  const sheets = {};
  const mkSheet = () => {
    const sh = { data: [] };
    sh.getLastRow = () => sh.data.length;
    sh.deleteRow = (r) => { sh.data.splice(r - 1, 1); };
    sh.setFrozenRows = () => {};
    sh.getRange = (r, c, nr, nc) => ({
      getValues: () => sh.data.slice(r - 1, r - 1 + nr).map(row => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')),
      setValues(vals) { vals.forEach((row, i) => { sh.data[r - 1 + i] = sh.data[r - 1 + i] || []; row.forEach((v, j) => { sh.data[r - 1 + i][c - 1 + j] = v; }); }); return this; },
      setNumberFormat(f) { formats.add(f); return this; },
    });
    return sh;
  };
  const ss = {
    getId: () => 'SHEET1', getUrl: () => 'https://sheet/1',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = mkSheet()),
  };
  const folder = () => {
    const subs = {};
    return {
      getFoldersByName: (n) => { const f = subs[n]; let used = false; return { hasNext: () => !!f && !used, next: () => { used = true; return f; } }; },
      createFolder: (n) => (subs[n] = folder()),
      createFile: (blob) => {
        const id = 'F' + crypto.randomBytes(8).toString('hex');
        const f = { id, desc: '', trashed: false, getId: () => id, setDescription(d) { f.desc = d; }, getDescription: () => f.desc, setTrashed(t) { f.trashed = t; } };
        files[id] = f; return f;
      },
    };
  };
  const root = folder();
  const ctx = {
    Date: FakeDate, Math, JSON, String, Number, Object, Array, RegExp, isFinite, parseInt, Error, console,
    Logger: { log: () => {} },
    Utilities: {
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_a, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, ''),
    },
    SpreadsheetApp: { create: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (m) => outbox.push(m) },
    DriveApp: { getRootFolder: () => root, getFileById: (id) => { if (!files[id]) throw new Error('nf'); return files[id]; } },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }) }) }), deleteTrigger() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent: () => s }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\n;globalThis.__api={doPost,doGet,cleanup};', ctx);
  const call = (body) => JSON.parse(ctx.__api.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { call, outbox, files, formats, ctx };
}

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

const { call, outbox, files, formats } = makeEnv();
const codeFrom = (m) => /code is (\d{6})/.exec(m.body)[1];

function signUp(phone, email, name, username, vehicle) {
  let r = call({ action: 'sendOtp', phone, email, purpose: 'register' });
  if (!r.data || !r.data.ok) return { err: r };
  const code = codeFrom(outbox[outbox.length - 1]);
  r = call({ action: 'verifyOtp', phone, code });
  if (!r.data.ok) return { err: r };
  r = call({ action: 'register', phone, email, name, username, vehicle, vehicleType: 'car', device: 'test' });
  return r.data.ok ? { phone, token: r.data.token } : { err: r };
}

console.log('\nAuth & OTP');
t('unauthenticated insertLane is rejected', call({ action: 'insertLane', row: { id: 'x1', to: 'A' } }).error === 'unauthorized');
t('unauthenticated getMessages is rejected', call({ action: 'getMessages', roomId: 'local-tdr1' }).error === 'unauthorized');
t('unauthenticated activeVehicles is rejected', call({ action: 'activeVehicles' }).error === 'unauthorized');
t('prototype-pollution style action names are unknown', call({ action: '__proto__' }).error === 'unknown_action' && call({ action: 'constructor' }).error === 'unknown_action');
t('public ping works', call({ action: 'ping' }).data === 'pong');

let r = call({ action: 'register', phone: '9000000001', email: 'a@x.com', name: 'A', username: 'alice', vehicle: 'KA01AA1111' });
t('register without a verified OTP fails', r.data && r.data.error === 'not_verified', r);

call({ action: 'sendOtp', phone: '9000000001', email: 'a@x.com', purpose: 'register' });
const c1 = codeFrom(outbox[outbox.length - 1]);
r = call({ action: 'verifyOtp', phone: '9000000001', code: c1 === '000000' ? '111111' : '000000' });
t('wrong code reports attempts left', r.data.error === 'wrong_code' && r.data.attemptsLeft === 4, r);
call({ action: 'verifyOtp', phone: '9000000001', code: c1 });
r = call({ action: 'register', phone: '9000000001', email: 'evil@x.com', name: 'A', username: 'alice', vehicle: 'KA01AA1111' });
t('register with a DIFFERENT email than the one verified is refused', r.data.error === 'email_mismatch', r);
r = call({ action: 'register', phone: '9000000001', email: 'a@x.com', name: 'A', username: 'alice', vehicle: 'KA01AA1111', vehicleType: 'car' });
t('register after verified OTP succeeds and returns a token', r.data.ok && r.data.token.length >= 32, r);
const A = { phone: '9000000001', token: r.data.token };
t('OTP is single-use (cannot register again with it)', call({ action: 'register', phone: '9000000001', email: 'a@x.com', name: 'A2', username: 'alice2', vehicle: 'KA01AA2222' }).data.error !== undefined);

clock += 61_000;
r = call({ action: 'sendOtp', phone: '9000000001', email: 'attacker@evil.com', purpose: 'login' });
t('login OTP goes to the REGISTERED email, not the attacker-supplied one', r.data.ok && outbox[outbox.length - 1].to === 'a@x.com', outbox[outbox.length - 1].to);
clock += 61_000;
r = call({ action: 'login', phone: '9000000001' });
t('login without verifying the code is refused', r.data.error === 'not_verified', r);
call({ action: 'sendOtp', phone: '9000000001', email: 'a@x.com', purpose: 'login' }); // cooldown or ok
clock += 61_000;
call({ action: 'sendOtp', phone: '9000000001', email: 'a@x.com', purpose: 'login' });
const lc = codeFrom(outbox[outbox.length - 1]);
for (let i = 0; i < 5; i++) call({ action: 'verifyOtp', phone: '9000000001', code: lc === '123456' ? '654321' : '123456' });
r = call({ action: 'verifyOtp', phone: '9000000001', code: lc });
t('5 wrong guesses lock the code even if the 6th is right', r.data.ok === false && r.data.error === 'too_many_attempts', r);

clock += 61_000;
t('resend within 60s is blocked (cooldown)', (() => { call({ action: 'sendOtp', phone: '9000000002', email: 'b@x.com', purpose: 'register' }); return call({ action: 'sendOtp', phone: '9000000002', email: 'b@x.com', purpose: 'register' }).data.error === 'cooldown'; })());

clock += 61_000;
const B = signUp('9000000002', 'b@x.com', 'Bob', 'bobby', 'KA02BB2222');
t('second user registers', !!B.token, B);
clock += 61_000;
r = signUp('9000000003', 'c@x.com', 'Carl', 'carl', 'KA01AA1111');
t('plate already owned by another account is refused (vehicle_taken)', r.err && r.err.data && r.err.data.error === 'vehicle_taken', r);
clock += 61_000;
const C = signUp('9000000003', 'c@x.com', 'Carl', 'carl', 'KA03CC3333');
t('third user registers', !!C.token, C);

t('A\'s token with B\'s phone is rejected', call({ action: 'getMe', phone: B.phone, token: A.token }).error === 'unauthorized');
t('checkSession reports valid for a good token', call({ action: 'checkSession', ...A }).data.valid === true);
t('checkSession reports invalid (not an error) for a bad token', call({ action: 'checkSession', phone: A.phone, token: 'x'.repeat(40) }).data.valid === false);

console.log('\nLanes');
r = call({ action: 'insertLane', ...A, row: { id: 'x" onmouseover="alert(1)', to: 'Mall' } });
t('lane id that could inject HTML attributes is rejected (stored-XSS vector)', r.error === 'bad_id', r);
r = call({ action: 'insertLane', ...A, row: { id: 'mine-1', to: 'Mall', from: 'Home', via: 'X|Y', total: 4, taken: 1, fare: 20, lat: 12.971599, lng: 77.594566, vehicle: 'HACKED999', driver: 'Fake Name', vehicleType: 'car', peerId: 'steeradar-veh-KA01AA1111' } });
t('insertLane works for the signed-in owner', r.data && r.data.ok, r);
let list = call({ action: 'listLanes', ...B }).data;
const lane = list.find(l => l.id === 'mine-1');
t('plate and driver name are stamped from the ACCOUNT, not the request', lane.vehicle === 'KA01AA1111' && lane.driver === 'A', lane);
t('other users do NOT see the phone number or owner', !('phone' in lane) && !('ownerPhone' in lane), lane);
t('other users get coarse coordinates (3 dp) and own=false', lane.lat === 12.972 && lane.lng === 77.595 && lane.own === false, lane);
list = call({ action: 'listLanes', ...A }).data;
t('owner sees exact coordinates and own=true', list[0].lat === 12.971599 && list[0].own === true, list[0]);
t('anonymous listing works and shows own=false', call({ action: 'listLanes' }).data[0].own === false);
t('B cannot delete A\'s lane', call({ action: 'removeLane', ...B, id: 'mine-1' }).error === 'forbidden');
t('B cannot update A\'s lane', call({ action: 'updateLane', ...B, id: 'mine-1', row: { to: 'Hacked' } }).error === 'forbidden');
t('A can update own lane', call({ action: 'updateLane', ...A, id: 'mine-1', row: { to: 'Airport', total: 4, taken: 2 } }).data.ok === true);
t('anonymous cannot delete', call({ action: 'removeLane', id: 'mine-1' }).error === 'unauthorized');
t('A can delete own lane', call({ action: 'removeLane', ...A, id: 'mine-1' }).data.ok === true);

console.log('\nHive');
r = call({ action: 'insertHive', ...A, row: { id: 'hive-1', title: 'Hi', text: '=HYPERLINK("http://evil","x")', tags: 'a|b' } });
t('post created', r.data && r.data.ok, r);
t('cells are written as plain text (formula injection blocked)', formats.has('@'));
const post = call({ action: 'listHive', ...B }).data.find(p => p.id === 'hive-1');
t('post exposes no phone', !('phone' in post) && !('ownerPhone' in post), post);
t('B can like once', call({ action: 'like', ...B, id: 'hive-1', delta: 1000 }).data.likes === 1);
t('B liking again does not inflate (delta is ignored beyond sign)', call({ action: 'like', ...B, id: 'hive-1', delta: 1000 }).data.likes === 1);
t('B unlike works', call({ action: 'like', ...B, id: 'hive-1', delta: -1 }).data.likes === 0);
t('B cannot edit A\'s post', call({ action: 'updateHive', ...B, id: 'hive-1', row: { text: 'x' } }).error === 'forbidden');
t('B cannot delete A\'s post', call({ action: 'deleteHive', ...B, id: 'hive-1' }).error === 'forbidden');
t('A can delete own post', call({ action: 'deleteHive', ...A, id: 'hive-1' }).data.ok === true);

console.log('\nMessages');
const room = 'dm-KA01AA1111-KA02BB2222';
t('A sends to a DM room they belong to', call({ action: 'sendMessage', ...A, row: { roomId: room, text: 'hello', sender: 'IMPERSONATOR', from: 'KA99ZZ9999' } }).data.ok === true);
let msgs = call({ action: 'getMessages', ...B, roomId: room }).data;
t('B can read it; sender/plate are stamped by the server', msgs.length === 1 && msgs[0].sender === 'A' && msgs[0].from === 'KA01AA1111', msgs);
t('C (not a participant) cannot READ the DM', call({ action: 'getMessages', ...C, roomId: room }).error === 'forbidden');
t('C cannot WRITE into the DM', call({ action: 'sendMessage', ...C, row: { roomId: room, text: 'boo' } }).error === 'forbidden');
t('legacy lane-id rooms are refused', call({ action: 'getMessages', ...A, roomId: 'mine-123' }).error === 'bad_room');
t('local neighbourhood room works for any signed-in user', call({ action: 'sendMessage', ...C, row: { roomId: 'local-tdr1ab', text: 'hi all' } }).data.ok === true);
for (let i = 0; i < 40; i++) call({ action: 'sendMessage', ...A, row: { roomId: room, text: 'spam' + i } });
t('message flooding is rate limited', call({ action: 'sendMessage', ...A, row: { roomId: room, text: 'more' } }).error === 'rate_limited');

console.log('\nPresence, images, sessions');
r = call({ action: 'updatePresence', ...A, row: { vehicle: 'KA99ZZ9999', phone: '1', lat: 12.9716123456, lng: 77.5946123456, peerId: 'steeradar-veh-KA01AA1111' } });
t('presence is stamped with the account plate', r.data.ok);
const act = call({ action: 'activeVehicles', ...B }).data;
t('presence list hides phone numbers and shows the real plate', act.length === 1 && act[0].vehicle === 'KA01AA1111' && !('phone' in act[0]), act);
t('upload without sign-in is refused', call({ action: 'uploadImage', base64: 'data:image/jpeg;base64,AAAA', folder: 'users/avatar' }).error === 'unauthorized');
t('non-JPEG upload is refused', call({ action: 'uploadImage', ...A, base64: 'data:text/html;base64,PHNjcmlwdD4=', folder: 'users/avatar' }).error === 'bad_image');
t('unknown photo slot is refused', call({ action: 'uploadImage', ...A, base64: 'data:image/jpeg;base64,/9j/4AAQ', folder: 'users/../../x' }).error === 'bad_slot');
r = call({ action: 'uploadImage', ...A, base64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', folder: 'users/platePhoto' });
t('valid JPEG upload returns a file id and NO public url', r.data && r.data.fileId && r.data.url === '', r);
t('B cannot delete A\'s image', call({ action: 'deleteImage', ...B, fileId: r.data.fileId }).error === 'forbidden');
t('B cannot attach A\'s image id to their profile', (() => { call({ action: 'updateMe', ...B, platePhotoId: r.data.fileId }); return call({ action: 'getMe', ...B }).data.user.platePhotoId === ''; })());
t('A can attach and delete own image', call({ action: 'updateMe', ...A, platePhotoId: r.data.fileId }).data.user.platePhotoId === r.data.fileId && call({ action: 'deleteImage', ...A, fileId: r.data.fileId }).data.ok === true);
t('vehicle change to a plate owned by someone else is refused', call({ action: 'updateMe', ...A, vehicle: 'KA02BB2222' }).data.error === 'vehicle_taken');
t('logout invalidates the token', (() => { call({ action: 'logout', ...C }); return call({ action: 'getMe', ...C }).error === 'unauthorized'; })());
clock += 91 * 24 * 3600 * 1000;
t('sessions expire after 90 days', call({ action: 'getMe', ...A }).error === 'unauthorized');
t('cleanup runs without error', (() => { try { makeEnv().ctx.__api.cleanup(); return true; } catch (e) { console.log(e); return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
