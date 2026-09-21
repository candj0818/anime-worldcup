// 저장소 어댑터: Firebase(모두 공유) 또는 localStorage(체험 모드).
// 두 구현 모두 같은 메서드를 제공한다.
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function createStore() {
  // 주소 끝에 ?demo 를 붙이면 실제 데이터와 무관한 체험 모드로 열린다
  if (new URLSearchParams(location.search).has('demo')) return localStore();
  if (firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId) {
    return firebaseStore(firebaseConfig);
  }
  return localStore();
}

async function firebaseStore(cfg) {
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const { getAuth, signInAnonymously } = await import(FB + 'firebase-auth.js');
  const fs = await import(FB + 'firebase-firestore.js');

  const app = initializeApp(cfg);
  // 익명 인증: 참여자에게는 아무 화면도 보이지 않는다. 본인이 올린 사진만 지울 수 있게 하는 용도.
  const { user } = await signInAnonymously(getAuth(app));
  const db = fs.getFirestore(app);
  const col = name => fs.collection(db, name);

  return {
    mode: 'online',
    uid: user.uid,
    async listCharacters() {
      const snap = await fs.getDocs(fs.query(col('characters'), fs.orderBy('createdAt', 'asc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    // 목록용 썸네일은 characters, 고화질은 images 에 같은 id로 한 번에 저장
    async addCharacter({ name, img, full }) {
      const ref = fs.doc(col('characters'));
      const batch = fs.writeBatch(db);
      batch.set(ref, { name, img, uid: user.uid, createdAt: fs.serverTimestamp() });
      if (full) batch.set(fs.doc(db, 'images', ref.id), { data: full, uid: user.uid });
      await batch.commit();
      return ref.id;
    },
    async getFull(id) {
      const snap = await fs.getDoc(fs.doc(db, 'images', id));
      return snap.exists() ? snap.data().data : null;
    },
    async deleteCharacter(id) {
      const batch = fs.writeBatch(db);
      batch.delete(fs.doc(db, 'characters', id));
      batch.delete(fs.doc(db, 'images', id));
      await batch.commit();
    },
    async addResult(result) {
      await fs.addDoc(col('results'), { ...result, uid: user.uid, createdAt: fs.serverTimestamp() });
    },
    // 순위 초기화 이후의 결과만 센다 (예전 기록은 지우지 않고 숨김)
    async listResults() {
      let resetAt = null;
      try {
        const meta = await fs.getDoc(fs.doc(db, 'meta', 'ranking'));
        if (meta.exists()) resetAt = meta.data().resetAt;
      } catch { /* 새 보안 규칙을 아직 게시 안 했으면 초기화 없이 전체를 센다 */ }
      const q = resetAt ? fs.query(col('results'), fs.where('createdAt', '>', resetAt)) : col('results');
      const snap = await fs.getDocs(q);
      return snap.docs.map(d => d.data());
    },
    // 비밀번호 확인은 보안 규칙이 한다(코드에는 비밀번호가 없음). 틀리면 permission-denied.
    async resetRanking(pw) {
      const log = fs.doc(col('adminlog'));
      const batch = fs.writeBatch(db);
      batch.set(log, { pw, at: fs.serverTimestamp(), uid: user.uid });
      batch.set(fs.doc(db, 'meta', 'ranking'), { resetAt: fs.serverTimestamp(), logId: log.id });
      await batch.commit();
    }
  };
}

function localStore() {
  const CHARS = 'wc_local_chars', RESULTS = 'wc_local_results', FULL = 'wc_local_full_';
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
  const write = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch { throw new Error('브라우저 저장 공간이 가득 찼어요 (체험 모드 한계)'); }
  };
  let uid;
  try {
    uid = localStorage.getItem('wc_uid');
    if (!uid) { uid = 'local-' + Math.random().toString(36).slice(2); localStorage.setItem('wc_uid', uid); }
  } catch { uid = 'local-anon'; }
  const dropFull = ids => ids.forEach(id => { try { localStorage.removeItem(FULL + id); } catch { /* 무시 */ } });

  return {
    mode: 'local',
    uid,
    async listCharacters() { return read(CHARS); },
    async addCharacter({ name, img, full }) {
      const list = read(CHARS);
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (full) {
        try { localStorage.setItem(FULL + id, full); }
        catch { throw new Error('브라우저 저장 공간이 가득 찼어요 (체험 모드 한계)'); }
      }
      list.push({ id, name, img, uid, createdAt: Date.now() });
      write(CHARS, list);
      return id;
    },
    async getFull(id) { try { return localStorage.getItem(FULL + id); } catch { return null; } },
    async deleteCharacter(id) { dropFull([id]); write(CHARS, read(CHARS).filter(c => c.id !== id)); },
    async addResult(result) { const r = read(RESULTS); r.push({ ...result, uid }); write(RESULTS, r); },
    async listResults() { return read(RESULTS); },
    async resetRanking() { write(RESULTS, []); },

    // 아래는 체험 모드 테스트 도구 전용
    async replaceCharacters(list) {
      dropFull(read(CHARS).map(c => c.id));
      const t = Date.now();
      write(CHARS, list.map((c, i) => ({ id: 'f' + i.toString(36) + t.toString(36), ...c, uid, createdAt: t + i })));
      write(RESULTS, []);
    },
    async addResults(list) { write(RESULTS, [...read(RESULTS), ...list.map(r => ({ ...r, uid: 'fake' }))]); },
    async clearAll() { dropFull(read(CHARS).map(c => c.id)); write(CHARS, []); write(RESULTS, []); }
  };
}
