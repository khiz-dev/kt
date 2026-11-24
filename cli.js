#!/usr/bin/env node
'use strict';

/**
 * kt — an interactive, self-verifying Kubernetes networking course.
 * Everything is local: no account, no cloud, no HTML server.
 */
const { modules, byId, all } = require('./lib/lessons');
const { checks, kjson, run, CTX } = require('./lib/verifiers');
const progress = require('./lib/progress');
const ui = require('./lib/ui');
const { C, paint, wrap, rule, box, command, readKey, select, runCmd, spinner, clear, progressLine, strip } = ui;

const state = progress.load();
const arg = process.argv.slice(2);

function chapterOf(lessonId) {
  return modules.find(m => m.lessons.some(l => l.id === lessonId));
}
function indexOf(lessonId) { return all.indexOf(lessonId); }
function nextLessonId(after) {
  const i = indexOf(after);
  for (let j = i + 1; j < all.length; j++) if (!progress.isDone(state, all[j])) return all[j];
  return null;
}
function header() {
  const ch = state.current ? chapterOf(state.current) : null;
  console.log(`${C.green}kt${C.reset} ${C.dim}·${C.reset} ${C.bold}Kubernetes Networking Academy${C.reset}`);
  console.log(`${C.dim}cluster ${CTX}  ·  progress ${strip(progressLine(state, all))}${ch ? '  ·  ' + ch.title : ''}${C.reset}`);
  rule();
}

function printConcept(lines) {
  console.log(`\n${C.bold}THE IDEA${C.reset}`);
  for (const line of lines) console.log('\n' + paint(wrap(line, 88, '  ')));
}
function printDiagram(diagram) {
  console.log(`\n${C.bold}THE PICTURE${C.reset}`);
  console.log(C.dim + diagram.split('\n').map(l => '  ' + l).join('\n') + C.reset);
}

async function verifyLesson(id, { showDetails = true } = {}) {
  const lesson = byId[id];
  const stop = spinner('Inspecting the live cluster...');
  const results = [];
  for (const cid of lesson.checks) {
    const def = checks[cid];
    if (!def) { results.push({ id: cid, label: cid, ok: false, detail: 'verifier missing' }); continue; }
    let r;
    try { r = await def.run(); } catch (e) { r = { ok: false, detail: e.message }; }
    results.push({ id: cid, label: def.label, hint: def.hint, ok: !!r.ok, detail: r.detail || '' });
  }
  stop();
  const ok = results.every(r => r.ok);
  if (ok) progress.markPass(state, id, 'all checks passed');
  else progress.markAttempt(state, id, results.filter(r => !r.ok).map(r => r.label).join(', '));

  if (showDetails) {
    console.log(`\n${ok ? C.green + C.bold + '  ALL CHECKS PASSED' : C.red + C.bold + '  SOME CHECKS FAILED'}${C.reset}\n`);
    for (const r of results) {
      console.log(`  ${r.ok ? C.green + '✔' : C.red + '✘'} ${C.reset}${r.label}`);
      if (r.detail) console.log(`    ${C.dim}${wrap(r.detail, 82, '')}${C.reset}`);
      if (!r.ok && r.hint) console.log(`    ${C.yellow}hint: ${paint(r.hint)}${C.reset}`);
    }
    console.log(`\n  ${C.dim}progress ${strip(progressLine(state, all))}${C.reset}\n`);
  }
  return { ok, results };
}

