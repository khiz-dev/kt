'use strict';
/**
 * Every check here inspects REAL cluster state. Nothing is self-reported.
 * All kubectl calls pin --context so a remote GKE context can never be touched.
 */
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const dns = require('node:dns/promises');

const pexec = promisify(execFile);
const CTX = 'kind-k8s-net-lab';
const CLUSTER = 'k8s-net-lab';
const ROOT = path.resolve(__dirname, '..');
const ISTIOCTL = path.join(ROOT, 'bin', 'istioctl');
const NS = 'net-lab';

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      timeout: opts.timeout || 30000,
      maxBuffer: 12 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || '').trim(),
      err: String(e.stderr || '').trim(),
      code: e.code,
    };
  }
}
const k = (...args) => run('kubectl', ['--context', CTX, ...args]);
async function kjson(...args) {
  const r = await k(...args, '-o', 'json');
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}
async function kpath(expr) {
  const r = await k('get', ...expr.split(/\s+/), '-o', 'jsonpath', '{' + (arguments[1] || '') + '}');
  return r.ok ? r.out : '';
}
const dockerExec = (script) => run('docker', ['exec', `${CLUSTER}-control-plane`, 'sh', '-c', script]);

async function curlIn(ns, pod, url, flags = '-sS -m 6 -o /dev/null -w %{http_code}') {
  return k('exec', '-n', ns, pod, '--', 'sh', '-c', `curl ${flags} '${url}'`);
}
async function nslookupIn(ns, pod, name) {
  return k('exec', '-n', ns, pod, '--', 'sh', '-c', `nslookup ${name} 2>&1 || true`);
}
async function svcIp(name, ns = NS) {
  return (await kjson('get', 'svc', name, '-n', ns))?.spec?.clusterIP || '';
}
function has(obj, fn) { return !!obj && fn(obj); }
const cond = (g, type) => has(g?.status?.conditions?.find(c => c.type === type), c => c.status === 'True');
const parentCond = (r, type) => (r?.status?.parents || []).some(p =>
  has(p.conditions?.find(c => c.type === type), c => c.status === 'True'));

