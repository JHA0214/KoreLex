const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const results = document.getElementById('results');

const authLocked = document.getElementById('auth-locked');
const authUnlocked = document.getElementById('auth-unlocked');
const authToggle = document.getElementById('auth-toggle');
const authForm = document.getElementById('auth-form');
const authPassword = document.getElementById('auth-password');
const authMessage = document.getElementById('auth-message');
const authLogout = document.getElementById('auth-logout');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderChip(word, type, isAi) {
  const cls = type === '한자어' ? 'hanja' : 'other';
  const aiCls = isAi ? ' ai' : '';
  const hanjaPart = word.hanja ? `<span class="hanja-char">${escapeHtml(word.hanja)}</span>` : '';
  return `<span class="chip ${cls}${aiCls}">${escapeHtml(word.word)}${hanjaPart}</span>`;
}

function renderCard(item) {
  const hanjaChips = item.hanjaWords.map((w) => renderChip(w, '한자어')).join('');
  const otherChips = item.otherWords.map((w) => renderChip(w, '기타')).join('');
  const aiChips = (item.aiWords || []).map((w) => renderChip(w, w.hanja ? '한자어' : '기타', true)).join('');

  const hanjaSection = item.hanjaWords.length
    ? `<div class="word-group-label">한자어</div><div class="chip-row">${hanjaChips}</div>`
    : '';
  const otherSection = item.otherWords.length
    ? `<div class="word-group-label">다른 단어</div><div class="chip-row">${otherChips}</div>`
    : '';
  const aiSection = (item.aiWords || []).length
    ? `<div class="word-group-label ai-label">AI 추천 (사전으로 검증됨)</div><div class="chip-row">${aiChips}</div>`
    : '';

  const matchedHanja = item.matchedHanja
    ? `<span class="hanja-char">${escapeHtml(item.matchedHanja)}</span>`
    : '';

  return `
    <div class="result-card">
      <p class="matched-word">${escapeHtml(item.matchedWord)}${matchedHanja}</p>
      <p class="meaning">${escapeHtml(item.meaning)}</p>
      ${hanjaSection}
      ${otherSection}
      ${aiSection}
    </div>
  `;
}

function render(data) {
  if (!data.query) {
    results.innerHTML = '';
    return;
  }

  if (data.exact.length > 0) {
    results.innerHTML = data.exact.map(renderCard).join('');
    return;
  }

  if (data.partial.length > 0) {
    const notice = `<p class="notice partial-flag">'${escapeHtml(data.query)}'와(과) 정확히 일치하는 단어는 없어요. 비슷한 단어를 찾았어요.</p>`;
    results.innerHTML = notice + data.partial.map(renderCard).join('');
    return;
  }

  results.innerHTML = `<p class="empty-state">'${escapeHtml(data.query)}'에 대한 검색 결과가 없어요.</p>`;
}

async function search(word) {
  results.innerHTML = `<p class="notice">검색 중...</p>`;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(word)}`);
    const data = await res.json();
    if (!res.ok) {
      results.innerHTML = `<p class="empty-state">${escapeHtml(data.error || '검색에 실패했어요.')}</p>`;
      return;
    }
    render(data);
  } catch (err) {
    results.innerHTML = `<p class="empty-state">서버에 연결할 수 없어요.</p>`;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const word = input.value.trim();
  if (word) search(word);
});

function setAuthState(unlocked) {
  authLocked.classList.toggle('hidden', unlocked);
  authUnlocked.classList.toggle('hidden', !unlocked);
  if (!unlocked) {
    authForm.classList.add('hidden');
    authMessage.textContent = '';
    authPassword.value = '';
  }
}

authToggle.addEventListener('click', () => {
  authForm.classList.toggle('hidden');
  if (!authForm.classList.contains('hidden')) authPassword.focus();
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authMessage.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: authPassword.value })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      setAuthState(true);
    } else {
      authMessage.textContent = data.error || '비밀번호가 올바르지 않습니다.';
    }
  } catch {
    authMessage.textContent = '서버에 연결할 수 없어요.';
  }
});

authLogout.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // 네트워크 오류여도 화면은 잠금 상태로 되돌린다.
  }
  setAuthState(false);
});

fetch('/api/auth/status')
  .then((res) => res.json())
  .then((data) => setAuthState(!!data.unlocked))
  .catch(() => setAuthState(false));

// --- 홈 화면에 설치(PWA) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 서비스 워커 등록 실패는 앱 사용에 지장이 없으므로 조용히 무시한다.
    });
  });
}

const installButton = document.getElementById('install-button');
const iosInstallHint = document.getElementById('ios-install-hint');
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installButton.classList.remove('hidden');
});

installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  installButton.classList.add('hidden');
  iosInstallHint.classList.add('hidden');
});

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
if (isIos && !isStandalone) {
  iosInstallHint.classList.remove('hidden');
}
