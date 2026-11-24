#!/usr/bin/env bash
# Repair kind node IPs after Docker/OrbStack restarts.
#
# kind gives nodes DHCP-style addresses on the Docker network. If OrbStack
# restarts, the control-plane container can come back with a different IP while
# /etc/kubernetes/kubelet.conf still points at the old address. Symptoms:
# a NotReady control-plane, "connection refused", or a broken API server.
#
# This script rewrites the API server host inside every node's kubelet.conf,
# restarts kubelet, clears stale not-ready taints, and optionally rolls the CNI
# and kube-proxy DaemonSets so networking state is rebuilt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${NAME:-k8s-net-lab}"
CTX="${CTX:-kind-$NAME}"
NODES=("$NAME-control-plane" "$NAME-worker" "$NAME-worker2")

echo "==> Finding the current control-plane IP"
CP_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME-control-plane" \
  | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -1)"
if [[ -z "$CP_IP" ]]; then
  echo "Could not determine the control-plane IP." >&2
  exit 1
fi
echo "    $NAME-control-plane = $CP_IP"

echo "==> Rewriting kubelet.conf on each node (if needed)"
for node in "${NODES[@]}"; do
  old="$(docker exec "$node" sh -c "grep -m1 '    server: https://' /etc/kubernetes/kubelet.conf 2>/dev/null | sed -E 's#.*https://([^:]+):.*#\\1#'" || true)"
  if [[ -z "$old" ]]; then
    echo "    $node: no kubelet.conf server line; skipping"
    continue
  fi
  if [[ "$old" == "$CP_IP" ]]; then
    echo "    $node: already $CP_IP"
    continue
  fi
  echo "    $node: $old -> $CP_IP"
  docker exec "$node" sh -c "sed -i 's#https://$old:6443#https://$CP_IP:6443#g' /etc/kubernetes/kubelet.conf"
  docker exec "$node" sh -c 'systemctl restart kubelet'
done

echo "==> Waiting for nodes to become Ready"
kubectl --context "$CTX" wait --for=condition=Ready nodes --all --timeout=240s || true

echo "==> Clearing stale not-ready taints (if any)"
for node in $(kubectl --context "$CTX" get nodes -o name 2>/dev/null || true); do
  kubectl --context "$CTX" taint "$node" node.kubernetes.io/not-ready:NoSchedule- >/dev/null 2>&1 || true
  kubectl --context "$CTX" taint "$node" node.kubernetes.io/not-ready:NoExecute- >/dev/null 2>&1 || true
done

if [[ "${ROLL_NETWORKING:-1}" == "1" ]]; then
  echo "==> Rolling Cilium and kube-proxy to rebuild forwarding state"
  kubectl --context "$CTX" -n kube-system rollout restart ds/cilium ds/kube-proxy >/dev/null 2>&1 || true
  kubectl --context "$CTX" -n kube-system rollout status ds/cilium --timeout=300s || true
  kubectl --context "$CTX" -n kube-system rollout status ds/kube-proxy --timeout=300s || true
fi

echo
kubectl --context "$CTX" get nodes -o wide
echo
echo "If a node remains NotReady because containerd failed to recover sandbox metadata,"
echo "rebuild the lab with:  $ROOT/cluster/bootstrap.sh"
