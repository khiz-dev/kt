'use strict';

/**
 * The course. One source of truth for the CLI menus, guided steps and checks.
 * `cmd` strings are executed by the learner (or by pressing Enter in guided mode).
 */

const modules = [
  // ---------------------------------------------------------------- 0 -----
  {
    id: 'm0', title: 'Bootcamp: nodes, CNI and the playground',
    subtitle: 'Before you can debug a packet, you must know where it lives.',
    lessons: [
      {
        id: 'boot', title: 'Meet your cluster', min: 4,
        checks: ['ctx', 'nodes-ready', 'cilium-ready'],
        concept: [
          'You have a `kind` cluster: real Kubernetes components running inside Docker containers.',
          'One control-plane node runs the API server, scheduler and controller-manager. Two worker nodes run your pods.',
          'Three nodes matter for networking: cross-node pod traffic has to leave one Docker container and enter another. That is the CNI\'s job.',
          'This course never touches your default kubectl context. Every command is pinned to `kind-k8s-net-lab`.',
        ],
        diagram: `
   Mac / host
   ┌───────────────────────────────────────────────┐
   │  kubectl --context kind-k8s-net-lab  ──┐      │
   └────────────────────────────────────────┼──────┘
                                            │ API :6443
   ┌────────────────────────────────────────▼──────┐
   │  Docker network "kind"  192.168.97.0/24         │
   │  ┌──────────────┐ ┌──────────┐ ┌──────────┐  │
   │  │ control-plane│ │ worker   │ │ worker2  │  │
   │  └──────────────┘ └──────────┘ └──────────┘  │
   └───────────────────────────────────────────────┘`,
        steps: [
          { title: 'Look at the nodes', cmd: 'kubectl --context kind-k8s-net-lab get nodes -o wide' },
          { title: 'See every system pod', cmd: 'kubectl --context kind-k8s-net-lab get pods -A' },
        ],
        task: 'Confirm you are on the local cluster, all 3 nodes are Ready, and the Cilium agent is running on each node.',
        hint: 'The bootstrap script created the cluster for you. If nodes are NotReady, Cilium has not finished starting — wait a few seconds and verify again.',
        solution: ['kubectl --context kind-k8s-net-lab get nodes', 'kubectl --context kind-k8s-net-lab -n kube-system rollout status ds/cilium'],
        takeaway: 'A Kubernetes "node" here is a container. Pod networking is a bridge between these containers.',
      },
      {
        id: 'cni', title: 'CNI: who gives a pod an IP?', min: 6,
        checks: ['cilium-ipam', 'cilium-kubeproxy', 'cilium-lbipam'],
        concept: [
          'Kubernetes does not implement pod networking itself. It calls a CNI plugin when a pod is created.',
          'kind\'s default plugin, **kindnet**, does *not* enforce NetworkPolicy. We disabled it and installed **Cilium**, which does.',
          'Cilium is configured with `ipam.mode=kubernetes`: it takes each node\'s `spec.podCIDR` slice from `10.244.0.0/16`.',
          'We deliberately kept `kubeProxyReplacement=false`. That lets you watch classic kube-proxy iptables NAT in Module 1 before seeing eBPF later.',
          'We also set `defaultLBServiceIPAM=none` so Cilium will not fight MetalLB in Module 6.',
        ],
        diagram: `
   Pod A (10.244.0.12)              Pod B (10.244.1.8)
        │                                  │
    veth pair                          veth pair
        │                                  │
   cni0 / cilium_host                cni0 / cilium_host
        └──────── Cilium eBPF ─────────────┘
                 (cross-node tunnel)`,
        steps: [
          { title: 'Inspect Cilium settings', cmd: 'helm get values cilium -n kube-system -o yaml --kube-context kind-k8s-net-lab' },
          { title: 'Inspect Cilium from inside its agent', cmd: 'kubectl --context kind-k8s-net-lab -n kube-system exec ds/cilium -- cilium status --brief' },
          { title: 'See the pod CIDR of each node', cmd: 'kubectl --context kind-k8s-net-lab get nodes -o jsonpath="{range .items[*]}{.metadata.name}: {.spec.podCIDR}{\'\\n\'}{end}"' },
        ],
        task: 'Verify Cilium is using Kubernetes IPAM, kube-proxy replacement is off, and Cilium LB-IPAM is off.',
        hint: 'All three answers are in `helm get values cilium -n kube-system -o yaml`. Look for `ipam.mode`, `kubeProxyReplacement` and `defaultLBServiceIPAM`.',
        solution: ['helm get values cilium -n kube-system -o yaml --kube-context kind-k8s-net-lab'],
        takeaway: 'CNI gives pods IPs and makes cross-node delivery work. Without a policy-capable CNI, NetworkPolicy is silently ignored.',
      },
      {
        id: 'apps', title: 'Deploy the playground', min: 5,
        checks: ['ns-net-lab', 'web-ready', 'api-ready', 'client-ready', 'svc-clusterip'],
        concept: [
          'Every lesson uses the same small set of pods, so you can compare behaviour instead of learning new apps each time.',
          '`web` is nginx. `api` is a tiny HTTP echo server that answers `api-v1`. `client` is a pod with `curl` and `nslookup` for experiments.',
          'Each pod gets a label. Labels are how Services and NetworkPolicies find pods — they are the glue of Kubernetes networking.',
        ],
        diagram: `
   namespace net-lab
   ┌──────────────────────────────────────────────┐
   │  ┌────────┐   ┌────────┐   ┌──────────┐     │
   │  │  web   │   │  api   │   │  client  │     │
   │  │app=web │   │app=api │   │app=client│     │
   │  └───┬────┘   └───┬────┘   └──────────┘     │
   │      │            │                        │
   │   svc/web      svc/api  (ClusterIP)        │
   └──────────────────────────────────────────────┘`,
        steps: [
          { title: 'Read the manifest first', cmd: 'cat lab/00-foundations/apps.yaml' },
          { title: 'Apply it', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/00-foundations/apps.yaml' },
          { title: 'Watch the pods come up', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab get pods -o wide -w' },
        ],
        task: 'Create namespace net-lab with the web, api and client workloads and their ClusterIP Services.',
        hint: 'The manifest is at `lab/00-foundations/apps.yaml`. Run it from the project root (`k8s-net-lab`).',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/00-foundations/apps.yaml'],
        takeaway: 'Services select pods by label; policies select pods by label. Get comfortable with labels now.',
      },
    ],
  },

  // ---------------------------------------------------------------- 1 -----
  {
    id: 'm1', title: 'Pods, Services & DNS',
    subtitle: 'The plumbing every other feature stands on.',
    lessons: [
      {
        id: 'pod-ips', title: 'Pod IPs are disposable', min: 5,
        checks: ['pod-ip-cidr', 'endpointslice'],
        concept: [
          'Every pod gets its own IP from the CNI, inside `10.244.0.0/16`. No NAT between pods — pod A can dial pod B directly.',
          'Those IPs are meaningless to anything outside the cluster, and they disappear when the pod dies.',
          'A Service tracks the live pod IPs in **EndpointSlices**. That object is the bridge between a stable name and moving targets.',
        ],
        steps: [
          { title: 'Pod IPs and which node they landed on', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab get pods -o wide' },
          { title: 'The live endpoints behind svc/api', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab get endpointslice -l kubernetes.io/service-name=api -o yaml' },
          { title: 'Delete a pod and watch its IP change', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab delete pod -l app=api' },
        ],
        task: 'Observe pod IPs in the 10.244/16 range and confirm an EndpointSlice exists for svc/api.',
        hint: 'If you deleted the api pod, wait for the Deployment to replace it before verifying.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/00-foundations/apps.yaml'],
        takeaway: 'Never hardcode a pod IP. Talk to a Service.',
      },
      {
        id: 'clusterip', title: 'A Service is a stable lie', min: 5,
        checks: ['svc-ip-range', 'curl-via-service'],
        concept: [
          'A ClusterIP is a **virtual IP**. No interface owns it, no pod listens on it. It exists only as rules in every node\'s network stack.',
          'Kubernetes allocates it from `--service-cluster-ip-range=10.96.0.0/16` and it stays the same for the Service\'s whole life.',
          'Dial that IP and the node rewrites the destination to a real pod IP. The client never knows.',
        ],
        diagram: `
   client ──► 10.96.45.17:80 (virtual)
                     │  DNAT
                     ▼
              10.244.1.8:8080 (real pod)`,
        steps: [
          { title: 'See the virtual IPs', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab get svc' },
          { title: 'Describe where traffic goes', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab describe svc api' },
          { title: 'Use it for real', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s http://api.net-lab.svc.cluster.local' },
        ],
        task: 'Confirm ClusterIPs are in 10.96.0.0/16 and the client can curl the api Service by name.',
        hint: 'If the curl fails, check that the api Deployment is Ready: `kubectl -n net-lab get pods`.',
        solution: ['kubectl --context kind-k8s-net-lab -n net-lab rollout status deploy/api'],
        takeaway: 'ClusterIP = stable virtual address + DNAT to changing pod IPs.',
      },
      {
        id: 'kubeproxy', title: 'kube-proxy writes the rules', min: 6,
        checks: ['iptables-kube-svc'],
        concept: [
          'Who turns a ClusterIP into a DNAT rule? **kube-proxy**, a pod on every node that watches Services and EndpointSlices.',
          'In our cluster it uses `iptables` mode, so the rules are literally in the nat table of each node.',
          'Chains named `KUBE-SVC-...` pick an endpoint; `KUBE-SEP-...` chains do the DNAT. Random selection gives you crude load balancing.',
          'Cilium *could* replace kube-proxy with eBPF (faster, no iptables), but we pinned it off so you can see the classic mechanism first.',
        ],
        steps: [
          { title: 'Find the kube-proxy pods', cmd: 'kubectl --context kind-k8s-net-lab -n kube-system get ds kube-proxy' },
          { title: 'Look at the NAT rules on a node', cmd: 'docker exec k8s-net-lab-control-plane sh -c "iptables-save -t nat | grep KUBE-SVC | head -20"' },
          { title: 'Look at the endpoint DNAT chains', cmd: 'docker exec k8s-net-lab-control-plane sh -c "iptables-save -t nat | grep KUBE-SEP | head -20"' },
        ],
        task: 'Confirm kube-proxy has programmed KUBE-SVC chains on the control-plane node.',
        hint: 'The rules live inside the Docker container, not on your Mac. Use `docker exec k8s-net-lab-control-plane ...`.',
        solution: ['docker exec k8s-net-lab-control-plane sh -c "iptables-save -t nat | grep KUBE-SVC"'],
        takeaway: 'Services are implemented by packet rules, not by a process listening on the ClusterIP.',
      },
      {
        id: 'dns', title: 'DNS: the phone book of the cluster', min: 7,
        checks: ['coredns-ready', 'dns-api-resolves', 'dns-short-name'],
        concept: [
          'Humans want `api`; kube-proxy wants an IP. **CoreDNS** bridges that gap.',
          'Every Service gets `name.namespace.svc.cluster.local`. A pod\'s `/etc/resolv.conf` has `search net-lab.svc.cluster.local svc.cluster.local cluster.local`, so `api` is expanded automatically.',
          'CoreDNS does not read iptables — it answers from the Kubernetes API. It also forwards external names to your upstream DNS.',
          'This matters later: a default-deny egress policy that blocks UDP 53 will break service discovery before it breaks anything else.',
        ],
        diagram: `
   curl http://api
        │
        ▼  /etc/resolv.conf  search net-lab.svc.cluster.local
   CoreDNS (10.96.0.10) ──► api.net-lab.svc.cluster.local → 10.96.x.y
        │
        ▼  kube-proxy DNAT
   api pod`,
        steps: [
          { title: 'Check CoreDNS', cmd: 'kubectl --context kind-k8s-net-lab -n kube-system get pods -l k8s-app=kube-dns' },
          { title: 'See the resolver config in a pod', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- cat /etc/resolv.conf' },
          { title: 'Resolve the full name', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- nslookup api.net-lab.svc.cluster.local' },
          { title: 'Resolve the short name', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- nslookup api' },
        ],
        task: 'CoreDNS must be running, the FQDN must resolve to the api ClusterIP, and the short name api must resolve too.',
        hint: 'Compare the nslookup answer with `kubectl -n net-lab get svc api`. They must match exactly.',
        solution: ['kubectl --context kind-k8s-net-lab -n net-lab exec client -- nslookup api'],
        takeaway: 'DNS returns the ClusterIP. kube-proxy turns that IP into a pod IP.',
      },
      {
        id: 'headless-nodeport', title: 'Headless Services & the first doorway', min: 7,
        checks: ['headless-svc', 'headless-dns', 'nodeport-svc', 'nodeport-curl'],
        concept: [
          'Set `clusterIP: None` and CoreDNS returns **pod IPs directly** instead of a virtual IP. Stateful apps (Databases, Kafka) use this so clients can address a specific replica.',
          'A `NodePort` Service is the simplest way in from outside: it opens a fixed port (30000–32767) on every node. kube-proxy forwards it to the Service.',
          'On kind we mapped host port 30081 to container port 30081 at cluster creation time. That is why `localhost:30081` reaches the cluster.',
          'NodePort is a blunt instrument — no hostnames, no paths, no TLS. Module 3 fixes that with Gateway API.',
        ],
        steps: [
          { title: 'Apply headless + NodePort Services', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/01-services/headless.yaml -f lab/01-services/nodeport.yaml' },
          { title: 'Headless DNS returns pod IPs', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- nslookup api-headless.net-lab.svc.cluster.local' },
          { title: 'Reach the NodePort from your Mac', cmd: 'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:30081' },
        ],
        task: 'Create the headless Service and the NodePort on 30081; verify both DNS behaviour and host reachability.',
        hint: 'Both manifests are in `lab/01-services/`. The host port mapping already exists — you only need the Service.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/01-services/headless.yaml -f lab/01-services/nodeport.yaml'],
        takeaway: 'Headless = direct pod discovery. NodePort = raw external access, but no L7 intelligence.',
      },
    ],
  },

  // ---------------------------------------------------------------- 2 -----
  {
    id: 'm2', title: 'NetworkPolicy: zero-trust inside the cluster',
    subtitle: 'Default allow is the problem. Policies are the fix.',
    lessons: [
      {
        id: 'np-default-allow', title: 'Everyone talks to everyone', min: 4,
        checks: ['np-baseline-curl'],
        concept: [
          'With no NetworkPolicy, every pod can reach every other pod on every port. There is no implicit firewall.',
          'This is intentional — Kubernetes does not want to break applications on upgrade — but it means one compromised pod can scan the whole cluster.',
          'We will prove the baseline first, then change it and watch the exact same curl fail.',
        ],
        steps: [
          { title: 'Make sure there are no policies', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab delete networkpolicy --all --ignore-not-found' },
          { title: 'The baseline call', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s -o /dev/null -w "%{http_code}\\n" http://web' },
        ],
        task: 'Confirm the client can currently reach web (HTTP 200). This is your control measurement.',
        hint: 'Previous lessons did not create any policies, so this should already pass.',
        solution: ['kubectl --context kind-k8s-net-lab -n net-lab delete networkpolicy --all --ignore-not-found'],
        takeaway: 'Always measure the baseline before adding a control.',
      },
      {
        id: 'np-deny', title: 'Default deny ingress', min: 6,
        checks: ['np-deny-exists', 'np-deny-blocks'],
        concept: [
          'A NetworkPolicy with an **empty podSelector** and `policyTypes: [Ingress]` selects every pod in the namespace and allows no ingress.',
          'Once any policy selects a pod, that pod is isolated for that direction. Unselected pods stay wide open.',
          'Cilium compiles this into eBPF rules attached to the pod\'s network interface — the drop happens before the packet reaches the app.',
        ],
        diagram: `
   before:  client ─────────────► web   ✅
   after:   client ──── ✕ ──────► web   ❌
                    (Cilium eBPF drop)`,
        steps: [
          { title: 'Read the policy', cmd: 'cat lab/02-networkpolicy/deny-ingress.yaml' },
          { title: 'Apply it', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/deny-ingress.yaml' },
          { title: 'Try the same curl', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -sS -m 4 -o /dev/null -w "%{http_code}\\n" http://web || echo BLOCKED' },
        ],
        task: 'Create a default-deny ingress policy in net-lab and prove the client is blocked.',
        hint: 'An empty `podSelector: {}` means "all pods in this namespace". With no `ingress:` list, nothing is allowed.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/deny-ingress.yaml'],
        takeaway: 'Isolation is opt-in per direction, per pod, triggered by the first policy that selects it.',
      },
      {
        id: 'np-selectors', title: 'Allow by pod and namespace selector', min: 9,
        checks: ['np-allow-pod-exists', 'np-allow-pod-curl', 'np-ns-port-exists', 'np-ns-port-allowed', 'np-ns-port-denied'],
        concept: [
          'An `ingress.from.podSelector` allows only pods with matching labels — in the same namespace by default.',
          'An `ingress.from.namespaceSelector` selects *namespaces* by label. Combine both to say "pods labelled X in namespaces labelled Y".',
          'Add `ports:` to restrict the destination port. A policy is a whitelist: anything not listed is denied.',
          'Our `trusted` namespace is labelled `team=trusted`; `untrusted` has no such label. The evil pod in untrusted must stay blocked.',
        ],
        diagram: `
   client (app=client) ───────────► web ✅  podSelector
   trusted/trusted (ns team=trusted) ► web ✅  namespaceSelector
   untrusted/evil ────────────────► web ❌`,
        steps: [
          { title: 'Allow the client pod', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/allow-client.yaml' },
          { title: 'Allow the trusted namespace on port 80', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/allow-namespace-port.yaml' },
          { title: 'Create the comparison pods', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/peers.yaml' },
          { title: 'Test allowed and denied callers', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s -o /dev/null -w "%{http_code}\\n" http://web' },
        ],
        task: 'client and trusted/trusted must reach web on port 80; untrusted/evil must not.',
        hint: 'Three manifests: `allow-client.yaml`, `allow-namespace-port.yaml`, and `peers.yaml` in `lab/02-networkpolicy/`.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/allow-client.yaml -f lab/02-networkpolicy/allow-namespace-port.yaml -f lab/02-networkpolicy/peers.yaml'],
        takeaway: 'Policies are allowlists built from labels. Narrow selectors = smaller blast radius.',
      },
      {
        id: 'np-egress', title: 'Egress and the DNS trap', min: 8,
        checks: ['np-egress-exists', 'np-egress-dns-ok', 'np-egress-external-blocked'],
        concept: [
          'Ingress rules control who can call you. **Egress** rules control where you can call.',
          'The classic mistake: apply `policyTypes: [Egress]` with an empty egress list, and suddenly `curl api` fails — even to Services in the same namespace. DNS is UDP/TCP 53 and is now blocked too.',
          'The fix is an explicit allow rule to `k8s-app=kube-dns` in `kube-system` on port 53. Then allow only the external destinations you actually need.',
          'With Istio later, sidecars add a second layer: Envoy resolves DNS itself, so egress needs a `ServiceEntry` too.',
        ],
        steps: [
          { title: 'Apply default-deny egress + DNS escape hatch', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/egress-dns.yaml' },
          { title: 'DNS still works', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- nslookup api.net-lab.svc.cluster.local' },
          { title: 'External internet is denied', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -sS -m 5 -o /dev/null -w "%{http_code}\\n" https://example.com || echo BLOCKED' },
        ],
        task: 'Deny all egress except DNS to kube-dns. Internal DNS must work; example.com must be blocked.',
        hint: 'Read `lab/02-networkpolicy/egress-dns.yaml`. It has an empty egress policy plus a second policy with `toEndpoints` for kube-dns.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/egress-dns.yaml'],
        takeaway: 'If a suddenly-restricted pod "can\'t resolve anything", you forgot egress DNS.',
      },
      {
        id: 'np-l7', title: 'Layer 7 with CiliumNetworkPolicy', min: 8,
        checks: ['cilium-l7-exists', 'cilium-l7-public', 'cilium-l7-admin-blocked'],
        concept: [
          'Standard Kubernetes NetworkPolicy only sees IP + port (L3/L4). It cannot say "allow GET /public but deny GET /admin".',
          'Cilium extends it with `CiliumNetworkPolicy`, which can parse HTTP at the socket level using an embedded Envoy proxy.',
          'You are already meeting Envoy here — it appears inside Cilium before we install Envoy Gateway in Module 3 or Istio in Module 5.',
          'The `l7` pod serves `/public` and `/admin`. The policy allows only GET /public; Cilium answers 403 for /admin.',
        ],
        steps: [
          { title: 'Remove the egress policies from the last lesson', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab delete networkpolicy egress-deny egress-dns --ignore-not-found' },
          { title: 'Apply the L7 app and policy', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/l7.yaml' },
          { title: 'Allowed', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s http://l7/public' },
          { title: 'Denied', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s -o /dev/null -w "%{http_code}\\n" http://l7/admin' },
        ],
        task: 'GET /public returns the word public; GET /admin returns 403.',
        hint: 'The deny rule is in `lab/02-networkpolicy/l7.yaml`. Make sure the egress policies from lesson 2.4 are deleted, or the client cannot reach l7 at all.',
        solution: ['kubectl --context kind-k8s-net-lab -n net-lab delete networkpolicy --all', 'kubectl --context kind-k8s-net-lab apply -f lab/02-networkpolicy/l7.yaml'],
        takeaway: 'L7 policy = application-aware firewall. Implementations differ; standard NetworkPolicy stays portable.',
      },
    ],
  },

  // ---------------------------------------------------------------- 3 -----
  {
    id: 'm3', title: 'Gateway API: Kubernetes-native L7 routing',
    subtitle: 'Hostnames, paths, and separation of concerns.',
    lessons: [
      {
        id: 'gateway-crds', title: 'Gateway API: ingress with typed roles', min: 5,
        checks: ['gw-crd-standard'],
        concept: [
          'The old `Ingress` object was a single blob with vendor-specific annotations. Gateway API splits it into roles:',
          '**GatewayClass** = infrastructure class (cluster admin). **Gateway** = a listener/load balancer instance (operator). **HTTPRoute** = routing rules (app team).',
          'Gateway API is a set of CRDs, not an implementation. Installing the CRDs gives you the vocabulary; you still need a controller.',
          'We use the `standard` channel v1.7.0 — the stable, portable subset.',
        ],
        steps: [
          { title: 'Install the standard CRDs', cmd: 'kubectl --context kind-k8s-net-lab apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml' },
          { title: 'List the new resources', cmd: 'kubectl --context kind-k8s-net-lab api-resources --api-group=gateway.networking.k8s.io' },
        ],
        task: 'GatewayClass, Gateway and HTTPRoute CRDs must exist, from the v1.7.0 standard bundle.',
        hint: 'Use the URL in the step above. `kubectl get crd | grep gateway` should show several.',
        solution: ['kubectl --context kind-k8s-net-lab apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml'],
        takeaway: 'Gateway API is an API contract. You choose the data plane separately.',
      },
      {
        id: 'envoy-gateway', title: 'Install the Gateway implementation', min: 7,
        checks: ['eg-deploy-ready'],
        concept: [
          '**Envoy Gateway** is a control plane that reads Gateway API objects and programs Envoy proxies. It is the official Envoy implementation of Gateway API.',
          'We install v1.9.4: v1.10 requires Kubernetes 1.34+, and this lab runs 1.33.',
          'We install CRDs from a separate OCI chart so Envoy Gateway does not overwrite the Gateway API CRDs you just installed.',
          'Only 1 replica and tiny resource requests — this is a laptop lab, not production.',
        ],
        steps: [
          { title: 'Envoy Gateway CRDs only (rendered, not a Helm release — they exceed the release-secret size limit)', cmd: 'helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm --version v1.9.4 -n envoy-gateway-system --set crds.envoyGateway.enabled=true --set crds.gatewayAPI.enabled=false | kubectl --context kind-k8s-net-lab apply --server-side -f -' },
          { title: 'The controller', cmd: 'helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.4 -n envoy-gateway-system --kube-context kind-k8s-net-lab --set crds.enabled=false --set deployment.replicas=1 --set topologyInjector.enabled=false --set deployment.envoyGateway.resources.requests.cpu=50m --set deployment.envoyGateway.resources.requests.memory=128Mi --set deployment.envoyGateway.resources.limits.memory=512Mi --wait' },
          { title: 'Watch it come up', cmd: 'kubectl --context kind-k8s-net-lab -n envoy-gateway-system get pods -w' },
        ],
        task: 'The envoy-gateway Deployment must be available in envoy-gateway-system.',
        hint: 'Both helm commands are in the steps. The second one needs `--wait` to finish.',
        solution: ['helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.4 -n envoy-gateway-system --kube-context kind-k8s-net-lab --set crds.enabled=false --set deployment.replicas=1 --set topologyInjector.enabled=false --wait'],
        takeaway: 'Control plane reads desired state; data plane (Envoy) forwards packets. Keep that split in your head.',
      },
      {
        id: 'gateway-route', title: 'Gateway, GatewayClass and HTTPRoute', min: 10,
        checks: ['eg-proxy-config', 'gwclass-accepted', 'gateway-programmed', 'gateway-nodeport', 'route-accepted', 'route-path-v1', 'route-path-v2'],
        concept: [
          'The **EnvoyProxy** CR tells Envoy Gateway how to build the data plane. Here we force a NodePort Service with `nodePort: 30080` and small resource limits.',
          '**GatewayClass** points at the controller with the exact name `gateway.envoyproxy.io/gatewayclass-controller`.',
          '**Gateway** declares a listener on port 80 for HTTP. **HTTPRoute** attaches to it and matches `Host: lab.local` plus paths `/v1` and `/v2`.',
          'Status conditions (`Accepted`, `Programmed`) are how Gateway API tells you whether the controller understood your intent. Always check them.',
        ],
        diagram: `
   curl -H "Host: lab.local" localhost:30080/v1
        │
        ▼  NodePort 30080
   ┌─────────────┐
   │  Envoy pod  │  HTTPRoute rules
   └──────┬──────┘
      /v1 │ /v2
      ▼   ▼
    v1    v2  (http-echo pods)`,
        steps: [
          { title: 'Read the full manifest', cmd: 'cat lab/03-gateway/gateway.yaml' },
          { title: 'Apply it', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/03-gateway/gateway.yaml' },
          { title: 'Check the statuses', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab get gateway,httproute -o wide' },
          { title: 'Call route /v1', cmd: 'curl -s -H "Host: lab.local" http://127.0.0.1:30080/v1' },
          { title: 'Call route /v2', cmd: 'curl -s -H "Host: lab.local" http://127.0.0.1:30080/v2' },
        ],
        task: 'GatewayClass and Gateway must be Accepted/Programmed, HTTPRoute Accepted, and both paths must return the right version.',
        hint: 'If status is not Accepted, check `kubectl -n envoy-gateway-system logs deploy/envoy-gateway`. Host header must be `lab.local`.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/03-gateway/gateway.yaml'],
        takeaway: 'Status conditions are the API\'s feedback loop. Read them before debugging packets.',
      },
      {
        id: 'refgrant', title: 'Cross-namespace routing safely', min: 7,
        checks: ['refgrant-exists', 'crossns-route-accepted', 'crossns-curl'],
        concept: [
          'By default an HTTPRoute can only send traffic to Services in its **own namespace**. That is a security boundary, not a bug.',
          'To cross it, the app team creates a **ReferenceGrant** in the *target* namespace, explicitly allowing routes from a source namespace.',
          'This is much safer than Ingress annotations that silently reach anywhere.',
          'Our route in namespace `other` uses `Host: other.local` and points at `web` in `net-lab`. Without the grant it is rejected.',
        ],
        steps: [
          { title: 'Apply the namespace, route and grant', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/03-gateway/refgrant.yaml' },
          { title: 'See the rejected/attached status', cmd: 'kubectl --context kind-k8s-net-lab -n other get httproute cross -o yaml' },
          { title: 'Call it', cmd: 'curl -s -i -H "Host: other.local" http://127.0.0.1:30080/ | head -20' },
        ],
        task: 'The cross-namespace HTTPRoute must be Accepted and serve traffic through the gateway.',
        hint: 'The grant lives in `net-lab`, NOT in `other`. That is the whole point.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/03-gateway/refgrant.yaml'],
        takeaway: 'Cross-namespace access requires an explicit grant in the namespace being accessed.',
      },
    ],
  },

  // ---------------------------------------------------------------- 4 -----
  {
    id: 'm4', title: 'Envoy: the proxy underneath',
    subtitle: 'Listeners, routes, clusters, xDS — now stripped bare.',
    lessons: [
      {
        id: 'envoy-static', title: 'Envoy without Kubernetes', min: 8,
        checks: ['standalone-envoy-ready', 'standalone-envoy-route'],
        concept: [
          'Envoy is just a process with a config: **listeners** (where it accepts connections), **routes** (where requests go), and **clusters** (upstream groups with endpoints).',
          'Service discovery is optional. In a static bootstrap all endpoints are written by hand. In a mesh they arrive over **xDS** from a control plane.',
          'Our standalone Envoy listens on 8080: `/api` goes to the api Service, `/` goes to web, and admin is on 9901.',
          'This is exactly what Envoy Gateway generated for you in Module 3 — but here you own every line.',
        ],
        diagram: `
   client ──► :8080 listener
                  │ route /api  ──► cluster "api" ──► api pod
                  └ route /     ──► cluster "web" ──► web pod
                  :9901 admin (config_dump, stats)`,
        steps: [
          { title: 'Read the bootstrap config', cmd: 'cat lab/04-envoy/standalone.yaml' },
          { title: 'Apply it', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/04-envoy/standalone.yaml' },
          { title: 'Call through Envoy', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -s http://envoy-standalone:8080/api' },
        ],
        task: 'The standalone Envoy pod must be Ready and /api must proxy to the api echo server.',
        hint: 'The ConfigMap key is `envoy.yaml` and is mounted at `/etc/envoy/envoy.yaml`. Check logs with `kubectl -n net-lab logs -l app=envoy-standalone`.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/04-envoy/standalone.yaml'],
        takeaway: 'Listener → route → cluster → endpoint. Every Envoy-based product is this model plus automation.',
      },
      {
        id: 'envoy-config', title: 'Listeners, routes, clusters, xDS', min: 7,
        checks: ['envoy-listener', 'envoy-cluster'],
        concept: [
          'Envoy\'s admin interface on port 19000 (in Envoy Gateway\'s data plane) exposes `/config_dump`: the fully resolved config after xDS has been applied.',
          'Compare it with your HTTPRoute: the hostname became a virtual host domain, each path match became a route, each backend became a cluster with endpoints.',
          'This is the key insight: Gateway API YAML is *intent*; `config_dump` is the *reality* Envoy is executing.',
          'The verifier port-forwards the Envoy pod for you, but you can do it manually with the step below.',
        ],
        steps: [
          { title: 'Find the data-plane pod', cmd: 'kubectl --context kind-k8s-net-lab -n envoy-gateway-system get pods -l gateway.envoyproxy.io/owning-gateway-name=eg' },
          { title: 'Port-forward its admin port', cmd: 'kubectl --context kind-k8s-net-lab -n envoy-gateway-system port-forward deploy/$(kubectl --context kind-k8s-net-lab -n envoy-gateway-system get deploy -l gateway.envoyproxy.io/owning-gateway-name=eg -o jsonpath="{.items[0].metadata.name}") 19000:19000' },
          { title: 'In another shell, dump it', cmd: 'curl -s http://127.0.0.1:19000/config_dump | jq \'.configs[] | .["@type"]\' | sort -u' },
        ],
        task: 'The Envoy Gateway data plane must expose a listener and clusters in /config_dump.',
        hint: 'The verifier handles port-forwarding itself, so you do not need to keep the step 2 port-forward running.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/03-gateway/gateway.yaml'],
        takeaway: 'Debug Envoy by reading config_dump, not by guessing from the CRDs.',
      },
      {
        id: 'envoy-headers', title: 'Envoy adds superpowers', min: 6,
        checks: ['envoy-attempt-header'],
        concept: [
          'Why put a proxy in front of every service? Because you get cross-cutting features without touching application code.',
          'Retries, timeouts, circuit breaking, health checks, request hedging, header rewriting: all config, no code.',
          'Envoy stamps response headers like `x-envoy-upstream-service-time` and `x-envoy-attempt-count` so you can observe what it did.',
          'Our static config sets `include_attempt_count_in_response: true`, so even a simple request shows the attempt count.',
        ],
        steps: [
          { title: 'See the response headers', cmd: 'kubectl --context kind-k8s-net-lab -n net-lab exec client -- curl -sSI http://envoy-standalone:8080/api' },
          { title: 'See the route config that enables it', cmd: 'grep -n "include_attempt_count" lab/04-envoy/standalone.yaml' },
        ],
        task: 'Envoy must return the x-envoy-attempt-count response header.',
        hint: 'The flag is on the virtual host in the bootstrap ConfigMap: `include_attempt_count_in_response: true`.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/04-envoy/standalone.yaml'],
        takeaway: 'The proxy is the right place for reliability features that every service needs.',
      },
      {
        id: 'envoy-xds', title: 'What Envoy Gateway generated for you', min: 6,
        checks: ['eg-configdump-gateway', 'eg-removed'],
        concept: [
          'Time to connect the dots: find `lab.local` inside the live Envoy config. That string came from your HTTPRoute, delivered over xDS by Envoy Gateway.',
          'Then clean up Envoy Gateway before moving to Istio. Two control planes programming proxies at once is a recipe for confusing labs (and it costs RAM).',
          'Cleanup means uninstalling the Envoy Gateway Helm release and deleting its namespace. The CRDs can stay — Istio does not mind them.',
        ],
        steps: [
          { title: 'Dump config and search for your hostname', cmd: 'curl -s http://127.0.0.1:19000/config_dump | grep -c "lab.local" || true  # after starting the port-forward from lesson 4.2' },
          { title: 'Uninstall Envoy Gateway', cmd: 'helm uninstall eg -n envoy-gateway-system --kube-context kind-k8s-net-lab; kubectl --context kind-k8s-net-lab delete ns envoy-gateway-system --ignore-not-found' },
        ],
        task: 'The Gateway hostname must appear in Envoy config, then Envoy Gateway must be removed.',
        hint: 'Order matters: verify the config dump first, then uninstall — otherwise the check cannot find the proxy.',
        solution: ['helm uninstall eg -n envoy-gateway-system --kube-context kind-k8s-net-lab', 'kubectl --context kind-k8s-net-lab delete ns envoy-gateway-system --ignore-not-found'],
        takeaway: 'Envoy Gateway = Envoy + a control plane that turns Gateway API into xDS.',
      },
    ],
  },

  // ---------------------------------------------------------------- 5 -----
  {
    id: 'm5', title: 'Istio: the mesh moves Envoy into every pod',
    subtitle: 'Same proxy, different topology.',
    lessons: [
      {
        id: 'istio-install', title: 'Istio: a mesh, not just an ingress', min: 8,
        checks: ['istioctl-client', 'istiod-ready', 'istio-crds'],
        concept: [
          'Envoy Gateway puts Envoy at the edge. **Istio** puts an Envoy sidecar next to *every pod*, plus a control plane called **istiod**.',
          'That gives you service-to-service mTLS, traffic policy, telemetry and retries without changing application code.',
          'We put `istioctl` in `bin/` (no sudo) and install the `demo` profile with reduced resources for the laptop.',
          'The egress gateway is disabled and istiod/ingress are capped — enough to learn, small enough to survive 8 GB of Docker memory.',
        ],
        steps: [
          { title: 'Download istioctl 1.32', cmd: 'mkdir -p bin && curl -fsSL -o bin/istioctl.tar.gz https://github.com/istio/istio/releases/download/1.32.0/istioctl-1.32.0-osx-arm64.tar.gz && tar -xzf bin/istioctl.tar.gz -C bin istioctl' },
          { title: 'Check the client', cmd: './bin/istioctl version --remote=false' },
          { title: 'Install Istio (takes a couple of minutes)', cmd: './bin/istioctl install -y --context kind-k8s-net-lab --set profile=demo --set values.pilot.resources.requests.cpu=100m --set values.pilot.resources.requests.memory=256Mi --set values.pilot.resources.limits.memory=512Mi --set "components.egressGateways[0].enabled=false" --set values.gateways.istio-ingressgateway.resources.limits.cpu=500m --set values.gateways.istio-ingressgateway.resources.limits.memory=256Mi' },
          { title: 'Watch istiod', cmd: 'kubectl --context kind-k8s-net-lab -n istio-system get pods -w' },
        ],
        task: 'istioctl 1.32 client works, istiod is running, and Istio CRDs are installed.',
        hint: 'The download command in step 1 is intentionally local (bin/istioctl). If it fails, check your internet connection and that you are on macOS arm64.',
        solution: ['mkdir -p bin && curl -fsSL -o bin/istioctl.tar.gz https://github.com/istio/istio/releases/download/1.32.0/istioctl-1.32.0-osx-arm64.tar.gz && tar -xzf bin/istioctl.tar.gz -C bin istioctl'],
        takeaway: 'Mesh = data plane (sidecars) + control plane (istiod). Traffic policy lives in the control plane.',
      },
      {
        id: 'istio-sidecars', title: 'The sidecar injection trick', min: 7,
        checks: ['ns-injected', 'sidecars-present', 'proxy-synced'],
        concept: [
          'Istio does not rebuild your images. A mutating admission webhook adds an `istio-proxy` to every pod in a labelled namespace. In Istio 1.32 it is a *native sidecar*: a restartable init container that starts before your app and stops after it.',
          'Label the namespace *before* creating pods, or restart the Deployment — existing pods are not retroactively modified.',
          'All traffic enters and leaves through the sidecar via iptables redirection. The app still thinks it is talking directly to the Service.',
          '`istioctl proxy-status` shows whether each sidecar has the config istiod sent it. `SYNCED` is the healthy state.',
        ],
        steps: [
          { title: 'Create the canary app (this also creates the namespace)', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/05-istio/canary.yaml' },
          { title: 'Label the namespace', cmd: 'kubectl --context kind-k8s-net-lab label ns canary istio-injection=enabled --overwrite' },
          { title: 'Restart so existing pods get injected', cmd: 'kubectl --context kind-k8s-net-lab -n canary rollout restart deploy' },
          { title: 'Count containers per pod (istio 1.32 sidecars are restartable init containers)', cmd: 'kubectl --context kind-k8s-net-lab -n canary get pods -o jsonpath="{range .items[*]}{.metadata.name}: containers=[{.spec.containers[*].name}] init=[{.spec.initContainers[*].name}]{\'\\n\'}{end}"' },
          { title: 'Check control-plane sync', cmd: './bin/istioctl proxy-status --context kind-k8s-net-lab' },
        ],
        task: 'canary namespace labelled, demo pods have 2 containers, and proxy-status reports SYNCED.',
        hint: 'Injection happens at pod creation time. Label the namespace, then `kubectl -n canary rollout restart deploy`.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/05-istio/canary.yaml', 'kubectl --context kind-k8s-net-lab label ns canary istio-injection=enabled --overwrite', 'kubectl --context kind-k8s-net-lab -n canary rollout restart deploy'],
        takeaway: 'Injection is admission-time mutation. You changed the pod without changing its YAML.',
      },
      {
        id: 'istio-canary', title: 'Canary traffic splitting', min: 8,
        checks: ['vs-exists', 'dr-subsets', 'canary-split'],
        concept: [
          'A **DestinationRule** defines subsets: groups of pods with a shared label (`version: v1`, `version: v2`).',
          'A **VirtualService** sends traffic to those subsets with weights. 90/10 means one in ten requests hits the canary.',
          'The sidecar does the splitting per request — no changes to your Service or your code.',
          'Our verifier fires 40 curl requests so you can see a real distribution, not just YAML that looks right.',
        ],
        diagram: `
              client sidecar
                    │ 90% ─► subset v1 (app=demo,version=v1)
                    │ 10% ─► subset v2 (app=demo,version=v2)`,
        steps: [
          { title: 'Apply the canary manifests', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/05-istio/canary.yaml' },
          { title: 'Inspect the rules', cmd: 'kubectl --context kind-k8s-net-lab -n canary get virtualservice,destinationrule -o yaml' },
          { title: 'Send 40 requests', cmd: 'kubectl --context kind-k8s-net-lab -n canary exec client -- sh -c "for i in $(seq 1 40); do curl -s http://demo.canary.svc.cluster.local; echo; done" | sort | uniq -c' },
        ],
        task: 'DestinationRule subsets and a 2-route VirtualService exist, and traffic really reaches both versions.',
        hint: 'The client pod is in the canary manifest. Make sure it was recreated with a sidecar if you labelled the namespace late.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/05-istio/canary.yaml', 'kubectl --context kind-k8s-net-lab -n canary rollout restart deploy'],
        takeaway: 'Weighted routing is a control-plane instruction executed by every sidecar independently.',
      },
      {
        id: 'istio-mtls', title: 'mTLS without touching your app', min: 7,
        checks: ['peer-auth-strict', 'mtls-curl'],
        concept: [
          'Plain HTTP between pods is readable by anyone on the node network. **PeerAuthentication** with `STRICT` makes Envoy require an authenticated TLS handshake from another sidecar.',
          'The workload speaks plaintext to its own sidecar; the sidecars encrypt the hop. Your application code is unchanged.',
          'This is why sidecars matter: identity is attached to the workload, and certificate rotation is handled by istiod.',
          'Traffic from non-injected pods will now be rejected — that is the point.',
        ],
        steps: [
          { title: 'Apply STRICT mTLS', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/05-istio/mtls.yaml' },
          { title: 'The client is injected, so this still works', cmd: 'kubectl --context kind-k8s-net-lab -n canary exec client -- curl -s -o /dev/null -w "%{http_code}\\n" http://demo.canary.svc.cluster.local' },
          { title: 'Ask Istio what it thinks', cmd: './bin/istioctl x describe pod -l app=demo -n canary --context kind-k8s-net-lab' },
        ],
        task: 'PeerAuthentication mode STRICT exists and traffic from an injected client still returns HTTP 200.',
        hint: 'Do not apply this to namespace net-lab — its pods are not injected and would break.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/05-istio/mtls.yaml'],
        takeaway: 'mTLS at the mesh layer gives you identity and encryption without application changes.',
      },
      {
        id: 'istio-routing', title: 'Header-based routing + cleanup', min: 7,
        checks: ['vs-header-match', 'header-route-v2', 'istio-removed'],
        concept: [
          'Weights are not the only match condition. A VirtualService can inspect headers, query params, paths, methods and source labels.',
          'Our new rule sends `x-canary: true` straight to v2 — a classic internal beta-test pattern.',
          'Then we remove Istio entirely, because Module 6 is about the other edge of the network: the LoadBalancer.',
          '`istioctl uninstall --purge -y` removes the control plane; the namespace deletion finishes the job.',
        ],
        steps: [
          { title: 'Apply the header rule', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/05-istio/header-route.yaml' },
          { title: 'Force v2', cmd: 'kubectl --context kind-k8s-net-lab -n canary exec client -- curl -s -H "x-canary: true" http://demo.canary.svc.cluster.local' },
          { title: 'Uninstall Istio', cmd: './bin/istioctl uninstall --purge -y --context kind-k8s-net-lab; kubectl --context kind-k8s-net-lab delete ns istio-system --ignore-not-found' },
        ],
        task: 'Header routing works, then Istio is fully removed before moving on.',
        hint: 'Verify the header route BEFORE uninstalling. Once istiod is gone, the VirtualService is inert; the verifier then treats those two checks as already demonstrated.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/05-istio/header-route.yaml'],
        takeaway: 'Route on request attributes for targeted tests; use weights for gradual rollout.',
      },
    ],
  },

  // ---------------------------------------------------------------- 6 -----
  {
    id: 'm6', title: 'LoadBalancer: the outside edge',
    subtitle: 'Give the cluster an address your Mac can dial.',
    lessons: [
      {
        id: 'metallb', title: 'LoadBalancer on bare metal', min: 7,
        checks: ['metallb-controller', 'metallb-speaker', 'ip-pool'],
        concept: [
          'On AWS/GKE, `type: LoadBalancer` asks the cloud API for a real load balancer. kind has no cloud provider, so nothing assigns an IP.',
          '**MetalLB** fills that gap with two components: a **controller** that assigns IPs from a pool, and **speakers** that announce them (ARP here).',
          'The pool must be an unused slice of the Docker `kind` network. Our manifest uses `192.168.97.200-220`; check yours with `docker network inspect kind`.',
          'Cilium\'s own LB-IPAM was disabled in bootstrap precisely so MetalLB can own this job.',
        ],
        steps: [
          { title: 'Check the kind subnet (ignore the IPv6 range)', cmd: 'docker network inspect kind -f "{{range .IPAM.Config}}{{println .Subnet}}{{end}}" | grep -v :' },
          { title: 'Install MetalLB', cmd: 'helm repo add metallb https://metallb.github.io/metallb >/dev/null 2>&1 || true; helm upgrade --install metallb metallb/metallb --version 0.16.2 -n metallb-system --create-namespace --kube-context kind-k8s-net-lab --set frrk8s.enabled=false --wait' },
          { title: 'Configure the pool', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/06-loadbalancer/metallb-pool.yaml' },
        ],
        task: 'MetalLB controller and speaker are ready, and an IPAddressPool + L2Advertisement exist.',
        hint: 'If your kind network is not 192.168.97.0/24, edit the addresses in `lab/06-loadbalancer/metallb-pool.yaml`.',
        solution: ['helm upgrade --install metallb metallb/metallb --version 0.16.2 -n metallb-system --create-namespace --kube-context kind-k8s-net-lab --set frrk8s.enabled=false --wait', 'kubectl --context kind-k8s-net-lab apply -f lab/06-loadbalancer/metallb-pool.yaml'],
        takeaway: 'A LoadBalancer IP without a provider is just a Service stuck in <pending>.',
      },
      {
        id: 'lb-service', title: 'Your first EXTERNAL-IP', min: 6,
        checks: ['lb-external-ip', 'lb-curl-ok'],
        concept: [
          'Now `type: LoadBalancer` works: MetalLB picks an address and its speakers ARP for it inside the Docker network.',
          'Kubernetes still creates a NodePort underneath. The LB forwards to the NodePort, and kube-proxy forwards to the pod — the whole chain you learned in Modules 0–1.',
          'On macOS, your host has no direct route into the kind bridge, so we verify from a container attached to `--network kind`.',
          'Look at the speaker logs to see the ARP announcements — that is the "load balancer" on a L2 network.',
          'The manifest runs three nginx pods, one per worker/control-plane node. That matters in the next lesson when traffic policy becomes `Local`.',
        ],
        diagram: `
   browser/container ──► 192.168.97.200:80  (EXTERNAL-IP)
             │  MetalLB ARP
             ▼
   node NodePort ──► kube-proxy ──► nginx pod`,
        steps: [
          { title: 'Create the Service', cmd: 'kubectl --context kind-k8s-net-lab apply -f lab/06-loadbalancer/lb-service.yaml' },
          { title: 'Watch the IP appear', cmd: 'kubectl --context kind-k8s-net-lab get svc nginx-lb -w' },
          { title: 'See ARP announcements', cmd: 'kubectl --context kind-k8s-net-lab -n metallb-system logs -l app.kubernetes.io/component=speaker --tail=30' },
        ],
        task: 'svc/nginx-lb gets an EXTERNAL-IP and serves HTTP 200 from a container on the kind network.',
        hint: 'The verifier uses `docker run --rm --network kind curlimages/curl ...` so it works on macOS too.',
        solution: ['kubectl --context kind-k8s-net-lab apply -f lab/06-loadbalancer/lb-service.yaml'],
        takeaway: 'LoadBalancer builds on NodePort + kube-proxy. It adds an external IP, not a new data path.',
      },
      {
        id: 'etp', title: 'Cluster vs Local traffic policy', min: 6,
        checks: ['etp-local', 'etp-curl'],
        concept: [
          '`externalTrafficPolicy: Cluster` (the default) lets any node accept the packet and forward it — possibly to a pod on another node. That adds a hop and hides the client source IP.',
          '`Local` only sends traffic to pods on the node that received it. Source IP is preserved, and cross-node hops disappear — but you need a pod on every node or traffic is dropped.',
          'This is where the 3-node cluster pays off: patch the policy and watch whether traffic still finds a pod.',
          'In production this choice affects latency, source-IP-based ACLs and load distribution.',
        ],
        steps: [
          { title: 'See the current policy', cmd: 'kubectl --context kind-k8s-net-lab get svc nginx-lb -o jsonpath="{.spec.externalTrafficPolicy}"' },
          { title: 'Switch to Local', cmd: 'kubectl --context kind-k8s-net-lab patch svc nginx-lb -p "{\\"spec\\":{\\"externalTrafficPolicy\\":\\"Local\\"}}"' },
          { title: 'Check endpoints per node', cmd: 'kubectl --context kind-k8s-net-lab get endpointslice -l kubernetes.io/service-name=nginx-lb -o yaml' },
        ],
        task: 'Set externalTrafficPolicy to Local and confirm the Service still serves traffic.',
        hint: 'The manifest starts with `Cluster` on purpose. Patch the Service to `Local`, then verify it still serves traffic.',
        solution: ['kubectl --context kind-k8s-net-lab patch svc nginx-lb -p "{\\"spec\\":{\\"externalTrafficPolicy\\":\\"Local\\"}}"'],
        takeaway: 'Local preserves client IP but needs endpoints on every node; Cluster spreads traffic but hides the source.',
      },
      {
        id: 'external-dns', title: 'DNS for the outside world', min: 5,
        checks: ['nipio-resolves'],
        concept: [
          'Internal DNS (Module 1) is CoreDNS answering from the Kubernetes API. External DNS is a completely different system: public resolvers mapping names to IPs.',
          'You rarely want to hand out a bare IP. A name survives IP changes and can sit behind a CDN or a real cloud load balancer.',
          '`nip.io` is a free wildcard DNS service: any `a.b.c.d.nip.io` resolves to `a.b.c.d`. Perfect for a lab.',
          'In production you would use external-dns to create records automatically from Service/Ingress annotations.',
        ],
        steps: [
          { title: 'Get the LB IP', cmd: 'kubectl --context kind-k8s-net-lab get svc nginx-lb -o jsonpath="{.status.loadBalancer.ingress[0].ip}"' },
          { title: 'Resolve the nip.io name', cmd: 'python3 -c "import socket; ip=\\"$(kubectl --context kind-k8s-net-lab get svc nginx-lb -o jsonpath="{.status.loadBalancer.ingress[0].ip}")\\"; print(socket.gethostbyname(ip + \\".nip.io\\"))"' },
        ],
        task: 'A nip.io wildcard name must resolve back to the EXTERNAL-IP of nginx-lb.',
        hint: 'If DNS lookup fails, check your Mac\'s internet/DNS settings. This is the one check that needs public DNS.',
        solution: ["python3 -c 'import socket,subprocess; ip=subprocess.check_output([\"kubectl\",\"--context\",\"kind-k8s-net-lab\",\"get\",\"svc\",\"nginx-lb\",\"-o\",\"jsonpath={.status.loadBalancer.ingress[0].ip}\"],text=True).strip(); print(ip, socket.gethostbyname(ip+\".nip.io\"))'"],
        takeaway: 'Internal DNS finds Services; external DNS finds your entry point. Both are just name → IP mapping.',
      },
    ],
  },
];

const byId = {};
const all = [];
for (const m of modules) {
  for (const l of m.lessons) {
    byId[l.id] = { ...l, moduleId: m.id, moduleTitle: m.title };
    all.push(l.id);
  }
}

module.exports = { modules, byId, all };
