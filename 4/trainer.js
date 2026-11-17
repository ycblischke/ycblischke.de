// Trainer für „4 in einer Reihe“: perfekter Löser (Bitboard-Negamax wie in der App VierMeister)
// + Eröffnungsbuch. Läuft als Web Worker, damit die Seite nicht hängt.
// Bitboard 7 Spalten × 7 Bit (6 Felder + 1 Wächterbit) = 49 Bit, aufgeteilt in
// L = Bits 0–27 (Spalten 0–3) und H = Bits 28–48 (Spalten 4–6), weil JS-Bitoperationen nur 32 Bit können.
'use strict';
const W = 7, Hh = 6, CELLS = 42, M28 = 0xFFFFFFF, M21 = 0x1FFFFF;
const MIN_SCORE = -CELLS / 2 + 3, MAX_SCORE = (CELLS + 1) / 2 - 3 | 0;
const ORDER = [3, 2, 4, 1, 5, 0, 6];
let BOTL = 0, BOTH = 0, BOARDL = 0, BOARDH = 0;
const COLL = [], COLH = [];
for (let c = 0; c < W; c++) {
  const b = c * 7;
  if (b < 28) { BOTL |= 1 << b; BOARDL |= 0x3F << b; COLL[c] = 0x3F << b; COLH[c] = 0; }
  else { BOTH |= 1 << (b - 28); BOARDH |= 0x3F << (b - 28); COLL[c] = 0; COLH[c] = 0x3F << (b - 28); }
}
const shlL = (h, l, d) => (l << d) & M28;
const shlH = (h, l, d) => ((h << d) | (l >>> (28 - d))) & M21;
const shrL = (h, l, d) => ((l >>> d) | (h << (28 - d))) & M28;
const shrH = (h, l, d) => h >>> d;
function pop(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

let WH = 0, WL = 0; // Ergebnis von winning()
function winning(pH, pL, mH, mL) {
  let rL = shlL(pH, pL, 1) & shlL(pH, pL, 2) & shlL(pH, pL, 3);
  let rH = shlH(pH, pL, 1) & shlH(pH, pL, 2) & shlH(pH, pL, 3);
  for (const d of [7, 6, 8]) {
    let aL = shlL(pH, pL, d) & shlL(pH, pL, 2 * d), aH = shlH(pH, pL, d) & shlH(pH, pL, 2 * d);
    rL |= (aL & shlL(pH, pL, 3 * d)) | (aL & shrL(pH, pL, d));
    rH |= (aH & shlH(pH, pL, 3 * d)) | (aH & shrH(pH, pL, d));
    aL = shrL(pH, pL, d) & shrL(pH, pL, 2 * d); aH = shrH(pH, pL, d) & shrH(pH, pL, 2 * d);
    rL |= (aL & shlL(pH, pL, d)) | (aL & shrL(pH, pL, 3 * d));
    rH |= (aH & shlH(pH, pL, d)) | (aH & shrH(pH, pL, 3 * d));
  }
  WL = rL & (BOARDL ^ mL); WH = rH & (BOARDH ^ mH);
}
const possL = mL => (mL + BOTL) & BOARDL;
const possH = mH => (mH + BOTH) & BOARDH;

// Transpositionstabelle (wie in der App: ungerade Größe, untere 32 Bit als Schlüssel)
const SIZE = (1 << 22) + 1;
const TK = new Uint32Array(SIZE), TV = new Int8Array(SIZE);
const keyOf = (cH, cL, mH, mL) => (cH + mH) * 268435456 + (cL + mL);
const low32 = (cH, cL, mH, mL) => (((cL + mL) | ((cH + mH) << 28)) >>> 0);
function ttPut(k, k32, v) { const i = k % SIZE; TK[i] = k32; TV[i] = v; }
function ttGet(k, k32) { const i = k % SIZE; return TK[i] === k32 ? TV[i] : 0; }

let deadline = Infinity, nodes = 0;
const TIMEOUT = { t: 1 };

let NLH = 0, NLL = 0;
function nonLosing(cH, cL, mH, mL) {
  let pmL = possL(mL), pmH = possH(mH);
  winning(cH ^ mH, cL ^ mL, mH, mL);
  const oL = WL, oH = WH;
  const fL = pmL & oL, fH = pmH & oH;
  if (fL | fH) {
    if (pop(fL) + pop(fH) > 1) { NLH = 0; NLL = 0; return; }
    pmL = fL; pmH = fH;
  }
  NLL = pmL & ~(((oL >>> 1) | (oH << 27)) & M28);
  NLH = pmH & ~(oH >>> 1);
}

function negamax(cH, cL, mH, mL, moves, alpha, beta) {
  if ((++nodes & 0x3FFF) === 0 && performance.now() > deadline) throw TIMEOUT;
  nonLosing(cH, cL, mH, mL);
  const nH = NLH, nL = NLL;
  if ((nH | nL) === 0) return -((CELLS - moves) / 2 | 0);
  if (moves >= CELLS - 2) return 0;
  const min = -((CELLS - 2 - moves) / 2 | 0);
  if (alpha < min) { alpha = min; if (alpha >= beta) return alpha; }
  let max = (CELLS - 1 - moves) / 2 | 0;
  const k = keyOf(cH, cL, mH, mL), k32 = low32(cH, cL, mH, mL);
  const v = ttGet(k, k32);
  if (v !== 0) {
    if (v > MAX_SCORE - MIN_SCORE + 1) { const lo = v + 2 * MIN_SCORE - MAX_SCORE - 2; if (alpha < lo) { alpha = lo; if (alpha >= beta) return alpha; } }
    else max = v + MIN_SCORE - 1;
  }
  if (beta > max) { beta = max; if (alpha >= beta) return beta; }
  // Züge sortieren: mehr eigene Drohungen zuerst, sonst Mitte zuerst
  const mvH = [], mvL = [], sc = []; let n = 0;
  for (let i = W - 1; i >= 0; i--) {
    const c = ORDER[i];
    const xL = nL & COLL[c], xH = nH & COLH[c];
    if (xL | xH) {
      winning(cH | xH, cL | xL, mH, mL);
      const s = pop(WL) + pop(WH);
      let j = n++;
      while (j > 0 && sc[j - 1] > s) { mvH[j] = mvH[j - 1]; mvL[j] = mvL[j - 1]; sc[j] = sc[j - 1]; j--; }
      mvH[j] = xH; mvL[j] = xL; sc[j] = s;
    }
  }
  for (let q = n - 1; q >= 0; q--) {
    const s = -negamax(cH ^ mH, cL ^ mL, mH | mvH[q], mL | mvL[q], moves + 1, -beta, -alpha);
    if (s >= beta) { ttPut(k, k32, s + MAX_SCORE - 2 * MIN_SCORE + 2); return s; }
    if (s > alpha) alpha = s;
  }
  ttPut(k, k32, alpha - MIN_SCORE + 1);
  return alpha;
}

// ---- Stellung aus Zugliste ----
function position(moves) {
  let cH = 0, cL = 0, mH = 0, mL = 0;
  for (const c of moves) {
    const xL = possL(mL) & COLL[c], xH = possH(mH) & COLH[c];
    cH ^= mH; cL ^= mL; mH |= xH; mL |= xL;
  }
  return { cH, cL, mH, mL, n: moves.length };
}
const canPlay = (p, c) => p.n < CELLS && (((possL(p.mL) & COLL[c]) | (possH(p.mH) & COLH[c])) !== 0);
function isWinningMove(p, c) { winning(p.cH, p.cL, p.mH, p.mL); return ((WL & possL(p.mL) & COLL[c]) | (WH & possH(p.mH) & COLH[c])) !== 0; }

/** 1 = Spieler am Zug gewinnt, 0 = Remis, -1 = verliert. Wirft TIMEOUT. */
function solveWeak(p, ms) {
  deadline = performance.now() + ms;
  winning(p.cH, p.cL, p.mH, p.mL);
  if ((WL & possL(p.mL)) | (WH & possH(p.mH))) return 1;
  return Math.sign(negamax(p.cH, p.cL, p.mH, p.mL, p.n, -1, 1));
}

// ---- Eröffnungsbuch ----
const book = new Map();
function loadBook(text) {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    const v = parseInt(parts[parts.length - 1], 10); if (isNaN(v) || line.trim() === '') continue;
    const hs = parts.length === 2 ? parts[0] : '';
    const mv = [...hs].map(ch => ch.charCodeAt(0) - 49);
    const a = position(mv), b = position(mv.map(c => 6 - c));
    book.set(keyOf(a.cH, a.cL, a.mH, a.mL), v); book.set(keyOf(b.cH, b.cL, b.mH, b.mL), v);
  }
}
const bookValue = p => book.get(keyOf(p.cH, p.cL, p.mH, p.mL));

