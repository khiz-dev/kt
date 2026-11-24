'use strict';
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const esc = (code) => `\x1b[${code}m`;
const C = {
  reset: esc(0), bold: esc(1), dim: esc(2), italic: esc(3), underline: esc(4),
  red: esc(31), green: esc(32), yellow: esc(33), blue: esc(34),
  magenta: esc(35), cyan: esc(36), white: esc(37),
  bgRed: esc(41), bgGreen: esc(42), bgBlue: esc(44),
};
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function paint(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`)
    .replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);
}
function wrap(text, width = 92, indent = '') {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (strip(line + ' ' + w).length > width && line) { out.push(indent + line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}
function rule(char = '─', width = 76, color = C.dim) {
  console.log(color + char.repeat(width) + C.reset);
}
function box(title, lines, color = C.blue) {
  const width = 76;
  console.log(color + '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, width - title.length - 4)) + '┐' + C.reset);
  for (const line of lines) {
    const plain = strip(line);
    console.log(color + '│ ' + C.reset + line + ' '.repeat(Math.max(0, width - plain.length - 2)) + color + '│' + C.reset);
  }
  console.log(color + '└' + '─'.repeat(width) + '┘' + C.reset);
}
function command(cmd) {
  console.log(`\n${C.dim}  $ ${C.reset}${C.green}${cmd}${C.reset}\n`);
}

function readKey(promptText = '› ') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(promptText, ans => { rl.close(); resolve((ans || '').trim().toLowerCase()); });
      return;
    }
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      const s = buf.toString();
      let key;
      if (s === '\r' || s === '\n') key = 'enter';
      else if (s === '\u0003') { cleanup(); process.stdout.write('\n'); process.exit(0); }
      else if (s === '\u001b') key = 'esc';
      else key = s.toLowerCase();
      cleanup();
      process.stdout.write('\n');
      resolve(key);
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

async function select(title, options) {
  console.log(`\n${C.bold}${title}${C.reset}\n`);
  if (!process.stdin.isTTY) {
    options.forEach((o, i) => console.log(`  ${C.yellow}${i + 1}${C.reset}. ${typeof o === 'string' ? o : o.label}`));
    process.stdout.write(`\n${C.dim}Enter a number (q to quit): ${C.reset}`);
    const ans = await readKey('');
    if (ans === 'q') return -1;
    const n = parseInt(ans, 10) - 1;
    return n >= 0 && n < options.length ? n : -1;
  }
  let idx = 0;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l');
  return new Promise((resolve) => {
    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(`${C.bold}${title}${C.reset}\n\n`);
      options.forEach((o, i) => {
        const label = typeof o === 'string' ? o : o.label;
        const desc = typeof o === 'string' ? '' : o.description;
        process.stdout.write(i === idx
          ? `  ${C.green}❯ ${C.bold}${label}${C.reset}${desc ? C.dim + '  ' + desc + C.reset : ''}\n`
          : `    ${label}${desc ? C.dim + '  ' + desc + C.reset : ''}\n`);
      });
      process.stdout.write(`\n${C.dim}↑/↓ move  ·  Enter select  ·  q quit${C.reset}\n`);
    };
    render();
    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
    };
    const onData = (buf) => {
      const s = buf.toString();
      if (s === '\u001b[A') { idx = (idx - 1 + options.length) % options.length; render(); }
      else if (s === '\u001b[B') { idx = (idx + 1) % options.length; render(); }
      else if (s === '\r' || s === '\n') { const r = idx; cleanup(); console.log(); resolve(r); }
      else if (s === 'q' || s === '\u0003') { cleanup(); console.log(); resolve(-1); }
      else if (/^[0-9]$/.test(s)) { idx = Math.min(options.length - 1, parseInt(s, 10) - 1); render(); }
    };
    process.stdin.on('data', onData);
  });
}

function runCmd(cmd) {
  return new Promise((resolve) => {
    console.log(`${C.dim}┌ running ${C.reset}${C.green}${cmd}${C.reset}`);
    const child = spawn(cmd, { shell: true, stdio: 'inherit', cwd: ROOT });
    child.on('exit', (code, signal) => {
      console.log(`${C.dim}└ exit ${code === 0 ? C.green + '0' : C.red + String(code)}${C.reset}${signal ? ' (' + signal + ')' : ''}`);
      resolve(code === 0);
    });
    child.on('error', (e) => { console.log(`${C.red}${e.message}${C.reset}`); resolve(false); });
  });
}

let spinTimer = null;
function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write(`${C.cyan}${frames[0]}${C.reset} ${label}`);
  spinTimer = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${C.cyan}${frames[i]}${C.reset} ${label}`);
  }, 90);
  return () => {
    clearInterval(spinTimer); spinTimer = null;
    process.stdout.write('\r' + ' '.repeat(strip(label).length + 4) + '\r');
  };
}
function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
function bar(done, total, width = 20) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return C.green + '█'.repeat(filled) + C.dim + '░'.repeat(width - filled) + C.reset;
}
function progressLine(state, all) {
  const done = all.filter(id => state.lessons[id]?.passed).length;
  return `${bar(done, all.length)} ${C.bold}${done}/${all.length}${C.reset}`;
}
process.on('exit', () => { try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {} });

module.exports = { C, strip, paint, wrap, rule, box, command, readKey, select, runCmd, spinner, clear, bar, progressLine, ROOT };
