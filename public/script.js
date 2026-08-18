const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const results = document.getElementById('results');

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
