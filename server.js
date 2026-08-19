require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const STDICT_API_KEY = process.env.STDICT_API_KEY;
const SEARCH_URL = 'https://stdict.korean.go.kr/api/search.do';
const VIEW_URL = 'https://stdict.korean.go.kr/api/view.do';

// --- AI 기능 잠금 해제(비밀번호) 설정 ---
// 일반 사용자는 사전 검색만 가능하고, 이 비밀번호를 맞춘 사용자만
// 브라우저 쿠키에 서버 발급 토큰이 저장되어 AI 보완 검색이 함께 열린다.
// 실제 비밀번호 값은 .env(git에 올라가지 않음)에만 두고, 소스코드에는 절대 하드코딩하지 않는다.
const APP_PASSWORD = process.env.APP_PASSWORD || null;
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD가 설정되지 않아 AI 잠금 해제 기능이 비활성화됩니다.');
}
const AUTH_COOKIE = 'korelex_auth';
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일
const validTokens = new Map(); // token -> 만료 시각(ms)

function issueAuthToken() {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, Date.now() + AUTH_TOKEN_TTL_MS);
  return token;
}

function isAuthTokenValid(token) {
  if (!token) return false;
  const expiresAt = validTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    validTokens.delete(token);
    return false;
  }
  return true;
}

const SYNONYM_TYPES = new Set(['동의어', '비슷한말', '유의어']);
const MAX_HOMOGRAPHS = 15;
const MAX_PARTIAL_WORDS = 8;

// --- AI(Claude) 보완 검색 설정 ---
// 표준국어대사전에 공식 등록된 동의어가 하나도 없는 뜻풀이에 한해서만
// Claude에게 관련 단어 후보를 물어보고, 반드시 표준국어대사전으로 재검증한 뒤에만 노출한다.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const AI_MODEL = 'claude-haiku-4-5';
const AI_INPUT_PRICE_PER_M = 1.0; // $/1M input tokens
const AI_OUTPUT_PRICE_PER_M = 5.0; // $/1M output tokens
const DAILY_AI_BUDGET_USD = parseFloat(process.env.DAILY_AI_BUDGET_USD || '1.0');
const MAX_AI_ENRICH_CARDS = 3; // 한 번의 검색 요청에서 AI로 보완할 최대 카드 수
const MAX_AI_CANDIDATES = 4; // 카드 하나당 요청할 최대 후보 단어 수
const USAGE_FILE = path.join(__dirname, '.usage.json');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadUsage() {
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    if (data.date === todayKey()) return data;
  } catch {
    // 파일이 없거나 오늘 날짜가 아니면 새로 시작
  }
  return { date: todayKey(), costUSD: 0 };
}

function addUsageCost(inputTokens, outputTokens) {
  const usage = loadUsage();
  usage.costUSD += (inputTokens / 1e6) * AI_INPUT_PRICE_PER_M + (outputTokens / 1e6) * AI_OUTPUT_PRICE_PER_M;
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (err) {
    console.error('AI 사용량 기록 실패:', err.message);
  }
  return usage.costUSD;
}

function isDailyBudgetExceeded() {
  return loadUsage().costUSD >= DAILY_AI_BUDGET_USD;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (name) => ['item', 'comm_pattern_info', 'pos_info', 'sense_info', 'lexical_info'].includes(name)
});

function stripHomographNumber(word) {
  return (word || '').replace(/\d+$/, '');
}

function cleanWord(word) {
  return stripHomographNumber(word).replace(/-/g, '');
}

async function callSearch(word, method) {
  if (!STDICT_API_KEY) throw new Error('MISSING_API_KEY');
  const url = `${SEARCH_URL}?key=${encodeURIComponent(STDICT_API_KEY)}&q=${encodeURIComponent(
    word
  )}&req_type=json&method=${method}&num=30`;

  const res = await fetch(url);
  const text = await res.text();
  if (!text) return [];

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (data.error) throw new Error(`STDICT_ERROR:${data.error.error_code}:${data.error.message}`);

  const channel = data.channel;
  if (!channel || !channel.item) return [];
  return Array.isArray(channel.item) ? channel.item : [channel.item];
}

