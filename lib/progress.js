'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '.kt-progress.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { lessons: {}, current: null, startedAt: Date.now(), ...raw };
  } catch {
    return { lessons: {}, current: null, startedAt: Date.now() };
  }
}
function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n');
}
function isDone(state, id) { return !!state.lessons[id]?.passed; }
function markPass(state, id, detail) {
  const prev = state.lessons[id] || { attempts: 0 };
  state.lessons[id] = {
    ...prev, passed: true, passedAt: new Date().toISOString(),
    lastDetail: detail || '', attempts: (prev.attempts || 0) + 1,
  };
  save(state);
}
function markAttempt(state, id, detail) {
  const prev = state.lessons[id] || {};
  state.lessons[id] = { ...prev, passed: !!prev.passed, attempts: (prev.attempts || 0) + 1, lastDetail: detail || '' };
  save(state);
}
function setCurrent(state, id) { state.current = id; save(state); }
function clear() { try { fs.unlinkSync(FILE); } catch {} }
function count(state, ids) { return ids.filter(id => isDone(state, id)).length; }

module.exports = { load, save, isDone, markPass, markAttempt, setCurrent, clear, count };
