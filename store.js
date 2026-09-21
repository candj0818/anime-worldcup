// 저장소 어댑터: Firebase(모두 공유) 또는 localStorage(체험 모드).
// 두 구현 모두 같은 메서드를 제공한다.
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function createStore() {
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
    async addCharacter({ name, img }) {
      const ref = await fs.addDoc(col('characters'), {
        name, img, uid: user.uid, createdAt: fs.serverTimestamp()
      });
      return ref.id;
    },
    async deleteCharacter(id) {
      await fs.deleteDoc(fs.doc(db, 'characters', id));
    },
    async addResult(result) {
      await fs.addDoc(col('results'), { ...result, uid: user.uid, createdAt: fs.serverTimestamp() });
    },
    async listResults() {
      const snap = await fs.getDocs(col('results'));
      return snap.docs.map(d => d.data());
    }
  };
}

function localStore() {
  const CHARS = 'wc_local_chars', RESULTS = 'wc_local_results';
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

  return {
    mode: 'local',
    uid,
    async listCharacters() { return read(CHARS); },
    async addCharacter({ name, img }) {
      const list = read(CHARS);
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      list.push({ id, name, img, uid, createdAt: Date.now() });
      write(CHARS, list);
      return id;
    },
    async deleteCharacter(id) { write(CHARS, read(CHARS).filter(c => c.id !== id)); },
    async addResult(result) { const r = read(RESULTS); r.push({ ...result, uid }); write(RESULTS, r); },
    async listResults() { return read(RESULTS); },

    // 아래는 체험 모드 테스트 도구 전용
    async replaceCharacters(list) {
      const t = Date.now();
      write(CHARS, list.map((c, i) => ({ id: 'f' + i.toString(36) + t.toString(36), ...c, uid, createdAt: t + i })));
      write(RESULTS, []);
    },
    async addResults(list) { write(RESULTS, [...read(RESULTS), ...list.map(r => ({ ...r, uid: 'fake' }))]); },
    async clearAll() { write(CHARS, []); write(RESULTS, []); }
  };
}