async function fetchWordDetail(targetCode) {
  if (!STDICT_API_KEY) throw new Error('MISSING_API_KEY');
  const url = `${VIEW_URL}?key=${encodeURIComponent(STDICT_API_KEY)}&method=target_code&q=${encodeURIComponent(
    targetCode
  )}`;

  const res = await fetch(url);
  const xml = await res.text();
  if (!xml || xml.includes('<error>')) return null;

  const parsed = xmlParser.parse(xml);
  const item = parsed?.channel?.item?.[0];
  const wordInfo = item?.word_info;
  if (!wordInfo) return null;

  const hanja = wordInfo.original_language_info?.language_type === '한자'
    ? wordInfo.original_language_info.original_language
    : null;

  const posInfoList = wordInfo.pos_info || [];
  const senses = [];

  for (const posInfo of posInfoList) {
    for (const pattern of posInfo.comm_pattern_info || []) {
      for (const senseInfo of pattern.sense_info || []) {
        const synonyms = (senseInfo.lexical_info || [])
          .filter((rel) => SYNONYM_TYPES.has(rel.type))
          .map((rel) => {
            // link_target_code is actually a sense_code, not a word target_code.
            // The real word identifier (target_code) is the word_no in the link URL.
            const match = String(rel.link || '').match(/word_no=(\d+)/);
            return { word: cleanWord(rel.word), targetCode: match ? match[1] : null };
          });

        senses.push({
          pos: posInfo.pos,
          cat: senseInfo.cat_info?.cat || null,
          definition: senseInfo.definition,
          synonyms
        });
      }
    }
  }

  return { word: cleanWord(wordInfo.word), hanja, senses };
}

async function buildCards(targetCodes, searchedWordDisplay) {
  const cache = new Map();

  async function getDetail(targetCode) {
    if (!cache.has(targetCode)) {
      cache.set(targetCode, fetchWordDetail(targetCode));
    }
    return cache.get(targetCode);
  }

  const details = await Promise.all(targetCodes.map((tc) => getDetail(tc)));
  const cards = [];

  for (const detail of details) {
    if (!detail) continue;

    for (const sense of detail.senses) {
      const uniqueSynTargetCodes = [...new Set(sense.synonyms.map((s) => s.targetCode).filter(Boolean))];
      const synDetails = await Promise.all(uniqueSynTargetCodes.map((tc) => getDetail(tc)));
      const hanjaByTargetCode = new Map();
      uniqueSynTargetCodes.forEach((tc, i) => {
        if (synDetails[i]) hanjaByTargetCode.set(tc, synDetails[i].hanja);
      });

      const seenWords = new Set([detail.word]);
      const hanjaWords = [];
      const otherWords = [];

      for (const syn of sense.synonyms) {
        if (seenWords.has(syn.word)) continue;
        seenWords.add(syn.word);
        const hanja = hanjaByTargetCode.get(syn.targetCode) || null;
        const entry = { word: syn.word, hanja, type: hanja ? '한자어' : '고유어' };
        (hanja ? hanjaWords : otherWords).push(entry);
      }

      cards.push({
        meaning: sense.cat ? `[${sense.cat}] ${sense.definition}` : sense.definition,
        matchedWord: searchedWordDisplay,
        matchedHanja: detail.hanja,
        hanjaWords,
        otherWords
      });
    }
  }

  return cards;
}

async function fetchAiCandidates(word, meaning) {
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 200,
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            candidates: { type: 'array', items: { type: 'string' } }
          },
          required: ['candidates'],
          additionalProperties: false
        }
      }
    },
    messages: [
      {
        role: 'user',
        content: `단어: ${word}\n뜻풀이: ${meaning}\n\n이 단어와 의미가 같거나 아주 비슷한 다른 한국어 표준어를 최대 4개까지 제안해줘. 실제로 존재하는 단어만, 이 단어 자체와 똑같은 단어는 제외하고 답해줘.`
      }
    ]
  });

  if (response.usage) {
    addUsageCost(response.usage.input_tokens, response.usage.output_tokens);
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) return [];
  try {
    const parsed = JSON.parse(textBlock.text);
    return (parsed.candidates || []).slice(0, MAX_AI_CANDIDATES);
  } catch {
    return [];
  }
}

