# kt — Kubernetes Networking Academy

`kt` (knowledge transfer) is a local, interactive CLI course that teaches
Kubernetes networking by making you change a real cluster and then verifying
the result with `kubectl`. No browser, no account, no cloud.

```
You ──► kt ──► kubectl --context kind-k8s-net-lab ──► 3-node kind cluster
       lessons     real checks, not self-reported      Cilium + lab apps
```

## Prerequisites

- macOS with **Docker/OrbStack** (give Docker at least **8 GB RAM**)
- `kind`, `kubectl`, `helm`, `curl`, `python3`, `docker`
- No sudo required; tools are installed locally under `bin/`

## Quick start

```bash
cd "$(dirname "$0")"

# First time only: build the 3-node cluster with Cilium as the CNI.
./cluster/bootstrap.sh

# Start the interactive course.
./bin/kt
```

You can also jump straight to a lesson or list them all:

If you want plain `kt` instead of `./bin/kt`, link it once:

```bash
ln -sf "$PWD/bin/kt" /opt/homebrew/bin/kt
```

```bash
./bin/kt start boot           # guided steps + verification
./bin/kt list                 # all 7 chapters / 30 lessons
./bin/kt progress             # what you have verified so far
./bin/kt status               # nodes, CNI, Gateway API, Istio, MetalLB
./bin/kt verify lb-service    # re-run one lesson's checks
./bin/kt check ctx            # run a single named check
./bin/kt next                 # next unverified lesson
./bin/kt reset                # wipe lab namespaces, keep progress
./bin/kt help
```

Progress is saved in `.kt-progress.json`. It records attempts and passes, but a
lesson only counts once every real check passes.

## Learning order (and why)

| # | Chapter | Why here |
|---|---------|----------|
| 0 | Bootcamp: nodes, CNI and the playground | You cannot debug a packet without knowing where nodes, pod CIDRs and the CNI are. |
| 1 | Pods, Services, DNS, NodePort | Services are the stable identity layer; DNS is how clients find them. Everything later builds on this. |
| 2 | NetworkPolicy | Needs labels, selectors and DNS — egress rules commonly break name resolution. |
| 3 | Gateway API | Native L7 routing; the cleanest introduction to ingress before a mesh. |
| 4 | Envoy | Gateway API's data plane is Envoy. Learn the proxy directly, then inspect the xDS it generated. |
| 5 | Istio | A mesh moves Envoy into every pod. Easier once you already understand one Envoy. |
| 6 | LoadBalancer | External exposure makes sense only after internal routing is clear. |

Each lesson has: the idea, a diagram, guided commands, a concrete task, hints,
a solution, live verification, and a takeaway. Cleanup is built into the
lessons that install Envoy Gateway and Istio so you do not run both control
planes at once.

## Layout

```
k8s-net-lab/
├── bin/
│   ├── kt                  # CLI entry point
│   └── istioctl            # downloaded locally by the Istio lesson
├── cli.js / lib/           # command router, lesson content, UI, progress, checks
├── kind-config.yaml        # 3 nodes, kindnet disabled, host ports 30080/30081/30443
├── cluster/
│   ├── bootstrap.sh        # recreate cluster + install Cilium 1.20.5
│   └── repair-ips.sh       # fix stale kubelet API IP after OrbStack restarts
├── lab/                    # manifests applied during lessons
│   ├── 00-foundations/
│   ├── 01-services/
│   ├── 02-networkpolicy/
│   ├── 03-gateway/
│   ├── 04-envoy/
│   ├── 05-istio/
│   └── 06-loadbalancer/
├── .kt-progress.json       # your saved progress
└── README.md
```

## Cluster design

- Cluster: `k8s-net-lab`; context: `kind-k8s-net-lab`
- 1 control-plane + 2 workers, host ports `30080`, `30081`, `30443`
- Cilium `1.20.5` with `ipam.mode=kubernetes`
- `kubeProxyReplacement=false`, so kube-proxy still does Service NAT
- `defaultLBServiceIPAM=none`, so MetalLB owns `type: LoadBalancer`
- Gateway API CRDs `v1.7.0` (standard channel)
- Envoy Gateway `v1.9.4` (v1.10+ needs Kubernetes 1.34)
- Istio `1.32.0`, MetalLB `0.16.2`
- MetalLB pool: `192.168.97.200-192.168.97.220` on the `kind` Docker network

## Safety

- Every `kubectl` call in the course pins `--context kind-k8s-net-lab`, so your
  remote GKE context can never be touched.
- Lessons run only the commands shown in the UI; there is no arbitrary shell
  execution from lesson content.
- Nothing binds to a network port except the lab Services themselves.

## Restarts and repair

If OrbStack/Docker restarts, kind node IPs can swap while `kubelet.conf` still
points at the old API address. Nodes will show `NotReady` or `connection
refused`. Fix it with:

```bash
./cluster/repair-ips.sh
```

That script rewrites the API server host on each node, restarts kubelet, clears
stale `not-ready` taints, and rolls Cilium/kube-proxy. If containerd itself
cannot recover sandbox metadata, rebuild with `./cluster/bootstrap.sh` and
re-apply the lab manifests; your `kt` progress is kept.

## Reset

`./bin/kt reset` deletes the lab namespaces and uninstalls Envoy Gateway,
Istio and MetalLB, but keeps the cluster and your progress. To start again from
zero, run `./cluster/bootstrap.sh`.