async function guided(id) {
  const lesson = byId[id];
  if (!lesson) { console.log(`${C.red}Unknown lesson: ${id}${C.reset}`); return; }
  const chapter = chapterOf(id);
  progress.setCurrent(state, id);

  clear(); header();
  console.log(`\n${C.magenta}${chapter.title}${C.reset}`);
  console.log(`${C.bold}${C.underline}${lesson.title}${C.reset}  ${C.dim}· ${lesson.min} min${C.reset}`);
  printConcept(lesson.concept);
  if (lesson.diagram) printDiagram(lesson.diagram);
  box('YOU WILL BE VERIFIED ON', lesson.checks.map(c => `  • ${checks[c]?.label || c}`), C.magenta);
  await readKey(`${C.dim}Press Enter to start doing...${C.reset}`);

  for (let i = 0; i < lesson.steps.length; i++) {
    const step = lesson.steps[i];
    clear(); header();
    console.log(`\n${C.magenta}${chapter.title}${C.reset} ${C.dim}›${C.reset} ${lesson.title}`);
    box(`STEP ${i + 1} OF ${lesson.steps.length}: ${step.title}`, ['', `  $ ${step.cmd}`], C.blue);
    if (step.note) console.log('\n' + paint(wrap(step.note, 88, '  ')));
    if (/port-forward/.test(step.cmd)) {
      console.log(`\n${C.yellow}  This command blocks the terminal. Run it in a second terminal, or skip it —${C.reset}`);
      console.log(`${C.yellow}  the verifier opens its own port-forward.${C.reset}`);
    }
    const key = await readKey(`\n${C.bold}[Enter]${C.reset} run it   ${C.dim}[s] skip  [h] hint  [q] quit lesson${C.reset}  `);
    if (key === 'q') return;
    if (key === 'h') {
      console.log(`\n${C.yellow}${paint(wrap(lesson.hint, 88, '  '))}${C.reset}`);
      await readKey(`${C.dim}Press Enter to continue...${C.reset}`);
    }
    if (key === 'enter') {
      const ok = await runCmd(step.cmd);
      if (!ok) console.log(`${C.yellow}  Command exited non-zero — that may be expected (e.g. a denied curl).${C.reset}`);
      await readKey(`${C.dim}Press Enter to continue...${C.reset}`);
    }
  }

  while (true) {
    clear(); header();
    console.log(`\n${C.magenta}${chapter.title}${C.reset} ${C.dim}›${C.reset} ${lesson.title}`);
    box('YOUR TASK', ['', ...wrap(lesson.task, 74, '  ').split('\n')], C.green);
    console.log(`\n  ${C.dim}checks: ${lesson.checks.map(c => checks[c]?.label || c).join(' · ')}${C.reset}\n`);
    const key = await readKey(`${C.bold}[Enter/v]${C.reset} verify   ${C.dim}[h] hint  [c] solution  [n] next  [q] chapters${C.reset}  `);
    if (key === 'q') return;
    if (key === 'h') {
      console.log(`\n${C.yellow}${paint(wrap(lesson.hint, 88, '  '))}${C.reset}\n`);
      await readKey(`${C.dim}Press Enter...${C.reset}`);
      continue;
    }
    if (key === 'c') {
      console.log(`\n${C.dim}Solution commands:${C.reset}`);
      (lesson.solution || []).forEach(c => command(c));
      await readKey(`${C.dim}Press Enter...${C.reset}`);
      continue;
    }
    if (key === 'n') {
      const next = nextLessonId(id);
      if (next) return guided(next);
      console.log(`${C.green}Course complete! Run 'kt progress' to see your record.${C.reset}`);
      await readKey(`${C.dim}Press Enter...${C.reset}`);
      return;
    }
    const { ok } = await verifyLesson(id);
    if (ok) {
      console.log(`\n${C.green}${C.bold}  TAKEAWAY: ${paint(lesson.takeaway)}${C.reset}\n`);
      const k2 = await readKey(`${C.bold}[Enter]${C.reset} next lesson   ${C.dim}[q] back to chapters${C.reset}  `);
      if (k2 === 'q') return;
      const next = nextLessonId(id);
      if (next) return guided(next);
      console.log(`${C.green}You finished the whole course. Nice work.${C.reset}`);
      await readKey(`${C.dim}Press Enter...${C.reset}`);
      return;
    }
    await readKey(`${C.dim}Press Enter to try again...${C.reset}`);
  }
}

async function listAll() {
  clear(); header();
  for (const m of modules) {
    const done = m.lessons.filter(l => progress.isDone(state, l.id)).length;
    console.log(`\n${C.bold}${m.title}${C.reset} ${C.dim}${done}/${m.lessons.length}${C.reset}`);
    console.log(`  ${C.dim}${m.subtitle}${C.reset}`);
    m.lessons.forEach((l, i) => {
      const mark = progress.isDone(state, l.id) ? `${C.green}✔` : C.dim + '○';
      const cur = state.current === l.id ? `${C.cyan} ← you are here${C.reset}` : '';
      console.log(`  ${mark}${C.reset}  ${C.yellow}${i + 1}${C.reset}. ${l.id.padEnd(18)} ${l.title}${cur}`);
    });
  }
  console.log('');
}

