#!/usr/bin/env bash
# Rebuild the teaching cluster from scratch. Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="k8s-net-lab"
NODE_IMAGE="${NODE_IMAGE:-kindest/node:v1.33.0}"
CILIUM_VERSION="${CILIUM_VERSION:-1.20.5}"

echo "==> Removing old '$NAME' cluster (if any)"
kind delete cluster --name "$NAME" >/dev/null 2>&1 || true

echo "==> Creating '$NAME' (1 control-plane + 2 workers, kindnet disabled)"
kind create cluster --name "$NAME" --config "$ROOT/kind-config.yaml" --image "$NODE_IMAGE" --wait 180s

CTX="kind-$NAME"

echo "==> Installing Cilium $CILIUM_VERSION as the CNI (NetworkPolicy enforcement)"
helm repo add cilium https://helm.cilium.io/ >/dev/null 2>&1 || true
helm repo update cilium >/dev/null
helm upgrade --install cilium cilium/cilium \
  --version "$CILIUM_VERSION" \
  --namespace kube-system \
  --kube-context "$CTX" \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=false \
  --set k8s.requireIPv4PodCIDR=true \
  --set defaultLBServiceIPAM=none \
  --set operator.replicas=1 \
  --set hubble.relay.enabled=false \
  --set hubble.ui.enabled=false \
  --wait --timeout 5m

echo "==> Waiting for all nodes to be Ready"
kubectl --context "$CTX" wait --for=condition=Ready nodes --all --timeout=180s

echo "==> Cluster status"
kubectl --context "$CTX" get nodes -o wide
kubectl --context "$CTX" -n kube-system rollout status ds/cilium --timeout=180s

cat <<EOF

Cluster '$NAME' is ready.

  kubectl --context $CTX get nodes
  kubectl --context $CTX get pods -A

Start the course with:

  cd $ROOT
  ./bin/kt

Or jump straight to a lesson:

  ./bin/kt start boot
EOF
