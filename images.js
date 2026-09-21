// 업로드 사진 준비: 목록용 작은 썸네일 + 대결 화면용 고화질 원본.
// 고화질은 Firestore 문서 1MB 한도 안에 들어가야 한다(base64라 원본보다 약 1.33배 커짐).

const THUMB_MAX = 360;          // 목록·순위 화면의 작은 사진 (긴 변 px)
const THUMB_Q = 0.8;
const FULL_MAX = 2048;          // 원본이 크면 이 크기까지만 줄임
const FULL_Q = 0.92;
export const FULL_LIMIT = 950000; // base64 글자 수 상한 (보안 규칙의 1,000,000보다 약간 작게)
const KEEP_AS_IS = /^image\/(jpeg|png|webp|gif)$/;

function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('이미지를 읽을 수 없어요'));
    i.src = url;
  });
}

function encode(img, max, q) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; // 투명 PNG가 JPEG로 바뀔 때 검게 되지 않도록
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', q);
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('파일을 읽을 수 없어요'));
    r.readAsDataURL(file);
  });
}

export async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const thumb = encode(img, THUMB_MAX, THUMB_Q);

    // 한도 안에 들어가는 사진은 한 픽셀도 건드리지 않고 원본 그대로 저장
    if (KEEP_AS_IS.test(file.type) && Math.ceil(file.size / 3) * 4 + 40 < FULL_LIMIT) {
      return { thumb, full: await readAsDataURL(file), original: true };
    }
    // 큰 사진: 고품질을 유지하며 한도에 맞을 때까지 조금씩 줄임
    let max = FULL_MAX, q = FULL_Q;
    let full = encode(img, max, q);
    while (full.length > FULL_LIMIT && max > 600) {
      if (q > 0.86) q = 0.86;
      else max = Math.round(max * 0.85);
      full = encode(img, max, q);
    }
    return { thumb, full, original: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}