async function verifyAiCandidate(candidateWord, excludeWords) {
  const stripped = stripHomographNumber(candidateWord).trim();
  if (!stripped || excludeWords.has(stripped)) return null;

  try {
    const items = await callSearch(stripped, 'exact');
    const match = items.find((item) => stripHomographNumber(item.word) === stripped);
    if (!match) return null;

    const detail = await fetchWordDetail(match.target_code);
    if (!detail || excludeWords.has(detail.word)) return null;

    return { word: detail.word, hanja: detail.hanja, type: detail.hanja ? '한자어' : '고유어' };
  } catch {
    return null;
  }
}

async function enrichCardWithAi(card) {
  let candidates;
  try {
    candidates = await fetchAiCandidates(card.matchedWord, card.meaning);
  } catch (err) {
    console.error('AI 후보 조회 실패:', err.message);
    return card;
  }
  if (candidates.length === 0) return card;

  const excludeWords = new Set([card.matchedWord]);
  const verified = await Promise.all(candidates.map((c) => verifyAiCandidate(c, excludeWords)));

  const seen = new Set();
  const aiWords = verified.filter((w) => {
    if (!w || seen.has(w.word)) return false;
    seen.add(w.word);
    return true;
  });

  return aiWords.length > 0 ? { ...card, aiWords } : card;
}

async function enrichCardsWithAi(cards) {
  if (!anthropic || isDailyBudgetExceeded()) return cards;

  const needsEnrichIdx = cards
    .map((card, i) => (card.hanjaWords.length + card.otherWords.length === 0 ? i : -1))
    .filter((i) => i !== -1)
    .slice(0, MAX_AI_ENRICH_CARDS);

  await Promise.all(
    needsEnrichIdx.map(async (i) => {
      cards[i] = await enrichCardWithAi(cards[i]);
    })
  );

  return cards;
}

async function search(query, aiUnlocked) {
  const q = query.trim();
  if (!q) return { query: q, exact: [], partial: [] };

  const stripped = stripHomographNumber(q);
  const exactItems = await callSearch(q, 'exact');
  const exactTargetCodes = exactItems
    .filter((item) => stripHomographNumber(item.word) === stripped)
    .slice(0, MAX_HOMOGRAPHS)
    .map((item) => item.target_code);

  if (exactTargetCodes.length > 0) {
    let exact = await buildCards(exactTargetCodes, stripped);
    if (aiUnlocked) exact = await enrichCardsWithAi(exact);
    return { query: q, exact, partial: [] };
  }

  const includeItems = await callSearch(q, 'include');
  const seenWords = new Set();
  const partialTargetCodes = [];
  const partialWords = new Map();

  for (const item of includeItems) {
    const word = stripHomographNumber(item.word);
    if (seenWords.has(word)) continue;
    if (seenWords.size >= MAX_PARTIAL_WORDS) break;
    seenWords.add(word);
    partialTargetCodes.push(item.target_code);
    partialWords.set(item.target_code, word);
  }

  const partial = [];
  for (const tc of partialTargetCodes) {
    partial.push(...(await buildCards([tc], partialWords.get(tc))));
  }

  return { query: q, exact: [], partial };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) {
    return res.status(503).json({ success: false, error: 'AI 잠금 해제 기능이 서버에 설정되어 있지 않습니다.' });
  }
  const { password } = req.body || {};
  if (password !== APP_PASSWORD) {
    return res.status(401).json({ success: false, error: '비밀번호가 올바르지 않습니다.' });
  }
  const token = issueAuthToken();
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: AUTH_TOKEN_TTL_MS
  });
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.[AUTH_COOKIE];
  if (token) validTokens.delete(token);
  res.clearCookie(AUTH_COOKIE);
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ unlocked: isAuthTokenValid(req.cookies?.[AUTH_COOKIE]) });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  const aiUnlocked = isAuthTokenValid(req.cookies?.[AUTH_COOKIE]);
  try {
    const result = await search(q, aiUnlocked);
    res.json(result);
  } catch (err) {
    if (err.message === 'MISSING_API_KEY') {
      res.status(500).json({ error: '서버에 STDICT_API_KEY가 설정되어 있지 않습니다.' });
    } else {
      console.error(err);
      res.status(502).json({ error: '사전 API 요청에 실패했습니다.', detail: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`KoreLex server running at http://localhost:${PORT}`);
});