/** Bewertet alle Spalten für den Spieler am Zug. Meldet Zwischenstände über post(). */
function analyse(moves, budgetMs, post) {
  const p = position(moves);
  const res = Array(W).fill(null);   // 'win' | 'draw' | 'lose' | 'wait' | '?' | null (voll)
  const open = [];
  for (let c = 0; c < W; c++) {
    if (!canPlay(p, c)) continue;
    if (isWinningMove(p, c)) { res[c] = 'win'; continue; }
    const ch = position(moves.concat(c));
    if (ch.n === CELLS) { res[c] = 'draw'; continue; }
    let oppWins = false;
    for (let d = 0; d < W && !oppWins; d++) if (canPlay(ch, d) && isWinningMove(ch, d)) oppWins = true;
    if (oppWins) { res[c] = 'lose'; continue; }
    const b = bookValue(ch);
    if (b !== undefined) { res[c] = b === 1 ? 'lose' : b === 0 ? 'draw' : 'win'; continue; }
    res[c] = 'wait'; open.push(c);
  }
  post(res.slice(), false);
  const end = performance.now() + budgetMs;
  const todo = ORDER.filter(c => open.includes(c));
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i], left = end - performance.now();
    if (left < 20) { res[c] = '?'; continue; }
    try {
      const r = -solveWeak(position(moves.concat(c)), left / (todo.length - i));
      res[c] = r > 0 ? 'win' : r < 0 ? 'lose' : 'draw';
    } catch (e) { if (e !== TIMEOUT) throw e; res[c] = '?'; }
    post(res.slice(), false);
  }
  for (let c = 0; c < W; c++) if (res[c] === 'wait') res[c] = '?';
  post(res, true);
}

// ---- Worker-Schnittstelle / Node-Test ----
if (typeof module !== 'undefined') module.exports = { analyse, solveWeak, position, loadBook, bookValue };
else self.onmessage = e => {
  const m = e.data;
  if (m.book) loadBook(m.book);
  if (m.moves) analyse(m.moves, m.budget || 8000, (res, done) => self.postMessage({ id: m.id, res, done }));
};