async function menu() {
  while (true) {
    clear(); header();
    const resume = state.current && !progress.isDone(state, state.current) ? byId[state.current] : null;
    const options = [
      ...(resume ? [{ label: `Resume: ${resume.title}`, description: 'chapter ' + chapterOf(resume.id).title }] : []),
      { label: 'Browse chapters & lessons', description: 'guided, step by step' },
      { label: 'Cluster status', description: 'nodes, CNI, installed stacks' },
      { label: 'My progress', description: 'what you have verified' },
      { label: 'Verify a lesson manually', description: 're-run its checks' },
      { label: 'Reset lab namespaces', description: 'start the exercises over' },
    ];
    const choice = await select('What do you want to learn?', options);
    if (choice < 0) { console.log(`${C.dim}See you soon.${C.reset}\n`); return; }
    const label = options[choice].label;
    if (label.startsWith('Resume')) await guided(state.current);
    else if (label.startsWith('Browse')) await browse();
    else if (label.startsWith('Cluster')) await status({ pause: true });
    else if (label.startsWith('My')) await showProgress({ pause: true });
    else if (label.startsWith('Verify')) await verifyManually();
    else await resetLab();
  }
}

async function browse() {
  while (true) {
    const opts = modules.map(m => {
      const done = m.lessons.filter(l => progress.isDone(state, l.id)).length;
      return { label: m.title, description: `${done}/${m.lessons.length} verified` };
    });
    opts.push({ label: '← Back', description: '' });
    const ci = await select('Choose a chapter', opts);
    if (ci < 0 || ci === modules.length) return;
    const m = modules[ci];
    const lopts = m.lessons.map(l => ({
      label: l.title,
      description: `${progress.isDone(state, l.id) ? 'verified' : l.min + ' min'}`,
    }));
    lopts.push({ label: '← Back', description: '' });
    const li = await select(m.title, lopts);
    if (li < 0 || li === m.lessons.length) continue;
    await guided(m.lessons[li].id);
    return;
  }
}

async function verifyManually() {
  const opts = all.map(id => ({ label: byId[id].title, description: progress.isDone(state, id) ? 'verified' : 'not verified' }));
  opts.push({ label: '← Back', description: '' });
  const i = await select('Verify which lesson?', opts);
  if (i < 0 || i === all.length) return;
  await verifyLesson(all[i]);
  await readKey(`${C.dim}Press Enter...${C.reset}`);
}