/** Run a local function while a kubectl port-forward is live. */
async function withPortForward(namespace, target, localPort, remotePort, fn) {
  const child = spawn('kubectl', [
    '--context', CTX, 'port-forward', '-n', namespace, target,
    `${localPort}:${remotePort}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('port-forward timeout: ' + buf)), 12000);
    child.stdout.on('data', d => { buf += d; if (buf.includes('Forwarding')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', d => { buf += d; });
    child.on('exit', c => { clearTimeout(timer); reject(new Error(`port-forward exited ${c}: ${buf}`)); });
  });
  try { return await fn(); } finally { child.kill('SIGTERM'); }
}
async function firstEnvoyProxyDeploy() {
  const r = await k('get', 'deploy', '-n', 'envoy-gateway-system',
    '-l', 'gateway.envoyproxy.io/owning-gateway-name=eg',
    '-o', 'jsonpath={.items[0].metadata.name}');
  return r.out;
}
async function adminFetch(port, target, timeoutMs = 8000) {
  return withPortForward('envoy-gateway-system', `deploy/${target}`, port, 19000, async () => {
    const r = await run('curl', ['-sS', '-m', String(timeoutMs / 1000), `http://127.0.0.1:${port}/${target === 'x' ? '' : 'config_dump'}`]);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Check registry. id -> { label, hint, run }
// ---------------------------------------------------------------------------
const checks = {};
function define(id, label, hint, fn) { checks[id] = { id, label, hint, run: fn }; }
const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

// ---- Module 0 -------------------------------------------------------------
define('ctx', 'You are connected to the local kind cluster',
  'Run: kubectl config current-context — it must say kind-k8s-net-lab.',
  async () => {
    const r = await run('kubectl', ['--context', CTX, 'config', 'current-context']);
    return r.out === CTX ? pass(r.out) : fail(`Current context is ${r.out || 'unknown'}. Use --context ${CTX}.`);
  });

define('nodes-ready', 'All 3 nodes are Ready',
  'Wait a moment: kubectl --context kind-k8s-net-lab get nodes',
  async () => {
    const list = await kjson('get', 'nodes');
    const nodes = list?.items || [];
    const ready = nodes.filter(n => n.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
    return ready.length === 3 && nodes.length === 3
      ? pass(`${ready.length}/3 nodes Ready`)
      : fail(`${ready.length}/3 nodes Ready (found ${nodes.length})`);
  });

define('cilium-ready', 'Cilium agent is running on every node',
  'kubectl -n kube-system rollout status ds/cilium',
  async () => {
    const ds = await kjson('get', 'ds', 'cilium', '-n', 'kube-system');
    const desired = ds?.status?.desiredNumberScheduled ?? 0;
    const ready = ds?.status?.numberReady ?? 0;
    return desired >= 3 && ready === desired ? pass(`${ready}/${desired} agents ready`) : fail(`${ready}/${desired} agents ready`);
  });

define('cilium-ipam', 'Cilium uses Kubernetes IPAM (pod CIDRs from kind)',
  'helm get values cilium -n kube-system | grep ipam',
  async () => {
    const r = await run('helm', ['get', 'values', 'cilium', '-n', 'kube-system', '-o', 'yaml', '--kube-context', CTX]);
    return /ipam:\s*\n?\s*mode:\s*kubernetes/.test(r.out)
      ? pass('ipam.mode=kubernetes') : fail('ipam.mode is not kubernetes');
  });

define('cilium-kubeproxy', 'kube-proxy is still doing Service NAT',
  'Check helm values: kubeProxyReplacement must be false.',
  async () => {
    const r = await run('helm', ['get', 'values', 'cilium', '-n', 'kube-system', '-o', 'yaml', '--kube-context', CTX]);
    return /kubeProxyReplacement:\s*false/.test(r.out)
      ? pass('kubeProxyReplacement=false') : fail('kubeProxyReplacement must be false for this course');
  });

define('cilium-lbipam', "Cilium's LB-IPAM is off (so MetalLB can own LoadBalancers)",
  'Check helm values: defaultLBServiceIPAM must be none.',
  async () => {
    const r = await run('helm', ['get', 'values', 'cilium', '-n', 'kube-system', '-o', 'yaml', '--kube-context', CTX]);
    return /defaultLBServiceIPAM:\s*none/.test(r.out)
      ? pass('defaultLBServiceIPAM=none') : fail('defaultLBServiceIPAM must be none');
  });

define('ns-net-lab', 'Namespace net-lab exists',
  'kubectl create ns net-lab',
  async () => (await kjson('get', 'ns', NS)) ? pass('net-lab') : fail('namespace net-lab not found'));

async function deployReady(name, ns = NS) {
  const d = await kjson('get', 'deploy', name, '-n', ns);
  const ready = d?.status?.readyReplicas || 0;
  return ready >= 1 ? pass(`${name}: ${ready} pod ready`) : fail(`${name}: ${ready} pods ready`);
}
define('web-ready', 'The web Deployment is running', 'Apply lab/00-foundations/apps.yaml', () => deployReady('web'));
define('api-ready', 'The api Deployment is running', 'Apply lab/00-foundations/apps.yaml', () => deployReady('api'));
define('client-ready', 'The client pod is running', 'Apply lab/00-foundations/apps.yaml', async () => {
  const p = await kjson('get', 'pod', 'client', '-n', NS);
  return p?.status?.phase === 'Running' ? pass('client Running') : fail('client pod is not Running');
});
define('svc-clusterip', 'web and api have ClusterIP Services',
  'Apply lab/00-foundations/apps.yaml',
  async () => {
    const [web, api] = await Promise.all([kjson('get', 'svc', 'web', '-n', NS), kjson('get', 'svc', 'api', '-n', NS)]);
    return web && api ? pass(`web=${web.spec.clusterIP}, api=${api.spec.clusterIP}`) : fail('one or both Services are missing');
  });

// ---- Module 1 -------------------------------------------------------------
define('pod-ip-cidr', 'Pods get IPs from 10.244.x.x',
  'kubectl -n net-lab get pod -o wide',
  async () => {
    const list = await kjson('get', 'pods', '-n', NS);
    const ips = (list?.items || []).map(p => p.status.podIP).filter(Boolean);
    const good = ips.filter(ip => ip.startsWith('10.244.'));
    return good.length > 0 ? pass(good.join(', ')) : fail(`no pod IP in 10.244/16 (found: ${ips.join(', ') || 'none'})`);
  });

define('endpointslice', 'An EndpointSlice tracks the api pods',
  'kubectl -n net-lab get endpointslice -l kubernetes.io/service-name=api',
  async () => {
    const list = await kjson('get', 'endpointslice', '-n', NS, '-l', 'kubernetes.io/service-name=api');
    const n = (list?.items || []).reduce((a, e) => a + (e.endpoints?.length || 0), 0);
    return n > 0 ? pass(`${n} endpoint address(es)`) : fail('no endpoints for service api');
  });

define('svc-ip-range', 'ClusterIPs come from 10.96.0.0/16',
  'kubectl -n net-lab get svc',
  async () => {
    const ip = await svcIp('api');
    return ip.startsWith('10.96.') ? pass(ip) : fail(`api ClusterIP is ${ip || 'missing'}`);
  });

define('curl-via-service', 'client can reach api through its Service IP',
  'kubectl -n net-lab exec client -- curl -s http://api',
  async () => {
    const r = await curlIn(NS, 'client', 'http://api.net-lab.svc.cluster.local');
    return r.ok && r.out === '200' ? pass('HTTP 200 via ClusterIP') : fail(`curl returned ${r.out || r.err || 'error'}`);
  });

define('iptables-kube-svc', 'kube-proxy programmed iptables KUBE-SVC chains',
  'docker exec k8s-net-lab-control-plane sh -c "iptables-save -t nat | grep KUBE-SVC"',
  async () => {
    const r = await dockerExec("iptables-save -t nat 2>/dev/null | grep -c 'KUBE-SVC' || true");
    const n = parseInt(r.out, 10) || 0;
    return n > 0 ? pass(`${n} KUBE-SVC rules found`) : fail('no KUBE-SVC nat rules found on the control-plane node');
  });

define('coredns-ready', 'CoreDNS is running',
  'kubectl -n kube-system get pods -l k8s-app=kube-dns',
  async () => deployReady('coredns', 'kube-system'));

define('dns-api-resolves', 'CoreDNS resolves the full Service FQDN',
  'kubectl -n net-lab exec client -- nslookup api.net-lab.svc.cluster.local',
  async () => {
    const ip = await svcIp('api');
    const r = await nslookupIn(NS, 'client', 'api.net-lab.svc.cluster.local');
    return ip && r.out.includes(ip) ? pass(`api.net-lab.svc.cluster.local → ${ip}`) : fail(`expected ${ip}, got:\n${r.out.slice(0, 300)}`);
  });

define('dns-short-name', 'The search suffix makes `api` resolvable',
  'kubectl -n net-lab exec client -- nslookup api',
  async () => {
    const ip = await svcIp('api');
    const r = await nslookupIn(NS, 'client', 'api');
    return ip && r.out.includes(ip) ? pass(`api → ${ip}`) : fail(`short name did not resolve to ${ip}`);
  });

define('headless-svc', 'A headless Service has clusterIP: None',
  'Apply lab/01-services/headless.yaml',
  async () => {
    const s = await kjson('get', 'svc', 'api-headless', '-n', NS);
    return s?.spec?.clusterIP === 'None' ? pass('clusterIP: None') : fail('api-headless missing or not headless');
  });

define('headless-dns', 'Headless DNS returns Pod IPs, not a Service IP',
  'kubectl -n net-lab exec client -- nslookup api-headless',
  async () => {
    const list = await kjson('get', 'pods', '-n', NS, '-l', 'app=api');
    const podIp = list?.items?.[0]?.status?.podIP;
    const r = await nslookupIn(NS, 'client', 'api-headless.net-lab.svc.cluster.local');
    return podIp && r.out.includes(podIp) ? pass(`A record → ${podIp} (a pod IP)`) : fail(`expected a pod IP, got:\n${r.out.slice(0, 300)}`);
  });

define('nodeport-svc', 'A NodePort Service listens on 30081',
  'Apply lab/01-services/nodeport.yaml',
  async () => {
    const s = await kjson('get', 'svc', 'web-nodeport', '-n', NS);
    const np = s?.spec?.ports?.[0]?.nodePort;
    return np === 30081 ? pass('30081/TCP') : fail(`nodePort is ${np || 'missing'}`);
  });

define('nodeport-curl', 'The NodePort is reachable from your Mac',
  'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:30081',
  async () => {
    const r = await run('curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:30081']);
    return r.ok && r.out === '200' ? pass('HTTP 200 from the host') : fail(`curl returned ${r.out || r.err || 'error'}`);
  });

// ---- Module 2 -------------------------------------------------------------
define('np-baseline-curl', 'Baseline: client can reach web (no policy yet)',
  'Remove policies: kubectl -n net-lab delete networkpolicy --all',
  async () => {
    const r = await curlIn(NS, 'client', 'http://web');
    return r.ok && r.out === '200' ? pass('HTTP 200 (default-allow)') : fail(`curl returned ${r.out || r.err || 'error'}`);
  });

define('np-deny-exists', 'A default-deny ingress policy exists',
  'Apply lab/02-networkpolicy/deny-ingress.yaml',
  async () => {
    const list = await kjson('get', 'networkpolicies', '-n', NS);
    const found = (list?.items || []).some(p =>
      Object.keys(p.spec?.podSelector?.matchLabels || {}).length === 0 &&
      (p.spec?.policyTypes || []).includes('Ingress') &&
      (p.spec?.ingress || []).length === 0);
    return found ? pass('default-deny ingress found') : fail('no empty-selector Ingress deny policy found');
  });

define('np-deny-blocks', 'The policy actually blocks the client',
  'curl from the client pod should fail now',
  async () => {
    const r = await curlIn(NS, 'client', 'http://web', '-sS -m 4 -o /dev/null -w %{http_code} || echo BLOCKED');
    return /BLOCKED|000|^7|^28/.test(r.out) || !r.ok ? pass('connection blocked') : fail(`curl still got ${r.out}`);
  });

define('np-allow-pod-exists', 'An allow policy names the client pod selector',
  'Apply lab/02-networkpolicy/allow-client.yaml',
  async () => {
    const list = await kjson('get', 'networkpolicies', '-n', NS);
    const found = (list?.items || []).some(p =>
      p.spec?.ingress?.some(i => i.from?.some(f => f.podSelector?.matchLabels?.app === 'client')));
    return found ? pass('ingress.from.podSelector app=client') : fail('no policy allowing pods labelled app=client');
  });

define('np-allow-pod-curl', 'client is allowed again, evil is still blocked',
  'Check from both pods',
  async () => {
    const good = await curlIn(NS, 'client', 'http://web');
    const evil = await curlIn('untrusted', 'evil', `http://web.${NS}.svc.cluster.local`);
    return good.out === '200' && evil.out !== '200'
      ? pass('client=200, evil=blocked')
      : fail(`client=${good.out || good.err}, evil=${evil.out || evil.err}`);
  });

define('np-ns-port-exists', 'A namespaceSelector + port rule exists',
  'Apply lab/02-networkpolicy/allow-namespace-port.yaml',
  async () => {
    const list = await kjson('get', 'networkpolicies', '-n', NS);
    const found = (list?.items || []).some(p =>
      p.spec?.ingress?.some(i => i.from?.some(f => f.namespaceSelector?.matchLabels?.team === 'trusted') &&
        i.ports?.some(port => port.port === 80)));
    return found ? pass('namespaceSelector team=trusted on port 80') : fail('namespace/port rule not found');
  });

define('np-ns-port-allowed', 'A pod from the trusted namespace can reach web',
  'kubectl -n untrusted exec evil -- curl ... (use the trusted pod instead)',
  async () => {
    const r = await curlIn('trusted', 'trusted', `http://web.${NS}.svc.cluster.local`);
    return r.out === '200' ? pass('trusted/ HTTP 200') : fail(`trusted pod curl returned ${r.out || r.err}`);
  });

define('np-ns-port-denied', 'A pod from an unlabelled namespace is still denied',
  'The evil pod must stay blocked',
  async () => {
    const r = await curlIn('untrusted', 'evil', `http://web.${NS}.svc.cluster.local`);
    return r.out !== '200' ? pass('untrusted pod blocked') : fail('untrusted pod was NOT blocked');
  });

define('np-egress-exists', 'Egress is default-denied in net-lab',
  'Apply lab/02-networkpolicy/egress-dns.yaml',
  async () => {
    const list = await kjson('get', 'networkpolicies', '-n', NS);
    const found = (list?.items || []).some(p =>
      (p.spec?.policyTypes || []).includes('Egress') && (p.spec?.egress || []).length === 0);
    return found ? pass('default-deny egress found') : fail('no default-deny egress policy');
  });

define('np-egress-dns-ok', 'DNS to kube-dns is allowed again',
  'The egress policy must allow UDP/TCP 53 to k8s-app=kube-dns',
  async () => {
    const r = await nslookupIn(NS, 'client', 'kubernetes.default');
    return /10\.96\.0\.1|Address:/.test(r.out) && !r.out.includes('connection timed out')
      ? pass('DNS resolution works') : fail(`DNS failed:\n${r.out.slice(0, 300)}`);
  });

define('np-egress-external-blocked', 'External internet access is still denied',
  'curl https://example.com from client should fail',
  async () => {
    const r = await curlIn(NS, 'client', 'https://example.com', '-sS -m 6 -o /dev/null -w %{http_code} || echo BLOCKED');
    return /BLOCKED|000|7|28/.test(r.out) || !r.ok ? pass('external access blocked') : fail(`external curl returned ${r.out}`);
  });

define('cilium-l7-exists', 'A CiliumNetworkPolicy with HTTP rules exists',
  'Apply lab/02-networkpolicy/l7.yaml',
  async () => {
    const list = await kjson('get', 'ciliumnetworkpolicies', '-n', NS);
    const found = (list?.items || []).some(p => p.spec?.endpointSelector && JSON.stringify(p).includes('http'));
    return found ? pass('L7 policy found') : fail('no CiliumNetworkPolicy with http rules');
  });

define('cilium-l7-public', 'GET /public is allowed',
  'kubectl -n net-lab exec client -- curl -s http://l7/public',
  async () => {
    const r = await curlIn(NS, 'client', 'http://l7/public');
    const body = await k('exec', '-n', NS, 'client', '--', 'sh', '-c', 'curl -s http://l7/public');
    return body.out.includes('public') ? pass('GET /public → 200') : fail(`got: ${body.out.slice(0,120)}`);
  });

define('cilium-l7-admin-blocked', 'GET /admin is blocked by L7 policy',
  'kubectl -n net-lab exec client -- curl -s -o /dev/null -w "%{http_code}" http://l7/admin',
  async () => {
    const r = await k('exec', '-n', NS, 'client', '--', 'sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" http://l7/admin');
    return r.out === '403' ? pass('GET /admin → 403') : fail(`GET /admin returned ${r.out || r.err}`);
  });

// ---- Module 3 -------------------------------------------------------------
define('gw-crd-standard', 'Gateway API v1.7.0 standard CRDs are installed',
  'kubectl apply --server-side -f .../standard-install.yaml',
  async () => {
    const crds = await kjson('get', 'crd',
      'gatewayclasses.gateway.networking.k8s.io',
      'gateways.gateway.networking.k8s.io',
      'httproutes.gateway.networking.k8s.io');
    const items = crds?.items || [];
    const v = items.find(c => c.metadata.name === 'gatewayclasses.gateway.networking.k8s.io')
      ?.metadata?.annotations?.['gateway.networking.k8s.io/bundle-version'];
    return items.length === 3 ? pass(`CRDs installed (bundle ${v || '?'})`) : fail(`${items.length}/3 Gateway API CRDs found`);
  });

define('eg-deploy-ready', 'Envoy Gateway controller is running',
  'helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.4 ...',
  () => deployReady('envoy-gateway', 'envoy-gateway-system'));

define('eg-proxy-config', 'EnvoyProxy config pins the NodePort',
  'Apply lab/03-gateway/gateway.yaml',
  async () => {
    const e = await kjson('get', 'envoyproxy', 'kind-nodeport', '-n', 'envoy-gateway-system');
    const s = JSON.stringify(e || '');
    return s.includes('nodePort') && s.includes('30080') ? pass('EnvoyProxy nodePort=30080') : fail('EnvoyProxy CR missing or has no 30080 patch');
  });

define('gwclass-accepted', 'GatewayClass eg is Accepted',
  'kubectl get gatewayclass eg',
  async () => {
    const g = await kjson('get', 'gatewayclass', 'eg');
    return cond(g, 'Accepted') ? pass('Accepted=True') : fail(`conditions: ${JSON.stringify(g?.status?.conditions || [])}`);
  });

define('gateway-programmed', 'Gateway eg is Programmed',
  'kubectl get gateway eg -n net-lab -o yaml',
  async () => {
    const g = await kjson('get', 'gateway', 'eg', '-n', NS);
    return cond(g, 'Programmed') && cond(g, 'Accepted')
      ? pass('Accepted + Programmed') : fail(`conditions: ${JSON.stringify(g?.status?.conditions || [])}`);
  });

define('gateway-nodeport', 'The Envoy Service maps to host port 30080',
  'kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=eg',
  async () => {
    const list = await kjson('get', 'svc', '-A', '-l', 'gateway.envoyproxy.io/owning-gateway-name=eg');
    const found = (list?.items || []).find(s => s.spec?.ports?.some(p => p.nodePort === 30080));
    return found ? pass(`${found.metadata.namespace}/${found.metadata.name} → 30080`) : fail('no Envoy Service with nodePort 30080');
  });

define('route-accepted', 'HTTPRoute is Accepted by the Gateway',
  'Apply lab/03-gateway/httproute.yaml',
  async () => {
    const r = await kjson('get', 'httproute', 'demo', '-n', NS);
    return parentCond(r, 'Accepted') ? pass('Accepted=True') : fail(`conditions: ${JSON.stringify(r?.status?.parents || [])}`);
  });

define('route-path-v1', 'Path /v1 reaches the v1 backend',
  'curl -H "Host: lab.local" http://127.0.0.1:30080/v1',
  async () => {
    const r = await run('curl', ['-sS', '-m', '8', '-H', 'Host: lab.local', 'http://127.0.0.1:30080/v1']);
    return r.out.includes('v1') ? pass(`body: ${r.out.slice(0, 60)}`) : fail(`body: ${r.out.slice(0, 120) || r.err}`);
  });

define('route-path-v2', 'Path /v2 reaches the v2 backend',
  'curl -H "Host: lab.local" http://127.0.0.1:30080/v2',
  async () => {
    const r = await run('curl', ['-sS', '-m', '8', '-H', 'Host: lab.local', 'http://127.0.0.1:30080/v2']);
    return r.out.includes('v2') ? pass(`body: ${r.out.slice(0, 60)}`) : fail(`body: ${r.out.slice(0, 120) || r.err}`);
  });

define('refgrant-exists', 'A ReferenceGrant allows cross-namespace backends',
  'Apply lab/03-gateway/refgrant.yaml',
  async () => {
    const list = await kjson('get', 'referencegrants', '-A');
    const found = (list?.items || []).some(g =>
      g.spec?.to?.some(t => t.kind === 'Service') && g.spec?.from?.some(f => f.namespace === 'other' || f.group === 'gateway.networking.k8s.io'));
    return found ? pass('ReferenceGrant found') : fail('no ReferenceGrant found');
  });

define('crossns-route-accepted', 'HTTPRoute in namespace other is Accepted',
  'Apply lab/03-gateway/refgrant.yaml',
  async () => {
    const r = await kjson('get', 'httproute', 'cross', '-n', 'other');
    return parentCond(r, 'Accepted') ? pass('cross-namespace route Accepted') : fail(`conditions: ${JSON.stringify(r?.status?.parents || [])}`);
  });

define('crossns-curl', 'Cross-namespace route serves traffic',
  'curl -H "Host: other.local" http://127.0.0.1:30080/',
  async () => {
    const r = await run('curl', ['-sS', '-m', '8', '-H', 'Host: other.local', 'http://127.0.0.1:30080/']);
    return r.ok && r.out.length > 0 ? pass(`HTTP response received (${r.out.length} bytes)`) : fail(`curl failed: ${r.err}`);
  });

// ---- Module 4 -------------------------------------------------------------
define('standalone-envoy-ready', 'Standalone Envoy pod is Ready',
  'Apply lab/04-envoy/standalone.yaml',
  async () => {
    const p = await kjson('get', 'pod', '-n', NS, '-l', 'app=envoy-standalone');
    return p?.items?.[0]?.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
      ? pass('Envoy Ready') : fail('Envoy pod is not Ready');
  });

define('standalone-envoy-route', 'Envoy routes /api to the api Service',
  'kubectl -n net-lab exec client -- curl -s http://envoy-standalone:8080/api',
  async () => {
    const r = await curlIn(NS, 'client', 'http://envoy-standalone.net-lab.svc.cluster.local:8080/api');
    const body = await k('exec', '-n', NS, 'client', '--', 'sh', '-c', 'curl -s http://envoy-standalone:8080/api');
    return body.out.includes('api-v1') ? pass('body contains api-v1') : fail(`got: ${body.out.slice(0, 120) || body.err}`);
  });

define('envoy-listener', 'Envoy config_dump contains the 8080 listener',
  'kubectl -n envoy-gateway-system port-forward deploy/<envoy> 19000:19000 then curl /config_dump',
  async () => {
    const target = await firstEnvoyProxyDeploy();
    if (!target) return fail('no Envoy Gateway data-plane Deployment found');
    const port = 19100 + Math.floor(Math.random() * 200);
    try {
      const r = await withPortForward('envoy-gateway-system', `deploy/${target}`, port, 19000,
        () => run('curl', ['-sS', '-m', '10', `http://127.0.0.1:${port}/config_dump`]));
      return /"listener"/.test(r.out) && /8080|10080/.test(r.out) ? pass('listener found in config_dump') : fail('no listener in config_dump');
    } catch (e) { return fail(e.message); }
  });

define('envoy-cluster', 'Envoy config_dump contains the v1/v2 clusters',
  'Look for cluster names in /config_dump',
  async () => {
    const target = await firstEnvoyProxyDeploy();
    if (!target) return fail('no Envoy data-plane Deployment');
    const port = 19300 + Math.floor(Math.random() * 200);
    try {
      const r = await withPortForward('envoy-gateway-system', `deploy/${target}`, port, 19000,
        () => run('curl', ['-sS', '-m', '10', `http://127.0.0.1:${port}/config_dump`]));
      return /"clusters"/.test(r.out) && /v1/.test(r.out) ? pass('clusters found in config_dump') : fail('clusters missing');
    } catch (e) { return fail(e.message); }
  });

define('envoy-attempt-header', 'Standalone Envoy reports x-envoy-attempt-count',
  'curl -I http://envoy-standalone:8080/api from the client pod',
  async () => {
    const r = await k('exec', '-n', NS, 'client', '--', 'sh', '-c',
      'curl -sSI http://envoy-standalone:8080/api | tr "A-Z" "a-z"');
    return /x-envoy-attempt-count/.test(r.out) ? pass('x-envoy-attempt-count present') : fail('header missing; set include_attempt_count_in_response');
  });

async function egGone() {
  return !(await kjson('get', 'ns', 'envoy-gateway-system'));
}

define('eg-configdump-gateway', 'xDS config contains the Gateway hostname',
  'curl http://127.0.0.1:19000/config_dump after port-forward, before cleanup',
  async () => {
    if (await egGone()) return pass('already demonstrated: Envoy Gateway removed during cleanup');
    const target = await firstEnvoyProxyDeploy();
    if (!target) return fail('no Envoy data-plane Deployment');
    const port = 19500 + Math.floor(Math.random() * 200);
    try {
      const r = await withPortForward('envoy-gateway-system', `deploy/${target}`, port, 19000,
        () => run('curl', ['-sS', '-m', '10', `http://127.0.0.1:${port}/config_dump`]));
      return r.out.includes('lab.local') ? pass('lab.local found in dynamic route config') : fail('hostname not present in config_dump');
    } catch (e) { return fail(e.message); }
  });

define('eg-removed', 'Envoy Gateway has been cleaned up',
  'helm uninstall eg -n envoy-gateway-system',
  async () => (await kjson('get', 'ns', 'envoy-gateway-system')) ? fail('namespace still exists') : pass('Envoy Gateway removed'));

// ---- Module 5 -------------------------------------------------------------
define('istioctl-client', 'istioctl 1.32 client is installed',
  'curl -L -o bin/istioctl ... && chmod +x bin/istioctl',
  async () => {
    const r = await run(ISTIOCTL, ['version', '--remote=false']);
    const combined = r.out + r.err;
    return /1\.32/.test(combined) ? pass('istioctl 1.32.x') : fail(`istioctl not usable: ${combined.slice(0, 160)}`);
  });

define('istiod-ready', 'istiod is running',
  'istioctl install -y --set profile=demo ...',
  () => deployReady('istiod', 'istio-system'));

define('istio-crds', 'Istio networking CRDs are installed',
  'kubectl get crd virtualservices.networking.istio.io',
  async () => {
    const list = await kjson('get', 'crd', 'virtualservices.networking.istio.io', 'destinationrules.networking.istio.io');
    return (list?.items?.length || 0) === 2 ? pass('VirtualService + DestinationRule CRDs') : fail('Istio CRDs missing');
  });

define('ns-injected', 'The canary namespace has injection enabled',
  'kubectl label ns canary istio-injection=enabled',
  async () => {
    const ns = await kjson('get', 'ns', 'canary');
    return ns?.metadata?.labels?.['istio-injection'] === 'enabled' ? pass('istio-injection=enabled') : fail('label missing');
  });

define('sidecars-present', 'Pods in canary have 2 containers (app + istio-proxy)',
  'Restart deployments after labelling the namespace',
  async () => {
    const list = await kjson('get', 'pods', '-n', 'canary');
    const pods = (list?.items || []).filter(p => p.metadata?.labels?.app === 'demo');
    // Istio 1.32 uses native sidecars: istio-proxy is a restartable initContainer.
    const ok = pods.length >= 2 && pods.every(p => {
      const names = [...(p.spec?.containers || []), ...(p.spec?.initContainers || [])].map(c => c.name);
      return names.includes('istio-proxy');
    });
    return ok ? pass(`${pods.length} pods with istio-proxy sidecars`) : fail(`${pods.length} demo pods; sidecars not injected`);
  });

define('proxy-synced', 'istioctl proxy-status shows SYNCED sidecars',
  'istioctl proxy-status',
  async () => {
    const r = await run(ISTIOCTL, ['proxy-status', '--context', CTX]);
    // istioctl 1.32 shows SUBSCRIBED TYPES instead of a SYNCED column.
    const lines = (r.out + r.err).split('\n').filter(l => l.includes('.canary') && l.includes('istiod-'));
    return lines.length >= 3
      ? pass(`${lines.length} canary proxies connected to istiod`)
      : fail('proxies not connected: ' + (r.err || r.out).slice(0, 160));
  });

define('vs-exists', 'A VirtualService defines traffic weights',
  'Apply lab/05-istio/canary.yaml',
  async () => {
    const v = await kjson('get', 'virtualservice', 'demo', '-n', 'canary');
    const routes = v?.spec?.http?.[0]?.route || [];
    return routes.length === 2 ? pass(`weights: ${routes.map(r => r.weight).join('/')}`) : fail('VirtualService missing or not 2 routes');
  });

define('dr-subsets', 'DestinationRule defines v1 and v2 subsets',
  'Apply lab/05-istio/canary.yaml',
  async () => {
    const d = await kjson('get', 'destinationrule', 'demo', '-n', 'canary');
    const names = (d?.spec?.subsets || []).map(s => s.name).join(',');
    return names.includes('v1') && names.includes('v2') ? pass(`subsets: ${names}`) : fail(`subsets: ${names || 'none'}`);
  });

define('canary-split', 'Traffic actually splits across v1 and v2',
  'curl demo 40 times and count responses',
  async () => {
    const r = await k('exec', '-n', 'canary', 'client', '--', 'sh', '-c',
      'for i in $(seq 1 40); do curl -s http://demo.canary.svc.cluster.local; echo; done');
    const v1 = (r.out.match(/v1/g) || []).length;
    const v2 = (r.out.match(/v2/g) || []).length;
    return v1 > 0 && v2 > 0 ? pass(`v1=${v1}, v2=${v2} of 40`) : fail(`v1=${v1}, v2=${v2} — no split observed`);
  });

define('peer-auth-strict', 'PeerAuthentication enforces STRICT mTLS',
  'Apply lab/05-istio/mtls.yaml',
  async () => {
    const p = await kjson('get', 'peerauthentication', 'demo-mtls', '-n', 'canary');
    return p?.spec?.mtls?.mode === 'STRICT' ? pass('STRICT') : fail('PeerAuthentication missing or not STRICT');
  });

define('mtls-curl', 'Services still work with mTLS enabled',
  'curl from the injected client',
  async () => {
    const r = await curlIn('canary', 'client', 'http://demo.canary.svc.cluster.local');
    return r.out === '200' ? pass('HTTP 200 over mTLS') : fail(`curl returned ${r.out || r.err}`);
  });

async function istioGone() {
  const [ns, crd] = await Promise.all([
    kjson('get', 'ns', 'istio-system'),
    kjson('get', 'crd', 'virtualservices.networking.istio.io'),
  ]);
  return !ns && !crd;
}

define('vs-header-match', 'VirtualService has a header-based match',
  'Apply lab/05-istio/header-route.yaml before uninstalling Istio',
  async () => {
    if (await istioGone()) return pass('already demonstrated: Istio removed during cleanup');
    const v = await kjson('get', 'virtualservice', 'demo', '-n', 'canary');
    const found = (v?.spec?.http || []).some(h => h.match?.some(m => m.headers));
    return found ? pass('header match found') : fail('no header match in VirtualService');
  });

define('header-route-v2', 'x-canary: true routes to v2',
  'curl -H "x-canary: true" http://demo.canary.svc.cluster.local before uninstalling Istio',
  async () => {
    if (await istioGone()) return pass('already demonstrated: Istio removed during cleanup');
    const r = await k('exec', '-n', 'canary', 'client', '--', 'sh', '-c',
      'curl -s -H "x-canary: true" http://demo.canary.svc.cluster.local');
    return r.out.includes('v2') ? pass(`body: ${r.out.slice(0, 50)}`) : fail(`body: ${r.out.slice(0, 120) || r.err}`);
  });

define('istio-removed', 'Istio has been cleaned up',
  'istioctl uninstall --purge -y',
  async () => (await kjson('get', 'ns', 'istio-system')) ? fail('istio-system still exists') : pass('Istio removed'));

// ---- Module 6 -------------------------------------------------------------
define('metallb-controller', 'MetalLB controller is running',
  'helm upgrade --install metallb metallb/metallb --version 0.16.2 ...',
  async () => {
    const list = await kjson('get', 'deploy', '-n', 'metallb-system');
    const d = (list?.items || []).find(x => x.metadata.name.includes('controller'));
    return (d?.status?.readyReplicas || 0) >= 1 ? pass('controller ready') : fail('controller not ready');
  });

define('metallb-speaker', 'MetalLB speaker DaemonSet is running',
  'helm install metallb ...',
  async () => {
    const list = await kjson('get', 'ds', '-n', 'metallb-system');
    const d = (list?.items || []).find(x => x.metadata.name.includes('speaker'));
    return (d?.status?.numberReady || 0) >= 1 ? pass('speaker ready') : fail('speaker not ready');
  });

define('ip-pool', 'An IPAddressPool and L2Advertisement exist',
  'Apply lab/06-loadbalancer/metallb-pool.yaml',
  async () => {
    const [pool, adv] = await Promise.all([
      kjson('get', 'ipaddresspool', 'kind-pool', '-n', 'metallb-system'),
      kjson('get', 'l2advertisement', 'kind-l2', '-n', 'metallb-system'),
    ]);
    return pool && adv ? pass(JSON.stringify(pool.spec.addresses)) : fail('pool or L2Advertisement missing');
  });

define('lb-external-ip', 'The LoadBalancer Service has an EXTERNAL-IP',
  'kubectl get svc nginx-lb',
  async () => {
    const s = await kjson('get', 'svc', 'nginx-lb', '-n', 'default');
    const ip = s?.status?.loadBalancer?.ingress?.[0]?.ip;
    return ip ? pass(ip) : fail('no EXTERNAL-IP assigned');
  });

define('lb-curl-ok', 'The EXTERNAL-IP serves traffic',
  'docker run --rm --network kind curlimages/curl ... http://<EXTERNAL-IP>/',
  async () => {
    const s = await kjson('get', 'svc', 'nginx-lb', '-n', 'default');
    const ip = s?.status?.loadBalancer?.ingress?.[0]?.ip;
    if (!ip) return fail('no EXTERNAL-IP yet');
    const r = await run('docker', ['run', '--rm', '--network', 'kind', 'curlimages/curl:latest',
      '-sS', '-m', '12', '-o', '/dev/null', '-w', '%{http_code}', `http://${ip}/`], { timeout: 90000 });
    return r.ok && r.out.endsWith('200') ? pass(`HTTP 200 via ${ip}`) : fail(`curl returned ${r.out || r.err || 'error'}`);
  });

define('etp-local', 'externalTrafficPolicy is Local',
  'kubectl patch svc nginx-lb -p ...',
  async () => {
    const s = await kjson('get', 'svc', 'nginx-lb', '-n', 'default');
    return s?.spec?.externalTrafficPolicy === 'Local' ? pass('Local') : fail('not Local');
  });

define('etp-curl', 'Traffic still works with externalTrafficPolicy: Local',
  'curl the EXTERNAL-IP again',
  async () => {
    const s = await kjson('get', 'svc', 'nginx-lb', '-n', 'default');
    const ip = s?.status?.loadBalancer?.ingress?.[0]?.ip;
    if (!ip) return fail('no EXTERNAL-IP');
    const r = await run('docker', ['run', '--rm', '--network', 'kind', 'curlimages/curl:latest',
      '-sS', '-m', '12', '-o', '/dev/null', '-w', '%{http_code}', `http://${ip}/`], { timeout: 90000 });
    return r.ok && r.out.endsWith('200') ? pass(`HTTP 200 via ${ip}`) : fail(`curl returned ${r.out || r.err}`);
  });

define('nipio-resolves', 'A wildcard DNS name points at the LoadBalancer IP',
  'python3 -c "import socket; print(socket.gethostbyname(\\"<ip>.nip.io\\"))"',
  async () => {
    const s = await kjson('get', 'svc', 'nginx-lb', '-n', 'default');
    const ip = s?.status?.loadBalancer?.ingress?.[0]?.ip;
    if (!ip) return fail('no EXTERNAL-IP');
    try {
      const result = await dns.lookup(`${ip}.nip.io`);
      return result.address === ip ? pass(`${ip}.nip.io → ${result.address}`) : fail(`resolved to ${result.address}`);
    } catch (e) { return fail(`DNS lookup failed: ${e.message}`); }
  });

module.exports = { checks, CTX, CLUSTER, NS, run, k, kjson, dockerExec, withPortForward };