async function status({ pause = false } = {}) {
  clear(); header();
  const stop = spinner('Asking the cluster...');
  const [nodes, cilium, gatewayapi, eg, istio, metallb] = await Promise.all([
    kjson('get', 'nodes'),
    kjson('get', 'ds', 'cilium', '-n', 'kube-system'),
    kjson('get', 'crd', 'gatewayclasses.gateway.networking.k8s.io'),
    kjson('get', 'deploy', 'envoy-gateway', '-n', 'envoy-gateway-system'),
    kjson('get', 'deploy', 'istiod', '-n', 'istio-system'),
    kjson('get', 'deploy', '-n', 'metallb-system'),
  ]);
  stop();
  const ready = (nodes?.items || []).filter(n => n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')).length;
  const lbCtrl = (metallb?.items || []).find(d => d.metadata.name.includes('controller'));
  const verRaw = await run('kubectl', ['--context', CTX, 'version', '-o', 'json']);
  let ver = '';
  try { ver = JSON.parse(verRaw.out).serverVersion.gitVersion; } catch {}
  const lines = [
    `  cluster:        ${C.green}${CTX}${C.reset}  (${ver})`,
    `  nodes:          ${ready}/${nodes?.items?.length || 0} Ready`,
    `  CNI:            Cilium ${cilium ? `${cilium.status.numberReady}/${cilium.status.desiredNumberScheduled} agents` : 'NOT INSTALLED'}`,
    `  Gateway API:    ${gatewayapi ? 'installed' : C.dim + 'not installed' + C.reset}`,
    `  Envoy Gateway:  ${eg?.status?.readyReplicas ? 'running' : C.dim + 'not installed' + C.reset}`,
    `  Istio:          ${istio?.status?.readyReplicas ? 'running' : C.dim + 'not installed' + C.reset}`,
    `  MetalLB:        ${lbCtrl?.status?.readyReplicas ? 'running' : C.dim + 'not installed' + C.reset}`,
  ];
  box('CLUSTER STATUS', lines, C.blue);
  console.log(`\n  ${C.dim}progress ${strip(progressLine(state, all))}${C.reset}\n`);
  if (pause) await readKey(`${C.dim}Press Enter...${C.reset}`);
}

async function showProgress({ pause = false } = {}) {
  clear(); header();
  let n = 0;
  for (const m of modules) {
    const done = m.lessons.filter(l => progress.isDone(state, l.id)).length;
    console.log(`\n${C.bold}${m.title}${C.reset} ${C.dim}${done}/${m.lessons.length} ${ui.bar(done, m.lessons.length, 14)}${C.reset}`);
    for (const l of m.lessons) {
      n++;
      const rec = state.lessons[l.id];
      const mark = rec?.passed ? `${C.green}PASS` : rec?.attempts ? `${C.yellow}TRY ` : `${C.dim}----`;
      console.log(`  ${mark}${C.reset}  ${String(n).padStart(2)}  ${l.id.padEnd(18)} ${l.title}${rec?.attempts ? C.dim + '  (' + rec.attempts + ' attempt' + (rec.attempts > 1 ? 's' : '') + ')' + C.reset : ''}`);
    }
  }
  console.log(`\n  ${C.dim}overall ${strip(progressLine(state, all))}${C.reset}`);
  console.log(`  ${C.dim}saved in .kt-progress.json${C.reset}\n`);
  if (pause) await readKey(`${C.dim}Press Enter...${C.reset}`);
}

async function resetLab() {
  console.log(`\n${C.yellow}This deletes the lab namespaces (net-lab, trusted, untrusted, other, canary, metallb-system)${C.reset}`);
  console.log(`${C.yellow}and uninstalls Envoy Gateway, Istio and MetalLB. Progress is kept.${C.reset}`);
  const key = await readKey(`${C.red}Type 'yes' to continue: ${C.reset}`);
  if (key !== 'yes') { console.log('Cancelled.'); return; }
  const cmds = [
    './bin/istioctl uninstall --purge -y --context ' + CTX + ' || true',
    'helm uninstall eg -n envoy-gateway-system --kube-context ' + CTX + ' || true',
    'helm uninstall metallb -n metallb-system --kube-context ' + CTX + ' || true',
    `kubectl --context ${CTX} delete ns net-lab trusted untrusted other canary envoy-gateway-system istio-system metallb-system --ignore-not-found`,
  ];
  for (const c of cmds) await runCmd(c);
  console.log(`${C.green}Lab reset. Start with: kt start apps${C.reset}`);
}

async function main() {
  const cmd = arg[0];
  switch (cmd) {
    case undefined: return menu();
    case 'start': case 'go': return guided(arg[1] || state.current || all[0]);
    case 'verify': return verifyLesson(arg[1] || state.current || all[0]);
    case 'check': {
      const def = checks[arg[1]];
      if (!def) { console.log(`${C.red}Unknown check. Available: ${Object.keys(checks).join(', ')}${C.reset}`); return; }
      const stop = spinner(def.label);
      let r; try { r = await def.run(); } catch (e) { r = { ok: false, detail: e.message }; }
      stop();
      console.log(`${r.ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${def.label}\n  ${r.detail || ''}`);
      return;
    }
    case 'list': case 'lessons': return listAll();
    case 'chapters': return browse();
    case 'status': return status();
    case 'progress': return showProgress();
    case 'reset': return resetLab();
    case 'next': {
      const next = nextLessonId(arg[1] || state.current || '');
      if (!next) { console.log(`${C.green}Nothing left — course complete.${C.reset}`); return; }
      return guided(next);
    }
    case 'help':
      console.log(`
${C.green}kt${C.reset} ${C.dim}— interactive Kubernetes networking course${C.reset}

  ${C.yellow}kt${C.reset}                 interactive menu
  ${C.yellow}kt start <lesson>${C.reset}   guided lesson (steps + verify)
  ${C.yellow}kt verify <lesson>${C.reset}  verify a lesson's checks
  ${C.yellow}kt check <check>${C.reset}    run one check
  ${C.yellow}kt list${C.reset}             all chapters and lessons
  ${C.yellow}kt chapters${C.reset}         chapter picker
  ${C.yellow}kt status${C.reset}           cluster/component status
  ${C.yellow}kt progress${C.reset}         progress report
  ${C.yellow}kt next${C.reset}             next unverified lesson
  ${C.yellow}kt reset${C.reset}            reset the lab namespaces
`);
      return;
    default:
      console.log(`${C.red}Unknown command: ${cmd}${C.reset} (try 'kt help')`);
  }
}

main().catch(e => { console.error(`${C.red}${e.stack || e.message}${C.reset}`); process.exitCode = 1; });
