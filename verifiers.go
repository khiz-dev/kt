package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	CTX      = "kind-k8s-net-lab"
	CLUSTER  = "k8s-net-lab"
	NS       = "net-lab"
	ISTIOCTL = "./bin/istioctl"
)

// cmdResult is the trimmed result of one external command.
type cmdResult struct {
	OK   bool
	Out  string
	Err  string
	Code int
}

func runCommand(timeout time.Duration, name string, args ...string) cmdResult {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()

	code := 0
	if err != nil {
		code = -1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	return cmdResult{
		OK:   err == nil,
		Out:  strings.TrimSpace(stdout.String()),
		Err:  strings.TrimSpace(stderr.String()),
		Code: code,
	}
}

// kubectl always pins the local kind context, even if the current context is remote.
func kubectl(args ...string) cmdResult {
	full := make([]string, 0, len(args)+2)
	full = append(full, "--context", CTX)
	full = append(full, args...)
	return runCommand(30*time.Second, "kubectl", full...)
}

func kjson(args ...string) map[string]any {
	full := append(append([]string{}, args...), "-o", "json")
	r := kubectl(full...)
	if !r.OK {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(r.Out), &v); err != nil {
		return nil
	}
	return asMap(v)
}

func dockerExec(script string) cmdResult {
	return runCommand(30*time.Second, "docker", "exec", CLUSTER+"-control-plane", "sh", "-c", script)
}

func curlIn(ns, pod, url, flags string) cmdResult {
	if flags == "" {
		flags = "-sS -m 6 -o /dev/null -w %{http_code}"
	}
	return kubectl("exec", "-n", ns, pod, "--", "sh", "-c", fmt.Sprintf("curl %s '%s'", flags, url))
}

func nslookupIn(ns, pod, name string) cmdResult {
	return kubectl("exec", "-n", ns, pod, "--", "sh", "-c", fmt.Sprintf("nslookup %s 2>&1 || true", name))
}

func svcIP(name string, ns ...string) string {
	namespace := NS
	if len(ns) > 0 && ns[0] != "" {
		namespace = ns[0]
	}
	return str(get(kjson("get", "svc", name, "-n", namespace), "spec", "clusterIP"))
}

// --- small JSON traversal helpers ------------------------------------------

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func get(v any, keys ...string) any {
	for _, key := range keys {
		m := asMap(v)
		if m == nil {
			return nil
		}
		v = m[key]
	}
	return v
}

func first(v any) any {
	if s := asSlice(v); len(s) > 0 {
		return s[0]
	}
	return nil
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	default:
		return fmt.Sprint(v)
	}
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, err := strconv.ParseFloat(x, 64)
		if err == nil {
			return f
		}
	}
	return 0
}

func jsonStr(v any) string {
	if v == nil {
		return "[]"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func orDetail(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func anyItem(items []any, fn func(map[string]any) bool) bool {
	for _, item := range items {
		if fn(asMap(item)) {
			return true
		}
	}
	return false
}

func condIn(conditions []any, typ string) bool {
	for _, c := range conditions {
		m := asMap(c)
		if str(get(m, "type")) == typ && str(get(m, "status")) == "True" {
			return true
		}
	}
	return false
}

// cond reads top-level status.conditions (Gateway API routes use parentCond instead).
func cond(g map[string]any, typ string) bool {
	return condIn(asSlice(get(g, "status", "conditions")), typ)
}

// parentCond reads status.parents[].conditions, as required by the Gateway API.
func parentCond(r map[string]any, typ string) bool {
	for _, p := range asSlice(get(r, "status", "parents")) {
		if condIn(asSlice(get(p, "conditions")), typ) {
			return true
		}
	}
	return false
}

func hasPolicyType(p map[string]any, typ string) bool {
	for _, t := range asSlice(get(p, "spec", "policyTypes")) {
		if str(t) == typ {
			return true
		}
	}
	return false
}

func npAllowsPodLabel(p map[string]any, key, val string) bool {
	for _, in := range asSlice(get(p, "spec", "ingress")) {
		for _, from := range asSlice(get(in, "from")) {
			if str(get(from, "podSelector", "matchLabels", key)) == val {
				return true
			}
		}
	}
	return false
}

func npNsPortRule(p map[string]any) bool {
	for _, in := range asSlice(get(p, "spec", "ingress")) {
		nsOK := false
		for _, from := range asSlice(get(in, "from")) {
			if str(get(from, "namespaceSelector", "matchLabels", "team")) == "trusted" {
				nsOK = true
			}
		}
		if !nsOK {
			continue
		}
		for _, port := range asSlice(get(in, "ports")) {
			if num(get(port, "port")) == 80 {
				return true
			}
		}
	}
	return false
}

func deployReady(name string, ns ...string) CheckResult {
	namespace := NS
	if len(ns) > 0 && ns[0] != "" {
		namespace = ns[0]
	}
	d := kjson("get", "deploy", name, "-n", namespace)
	ready := int(num(get(d, "status", "readyReplicas")))
	if ready >= 1 {
		return pass(fmt.Sprintf("%s: %d pod ready", name, ready))
	}
	return fail(fmt.Sprintf("%s: %d pods ready", name, ready))
}

func lbIP(s map[string]any) string {
	return str(get(first(get(s, "status", "loadBalancer", "ingress")), "ip"))
}

// --- port-forward support ---------------------------------------------------

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// withPortForward runs fn while a context-pinned kubectl port-forward is live.
func withPortForward(namespace, target string, localPort, remotePort int, fn func() cmdResult) (cmdResult, error) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "kubectl", "--context", CTX, "port-forward", "-n", namespace, target,
		fmt.Sprintf("%d:%d", localPort, remotePort))
	var buf syncBuffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	if err := cmd.Start(); err != nil {
		cancel()
		return cmdResult{}, err
	}

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		cancel()
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}()

	deadline := time.Now().Add(12 * time.Second)
	for !strings.Contains(buf.String(), "Forwarding") {
		select {
		case err := <-exited:
			return cmdResult{}, fmt.Errorf("port-forward exited: %v: %s", err, buf.String())
		case <-time.After(100 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			return cmdResult{}, fmt.Errorf("port-forward timeout: %s", buf.String())
		}
	}
	return fn(), nil
}

func randomPort(base int) int {
	return base + int(time.Now().UnixNano()%200)
}

func configDump(target string, base int) (cmdResult, error) {
	port := randomPort(base)
	return withPortForward("envoy-gateway-system", "deploy/"+target, port, 19000, func() cmdResult {
		return runCommand(30*time.Second, "curl", "-sS", "-m", "10", fmt.Sprintf("http://127.0.0.1:%d/config_dump", port))
	})
}

func firstEnvoyProxyDeploy() string {
	return kubectl("get", "deploy", "-n", "envoy-gateway-system",
		"-l", "gateway.envoyproxy.io/owning-gateway-name=eg",
		"-o", "jsonpath={.items[0].metadata.name}").Out
}

func egGone() bool {
	return kjson("get", "ns", "envoy-gateway-system") == nil
}

func istioGone() bool {
	ns := kjson("get", "ns", "istio-system")
	crd := kjson("get", "crd", "virtualservices.networking.istio.io")
	return ns == nil && crd == nil
}

func pass(detail string) CheckResult { return CheckResult{OK: true, Detail: detail} }
func fail(detail string) CheckResult { return CheckResult{OK: false, Detail: detail} }

var reHelmIPAM = regexp.MustCompile(`ipam:\s*mode:\s*kubernetes`)
var reHelmKubeProxy = regexp.MustCompile(`kubeProxyReplacement:\s*false`)
var reHelmLBIPAM = regexp.MustCompile(`defaultLBServiceIPAM:\s*none`)

func helmCiliumValues() cmdResult {
	return runCommand(30*time.Second, "helm", "get", "values", "cilium", "-n", "kube-system",
		"-o", "yaml", "--kube-context", CTX)
}

// blockedByCurl mirrors /BLOCKED|000|^7|^28/.
func blockedByCurl(out string, prefixes []string) bool {
	if strings.Contains(out, "BLOCKED") || strings.Contains(out, "000") {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(out, p) {
			return true
		}
	}
	return false
}

// blockedByCurlAny mirrors the unanchored /BLOCKED|000|7|28/ used for egress.
func blockedByCurlAny(out string, needles []string) bool {
	if strings.Contains(out, "BLOCKED") || strings.Contains(out, "000") {
		return true
	}
	for _, n := range needles {
		if strings.Contains(out, n) {
			return true
		}
	}
	return false
}

func lbCurl(ip string) cmdResult {
	return runCommand(90*time.Second, "docker", "run", "--rm", "--network", "kind", "curlimages/curl:latest",
		"-sS", "-m", "12", "-o", "/dev/null", "-w", "%{http_code}", "http://"+ip+"/")
}

// --- check registry ---------------------------------------------------------

var checks = map[string]Check{
	"ctx": {
		ID: "ctx", Label: "You are connected to the local kind cluster",
		Hint: "Run: kubectl config current-context — it must say kind-k8s-net-lab.",
		Run: func() CheckResult {
			r := runCommand(30*time.Second, "kubectl", "--context", CTX, "config", "current-context")
			if r.Out == CTX {
				return pass(r.Out)
			}
			return fail(fmt.Sprintf("Current context is %s. Use --context %s.", orDetail(r.Out, "unknown"), CTX))
		},
	},
	"nodes-ready": {
		ID: "nodes-ready", Label: "All 3 nodes are Ready",
		Hint: "Wait a moment: kubectl --context kind-k8s-net-lab get nodes",
		Run: func() CheckResult {
			nodes := asSlice(get(kjson("get", "nodes"), "items"))
			ready := 0
			for _, n := range nodes {
				if condIn(asSlice(get(n, "status", "conditions")), "Ready") {
					ready++
				}
			}
			if ready == 3 && len(nodes) == 3 {
				return pass(fmt.Sprintf("%d/3 nodes Ready", ready))
			}
			return fail(fmt.Sprintf("%d/3 nodes Ready (found %d)", ready, len(nodes)))
		},
	},
	"cilium-ready": {
		ID: "cilium-ready", Label: "Cilium agent is running on every node",
		Hint: "kubectl -n kube-system rollout status ds/cilium",
		Run: func() CheckResult {
			ds := kjson("get", "ds", "cilium", "-n", "kube-system")
			desired := int(num(get(ds, "status", "desiredNumberScheduled")))
			ready := int(num(get(ds, "status", "numberReady")))
			if desired >= 3 && ready == desired {
				return pass(fmt.Sprintf("%d/%d agents ready", ready, desired))
			}
			return fail(fmt.Sprintf("%d/%d agents ready", ready, desired))
		},
	},
	"cilium-ipam": {
		ID: "cilium-ipam", Label: "Cilium uses Kubernetes IPAM (pod CIDRs from kind)",
		Hint: "helm get values cilium -n kube-system | grep ipam",
		Run: func() CheckResult {
			r := helmCiliumValues()
			if reHelmIPAM.MatchString(r.Out) {
				return pass("ipam.mode=kubernetes")
			}
			return fail("ipam.mode is not kubernetes")
		},
	},
	"cilium-kubeproxy": {
		ID: "cilium-kubeproxy", Label: "kube-proxy is still doing Service NAT",
		Hint: "Check helm values: kubeProxyReplacement must be false.",
		Run: func() CheckResult {
			r := helmCiliumValues()
			if reHelmKubeProxy.MatchString(r.Out) {
				return pass("kubeProxyReplacement=false")
			}
			return fail("kubeProxyReplacement must be false for this course")
		},
	},
	"cilium-lbipam": {
		ID: "cilium-lbipam", Label: "Cilium's LB-IPAM is off (so MetalLB can own LoadBalancers)",
		Hint: "Check helm values: defaultLBServiceIPAM must be none.",
		Run: func() CheckResult {
			r := helmCiliumValues()
			if reHelmLBIPAM.MatchString(r.Out) {
				return pass("defaultLBServiceIPAM=none")
			}
			return fail("defaultLBServiceIPAM must be none")
		},
	},
	"ns-net-lab": {
		ID: "ns-net-lab", Label: "Namespace net-lab exists",
		Hint: "kubectl create ns net-lab",
		Run: func() CheckResult {
			if kjson("get", "ns", NS) != nil {
				return pass(NS)
			}
			return fail("namespace net-lab not found")
		},
	},
	"web-ready": {
		ID: "web-ready", Label: "The web Deployment is running",
		Hint: "Apply lab/00-foundations/apps.yaml",
		Run:  func() CheckResult { return deployReady("web") },
	},
	"api-ready": {
		ID: "api-ready", Label: "The api Deployment is running",
		Hint: "Apply lab/00-foundations/apps.yaml",
		Run:  func() CheckResult { return deployReady("api") },
	},
	"client-ready": {
		ID: "client-ready", Label: "The client pod is running",
		Hint: "Apply lab/00-foundations/apps.yaml",
		Run: func() CheckResult {
			p := kjson("get", "pod", "client", "-n", NS)
			if str(get(p, "status", "phase")) == "Running" {
				return pass("client Running")
			}
			return fail("client pod is not Running")
		},
	},
	"svc-clusterip": {
		ID: "svc-clusterip", Label: "web and api have ClusterIP Services",
		Hint: "Apply lab/00-foundations/apps.yaml",
		Run: func() CheckResult {
			web := kjson("get", "svc", "web", "-n", NS)
			api := kjson("get", "svc", "api", "-n", NS)
			if web != nil && api != nil {
				return pass(fmt.Sprintf("web=%s, api=%s", str(get(web, "spec", "clusterIP")), str(get(api, "spec", "clusterIP"))))
			}
			return fail("one or both Services are missing")
		},
	},
	"pod-ip-cidr": {
		ID: "pod-ip-cidr", Label: "Pods get IPs from 10.244.x.x",
		Hint: "kubectl -n net-lab get pod -o wide",
		Run: func() CheckResult {
			ips := []string{}
			good := []string{}
			for _, p := range asSlice(get(kjson("get", "pods", "-n", NS), "items")) {
				ip := str(get(p, "status", "podIP"))
				if ip == "" {
					continue
				}
				ips = append(ips, ip)
				if strings.HasPrefix(ip, "10.244.") {
					good = append(good, ip)
				}
			}
			if len(good) > 0 {
				return pass(strings.Join(good, ", "))
			}
			return fail(fmt.Sprintf("no pod IP in 10.244/16 (found: %s)", orDetail(strings.Join(ips, ", "), "none")))
		},
	},
	"endpointslice": {
		ID: "endpointslice", Label: "An EndpointSlice tracks the api pods",
		Hint: "kubectl -n net-lab get endpointslice -l kubernetes.io/service-name=api",
		Run: func() CheckResult {
			n := 0
			for _, e := range asSlice(get(kjson("get", "endpointslice", "-n", NS, "-l", "kubernetes.io/service-name=api"), "items")) {
				n += len(asSlice(get(e, "endpoints")))
			}
			if n > 0 {
				return pass(fmt.Sprintf("%d endpoint address(es)", n))
			}
			return fail("no endpoints for service api")
		},
	},
	"svc-ip-range": {
		ID: "svc-ip-range", Label: "ClusterIPs come from 10.96.0.0/16",
		Hint: "kubectl -n net-lab get svc",
		Run: func() CheckResult {
			ip := svcIP("api")
			if strings.HasPrefix(ip, "10.96.") {
				return pass(ip)
			}
			return fail(fmt.Sprintf("api ClusterIP is %s", orDetail(ip, "missing")))
		},
	},
	"curl-via-service": {
		ID: "curl-via-service", Label: "client can reach api through its Service IP",
		Hint: "kubectl -n net-lab exec client -- curl -s http://api",
		Run: func() CheckResult {
			r := curlIn(NS, "client", "http://api.net-lab.svc.cluster.local", "")
			if r.OK && r.Out == "200" {
				return pass("HTTP 200 via ClusterIP")
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, orDetail(r.Err, "error"))))
		},
	},
	"iptables-kube-svc": {
		ID: "iptables-kube-svc", Label: "kube-proxy programmed iptables KUBE-SVC chains",
		Hint: `docker exec k8s-net-lab-control-plane sh -c "iptables-save -t nat | grep KUBE-SVC"`,
		Run: func() CheckResult {
			r := dockerExec("iptables-save -t nat 2>/dev/null | grep -c 'KUBE-SVC' || true")
			n, _ := strconv.Atoi(r.Out)
			if n > 0 {
				return pass(fmt.Sprintf("%d KUBE-SVC rules found", n))
			}
			return fail("no KUBE-SVC nat rules found on the control-plane node")
		},
	},
	"coredns-ready": {
		ID: "coredns-ready", Label: "CoreDNS is running",
		Hint: "kubectl -n kube-system get pods -l k8s-app=kube-dns",
		Run:  func() CheckResult { return deployReady("coredns", "kube-system") },
	},
	"dns-api-resolves": {
		ID: "dns-api-resolves", Label: "CoreDNS resolves the full Service FQDN",
		Hint: "kubectl -n net-lab exec client -- nslookup api.net-lab.svc.cluster.local",
		Run: func() CheckResult {
			ip := svcIP("api")
			r := nslookupIn(NS, "client", "api.net-lab.svc.cluster.local")
			if ip != "" && strings.Contains(r.Out, ip) {
				return pass(fmt.Sprintf("api.net-lab.svc.cluster.local → %s", ip))
			}
			return fail(fmt.Sprintf("expected %s, got:\n%s", ip, clip(r.Out, 300)))
		},
	},
	"dns-short-name": {
		ID: "dns-short-name", Label: "The search suffix makes `api` resolvable",
		Hint: "kubectl -n net-lab exec client -- nslookup api",
		Run: func() CheckResult {
			ip := svcIP("api")
			r := nslookupIn(NS, "client", "api")
			if ip != "" && strings.Contains(r.Out, ip) {
				return pass(fmt.Sprintf("api → %s", ip))
			}
			return fail(fmt.Sprintf("short name did not resolve to %s", ip))
		},
	},
	"headless-svc": {
		ID: "headless-svc", Label: "A headless Service has clusterIP: None",
		Hint: "Apply lab/01-services/headless.yaml",
		Run: func() CheckResult {
			s := kjson("get", "svc", "api-headless", "-n", NS)
			if str(get(s, "spec", "clusterIP")) == "None" {
				return pass("clusterIP: None")
			}
			return fail("api-headless missing or not headless")
		},
	},
	"headless-dns": {
		ID: "headless-dns", Label: "Headless DNS returns Pod IPs, not a Service IP",
		Hint: "kubectl -n net-lab exec client -- nslookup api-headless",
		Run: func() CheckResult {
			list := kjson("get", "pods", "-n", NS, "-l", "app=api")
			podIP := str(get(first(get(list, "items")), "status", "podIP"))
			r := nslookupIn(NS, "client", "api-headless.net-lab.svc.cluster.local")
			if podIP != "" && strings.Contains(r.Out, podIP) {
				return pass(fmt.Sprintf("A record → %s (a pod IP)", podIP))
			}
			return fail(fmt.Sprintf("expected a pod IP, got:\n%s", clip(r.Out, 300)))
		},
	},
	"nodeport-svc": {
		ID: "nodeport-svc", Label: "A NodePort Service listens on 30081",
		Hint: "Apply lab/01-services/nodeport.yaml",
		Run: func() CheckResult {
			s := kjson("get", "svc", "web-nodeport", "-n", NS)
			np := num(get(first(get(s, "spec", "ports")), "nodePort"))
			if np == 30081 {
				return pass("30081/TCP")
			}
			shown := "missing"
			if np != 0 {
				shown = str(np)
			}
			return fail(fmt.Sprintf("nodePort is %s", shown))
		},
	},
	"nodeport-curl": {
		ID: "nodeport-curl", Label: "The NodePort is reachable from your Mac",
		Hint: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:30081`,
		Run: func() CheckResult {
			r := runCommand(30*time.Second, "curl", "-sS", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:30081")
			if r.OK && r.Out == "200" {
				return pass("HTTP 200 from the host")
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, orDetail(r.Err, "error"))))
		},
	},
	"np-baseline-curl": {
		ID: "np-baseline-curl", Label: "Baseline: client can reach web (no policy yet)",
		Hint: "Remove policies: kubectl -n net-lab delete networkpolicy --all",
		Run: func() CheckResult {
			r := curlIn(NS, "client", "http://web", "")
			if r.OK && r.Out == "200" {
				return pass("HTTP 200 (default-allow)")
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, orDetail(r.Err, "error"))))
		},
	},
	"np-deny-exists": {
		ID: "np-deny-exists", Label: "A default-deny ingress policy exists",
		Hint: "Apply lab/02-networkpolicy/deny-ingress.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "networkpolicies", "-n", NS), "items")), func(p map[string]any) bool {
				return len(asMap(get(p, "spec", "podSelector", "matchLabels"))) == 0 &&
					hasPolicyType(p, "Ingress") && len(asSlice(get(p, "spec", "ingress"))) == 0
			})
			if found {
				return pass("default-deny ingress found")
			}
			return fail("no empty-selector Ingress deny policy found")
		},
	},
	"np-deny-blocks": {
		ID: "np-deny-blocks", Label: "The policy actually blocks the client",
		Hint: "curl from the client pod should fail now",
		Run: func() CheckResult {
			r := curlIn(NS, "client", "http://web", "-sS -m 4 -o /dev/null -w %{http_code} || echo BLOCKED")
			if blockedByCurl(r.Out, []string{"7", "28"}) || !r.OK {
				return pass("connection blocked")
			}
			return fail(fmt.Sprintf("curl still got %s", r.Out))
		},
	},
	"np-allow-pod-exists": {
		ID: "np-allow-pod-exists", Label: "An allow policy names the client pod selector",
		Hint: "Apply lab/02-networkpolicy/allow-client.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "networkpolicies", "-n", NS), "items")), func(p map[string]any) bool {
				return npAllowsPodLabel(p, "app", "client")
			})
			if found {
				return pass("ingress.from.podSelector app=client")
			}
			return fail("no policy allowing pods labelled app=client")
		},
	},
	"np-allow-pod-curl": {
		ID: "np-allow-pod-curl", Label: "client is allowed again, evil is still blocked",
		Hint: "Check from both pods",
		Run: func() CheckResult {
			good := curlIn(NS, "client", "http://web", "")
			evil := curlIn("untrusted", "evil", fmt.Sprintf("http://web.%s.svc.cluster.local", NS), "")
			if good.Out == "200" && evil.Out != "200" {
				return pass("client=200, evil=blocked")
			}
			return fail(fmt.Sprintf("client=%s, evil=%s", orDetail(good.Out, good.Err), orDetail(evil.Out, evil.Err)))
		},
	},
	"np-ns-port-exists": {
		ID: "np-ns-port-exists", Label: "A namespaceSelector + port rule exists",
		Hint: "Apply lab/02-networkpolicy/allow-namespace-port.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "networkpolicies", "-n", NS), "items")), npNsPortRule)
			if found {
				return pass("namespaceSelector team=trusted on port 80")
			}
			return fail("namespace/port rule not found")
		},
	},
	"np-ns-port-allowed": {
		ID: "np-ns-port-allowed", Label: "A pod from the trusted namespace can reach web",
		Hint: "kubectl -n untrusted exec evil -- curl ... (use the trusted pod instead)",
		Run: func() CheckResult {
			r := curlIn("trusted", "trusted", fmt.Sprintf("http://web.%s.svc.cluster.local", NS), "")
			if r.Out == "200" {
				return pass("trusted/ HTTP 200")
			}
			return fail(fmt.Sprintf("trusted pod curl returned %s", orDetail(r.Out, r.Err)))
		},
	},
	"np-ns-port-denied": {
		ID: "np-ns-port-denied", Label: "A pod from an unlabelled namespace is still denied",
		Hint: "The evil pod must stay blocked",
		Run: func() CheckResult {
			r := curlIn("untrusted", "evil", fmt.Sprintf("http://web.%s.svc.cluster.local", NS), "")
			if r.Out != "200" {
				return pass("untrusted pod blocked")
			}
			return fail("untrusted pod was NOT blocked")
		},
	},
	"np-egress-exists": {
		ID: "np-egress-exists", Label: "Egress is default-denied in net-lab",
		Hint: "Apply lab/02-networkpolicy/egress-dns.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "networkpolicies", "-n", NS), "items")), func(p map[string]any) bool {
				return hasPolicyType(p, "Egress") && len(asSlice(get(p, "spec", "egress"))) == 0
			})
			if found {
				return pass("default-deny egress found")
			}
			return fail("no default-deny egress policy")
		},
	},
	"np-egress-dns-ok": {
		ID: "np-egress-dns-ok", Label: "DNS to kube-dns is allowed again",
		Hint: "The egress policy must allow UDP/TCP 53 to k8s-app=kube-dns",
		Run: func() CheckResult {
			r := nslookupIn(NS, "client", "kubernetes.default")
			if (strings.Contains(r.Out, "10.96.0.1") || strings.Contains(r.Out, "Address:")) && !strings.Contains(r.Out, "connection timed out") {
				return pass("DNS resolution works")
			}
			return fail(fmt.Sprintf("DNS failed:\n%s", clip(r.Out, 300)))
		},
	},
	"np-egress-external-blocked": {
		ID: "np-egress-external-blocked", Label: "External internet access is still denied",
		Hint: "curl https://example.com from client should fail",
		Run: func() CheckResult {
			r := curlIn(NS, "client", "https://example.com", "-sS -m 6 -o /dev/null -w %{http_code} || echo BLOCKED")
			if blockedByCurlAny(r.Out, []string{"7", "28"}) || !r.OK {
				return pass("external access blocked")
			}
			return fail(fmt.Sprintf("external curl returned %s", r.Out))
		},
	},
	"cilium-l7-exists": {
		ID: "cilium-l7-exists", Label: "A CiliumNetworkPolicy with HTTP rules exists",
		Hint: "Apply lab/02-networkpolicy/l7.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "ciliumnetworkpolicies", "-n", NS), "items")), func(p map[string]any) bool {
				return get(p, "spec", "endpointSelector") != nil && strings.Contains(jsonStr(p), "http")
			})
			if found {
				return pass("L7 policy found")
			}
			return fail("no CiliumNetworkPolicy with http rules")
		},
	},
	"cilium-l7-public": {
		ID: "cilium-l7-public", Label: "GET /public is allowed",
		Hint: "kubectl -n net-lab exec client -- curl -s http://l7/public",
		Run: func() CheckResult {
			_ = curlIn(NS, "client", "http://l7/public", "")
			body := kubectl("exec", "-n", NS, "client", "--", "sh", "-c", "curl -s http://l7/public")
			if strings.Contains(body.Out, "public") {
				return pass("GET /public → 200")
			}
			return fail(fmt.Sprintf("got: %s", clip(body.Out, 120)))
		},
	},
	"cilium-l7-admin-blocked": {
		ID: "cilium-l7-admin-blocked", Label: "GET /admin is blocked by L7 policy",
		Hint: `kubectl -n net-lab exec client -- curl -s -o /dev/null -w "%{http_code}" http://l7/admin`,
		Run: func() CheckResult {
			r := kubectl("exec", "-n", NS, "client", "--", "sh", "-c", `curl -s -o /dev/null -w "%{http_code}" http://l7/admin`)
			if r.Out == "403" {
				return pass("GET /admin → 403")
			}
			return fail(fmt.Sprintf("GET /admin returned %s", orDetail(r.Out, r.Err)))
		},
	},
	"gw-crd-standard": {
		ID: "gw-crd-standard", Label: "Gateway API v1.7.0 standard CRDs are installed",
		Hint: "kubectl apply --server-side -f .../standard-install.yaml",
		Run: func() CheckResult {
			items := asSlice(get(kjson("get", "crd",
				"gatewayclasses.gateway.networking.k8s.io",
				"gateways.gateway.networking.k8s.io",
				"httproutes.gateway.networking.k8s.io"), "items"))
			v := ""
			for _, c := range items {
				if str(get(c, "metadata", "name")) == "gatewayclasses.gateway.networking.k8s.io" {
					v = str(get(c, "metadata", "annotations", "gateway.networking.k8s.io/bundle-version"))
					break
				}
			}
			if len(items) == 3 {
				return pass(fmt.Sprintf("CRDs installed (bundle %s)", orDetail(v, "?")))
			}
			return fail(fmt.Sprintf("%d/3 Gateway API CRDs found", len(items)))
		},
	},
	"eg-deploy-ready": {
		ID: "eg-deploy-ready", Label: "Envoy Gateway controller is running",
		Hint: "helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.4 ...",
		Run:  func() CheckResult { return deployReady("envoy-gateway", "envoy-gateway-system") },
	},
	"eg-proxy-config": {
		ID: "eg-proxy-config", Label: "EnvoyProxy config pins the NodePort",
		Hint: "Apply lab/03-gateway/gateway.yaml",
		Run: func() CheckResult {
			s := jsonStr(kjson("get", "envoyproxy", "kind-nodeport", "-n", "envoy-gateway-system"))
			if strings.Contains(s, "nodePort") && strings.Contains(s, "30080") {
				return pass("EnvoyProxy nodePort=30080")
			}
			return fail("EnvoyProxy CR missing or has no 30080 patch")
		},
	},
	"gwclass-accepted": {
		ID: "gwclass-accepted", Label: "GatewayClass eg is Accepted",
		Hint: "kubectl get gatewayclass eg",
		Run: func() CheckResult {
			g := kjson("get", "gatewayclass", "eg")
			if cond(g, "Accepted") {
				return pass("Accepted=True")
			}
			return fail(fmt.Sprintf("conditions: %s", jsonStr(get(g, "status", "conditions"))))
		},
	},
	"gateway-programmed": {
		ID: "gateway-programmed", Label: "Gateway eg is Programmed",
		Hint: "kubectl get gateway eg -n net-lab -o yaml",
		Run: func() CheckResult {
			g := kjson("get", "gateway", "eg", "-n", NS)
			if cond(g, "Programmed") && cond(g, "Accepted") {
				return pass("Accepted + Programmed")
			}
			return fail(fmt.Sprintf("conditions: %s", jsonStr(get(g, "status", "conditions"))))
		},
	},
	"gateway-nodeport": {
		ID: "gateway-nodeport", Label: "The Envoy Service maps to host port 30080",
		Hint: "kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=eg",
		Run: func() CheckResult {
			items := asSlice(get(kjson("get", "svc", "-A", "-l", "gateway.envoyproxy.io/owning-gateway-name=eg"), "items"))
			for _, s := range items {
				for _, p := range asSlice(get(s, "spec", "ports")) {
					if num(get(p, "nodePort")) == 30080 {
						return pass(fmt.Sprintf("%s/%s → 30080", str(get(s, "metadata", "namespace")), str(get(s, "metadata", "name"))))
					}
				}
			}
			return fail("no Envoy Service with nodePort 30080")
		},
	},
	"route-accepted": {
		ID: "route-accepted", Label: "HTTPRoute is Accepted by the Gateway",
		Hint: "Apply lab/03-gateway/httproute.yaml",
		Run: func() CheckResult {
			r := kjson("get", "httproute", "demo", "-n", NS)
			if parentCond(r, "Accepted") {
				return pass("Accepted=True")
			}
			return fail(fmt.Sprintf("conditions: %s", jsonStr(get(r, "status", "parents"))))
		},
	},
	"route-path-v1": {
		ID: "route-path-v1", Label: "Path /v1 reaches the v1 backend",
		Hint: `curl -H "Host: lab.local" http://127.0.0.1:30080/v1`,
		Run: func() CheckResult {
			r := runCommand(30*time.Second, "curl", "-sS", "-m", "8", "-H", "Host: lab.local", "http://127.0.0.1:30080/v1")
			if strings.Contains(r.Out, "v1") {
				return pass(fmt.Sprintf("body: %s", clip(r.Out, 60)))
			}
			return fail(fmt.Sprintf("body: %s", orDetail(clip(r.Out, 120), r.Err)))
		},
	},
	"route-path-v2": {
		ID: "route-path-v2", Label: "Path /v2 reaches the v2 backend",
		Hint: `curl -H "Host: lab.local" http://127.0.0.1:30080/v2`,
		Run: func() CheckResult {
			r := runCommand(30*time.Second, "curl", "-sS", "-m", "8", "-H", "Host: lab.local", "http://127.0.0.1:30080/v2")
			if strings.Contains(r.Out, "v2") {
				return pass(fmt.Sprintf("body: %s", clip(r.Out, 60)))
			}
			return fail(fmt.Sprintf("body: %s", orDetail(clip(r.Out, 120), r.Err)))
		},
	},
	"refgrant-exists": {
		ID: "refgrant-exists", Label: "A ReferenceGrant allows cross-namespace backends",
		Hint: "Apply lab/03-gateway/refgrant.yaml",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "referencegrants", "-A"), "items")), func(g map[string]any) bool {
				toSvc := false
				for _, t := range asSlice(get(g, "spec", "to")) {
					if str(get(t, "kind")) == "Service" {
						toSvc = true
					}
				}
				if !toSvc {
					return false
				}
				for _, f := range asSlice(get(g, "spec", "from")) {
					if str(get(f, "namespace")) == "other" || str(get(f, "group")) == "gateway.networking.k8s.io" {
						return true
					}
				}
				return false
			})
			if found {
				return pass("ReferenceGrant found")
			}
			return fail("no ReferenceGrant found")
		},
	},
	"crossns-route-accepted": {
		ID: "crossns-route-accepted", Label: "HTTPRoute in namespace other is Accepted",
		Hint: "Apply lab/03-gateway/refgrant.yaml",
		Run: func() CheckResult {
			r := kjson("get", "httproute", "cross", "-n", "other")
			if parentCond(r, "Accepted") {
				return pass("cross-namespace route Accepted")
			}
			return fail(fmt.Sprintf("conditions: %s", jsonStr(get(r, "status", "parents"))))
		},
	},
	"crossns-curl": {
		ID: "crossns-curl", Label: "Cross-namespace route serves traffic",
		Hint: `curl -H "Host: other.local" http://127.0.0.1:30080/`,
		Run: func() CheckResult {
			r := runCommand(30*time.Second, "curl", "-sS", "-m", "8", "-H", "Host: other.local", "http://127.0.0.1:30080/")
			if r.OK && len(r.Out) > 0 {
				return pass(fmt.Sprintf("HTTP response received (%d bytes)", len(r.Out)))
			}
			return fail(fmt.Sprintf("curl failed: %s", r.Err))
		},
	},
	"standalone-envoy-ready": {
		ID: "standalone-envoy-ready", Label: "Standalone Envoy pod is Ready",
		Hint: "Apply lab/04-envoy/standalone.yaml",
		Run: func() CheckResult {
			list := kjson("get", "pod", "-n", NS, "-l", "app=envoy-standalone")
			if condIn(asSlice(get(first(get(list, "items")), "status", "conditions")), "Ready") {
				return pass("Envoy Ready")
			}
			return fail("Envoy pod is not Ready")
		},
	},
	"standalone-envoy-route": {
		ID: "standalone-envoy-route", Label: "Envoy routes /api to the api Service",
		Hint: "kubectl -n net-lab exec client -- curl -s http://envoy-standalone:8080/api",
		Run: func() CheckResult {
			_ = curlIn(NS, "client", "http://envoy-standalone.net-lab.svc.cluster.local:8080/api", "")
			body := kubectl("exec", "-n", NS, "client", "--", "sh", "-c", "curl -s http://envoy-standalone:8080/api")
			if strings.Contains(body.Out, "api-v1") {
				return pass("body contains api-v1")
			}
			return fail(fmt.Sprintf("got: %s", orDetail(clip(body.Out, 120), body.Err)))
		},
	},
	"envoy-listener": {
		ID: "envoy-listener", Label: "Envoy config_dump contains the 8080 listener",
		Hint: "kubectl -n envoy-gateway-system port-forward deploy/<envoy> 19000:19000 then curl /config_dump",
		Run: func() CheckResult {
			target := firstEnvoyProxyDeploy()
			if target == "" {
				return fail("no Envoy Gateway data-plane Deployment found")
			}
			r, err := configDump(target, 19100)
			if err != nil {
				return fail(err.Error())
			}
			if strings.Contains(r.Out, `"listener"`) && (strings.Contains(r.Out, "8080") || strings.Contains(r.Out, "10080")) {
				return pass("listener found in config_dump")
			}
			return fail("no listener in config_dump")
		},
	},
	"envoy-cluster": {
		ID: "envoy-cluster", Label: "Envoy config_dump contains the v1/v2 clusters",
		Hint: "Look for cluster names in /config_dump",
		Run: func() CheckResult {
			target := firstEnvoyProxyDeploy()
			if target == "" {
				return fail("no Envoy data-plane Deployment")
			}
			r, err := configDump(target, 19300)
			if err != nil {
				return fail(err.Error())
			}
			if strings.Contains(r.Out, `"clusters"`) && strings.Contains(r.Out, "v1") {
				return pass("clusters found in config_dump")
			}
			return fail("clusters missing")
		},
	},
	"envoy-attempt-header": {
		ID: "envoy-attempt-header", Label: "Standalone Envoy reports x-envoy-attempt-count",
		Hint: "curl -I http://envoy-standalone:8080/api from the client pod",
		Run: func() CheckResult {
			r := kubectl("exec", "-n", NS, "client", "--", "sh", "-c", `curl -sSI http://envoy-standalone:8080/api | tr "A-Z" "a-z"`)
			if strings.Contains(r.Out, "x-envoy-attempt-count") {
				return pass("x-envoy-attempt-count present")
			}
			return fail("header missing; set include_attempt_count_in_response")
		},
	},
	"eg-configdump-gateway": {
		ID: "eg-configdump-gateway", Label: "xDS config contains the Gateway hostname",
		Hint: "curl http://127.0.0.1:19000/config_dump after port-forward, before cleanup",
		Run: func() CheckResult {
			if egGone() {
				return pass("already demonstrated: Envoy Gateway removed during cleanup")
			}
			target := firstEnvoyProxyDeploy()
			if target == "" {
				return fail("no Envoy data-plane Deployment")
			}
			r, err := configDump(target, 19500)
			if err != nil {
				return fail(err.Error())
			}
			if strings.Contains(r.Out, "lab.local") {
				return pass("lab.local found in dynamic route config")
			}
			return fail("hostname not present in config_dump")
		},
	},
	"eg-removed": {
		ID: "eg-removed", Label: "Envoy Gateway has been cleaned up",
		Hint: "helm uninstall eg -n envoy-gateway-system",
		Run: func() CheckResult {
			if kjson("get", "ns", "envoy-gateway-system") != nil {
				return fail("namespace still exists")
			}
			return pass("Envoy Gateway removed")
		},
	},
	"istioctl-client": {
		ID: "istioctl-client", Label: "istioctl 1.32 client is installed",
		Hint: "curl -L -o bin/istioctl ... && chmod +x bin/istioctl",
		Run: func() CheckResult {
			r := runCommand(30*time.Second, ISTIOCTL, "version", "--remote=false")
			combined := r.Out + r.Err
			if strings.Contains(combined, "1.32") {
				return pass("istioctl 1.32.x")
			}
			return fail(fmt.Sprintf("istioctl not usable: %s", clip(combined, 160)))
		},
	},
	"istiod-ready": {
		ID: "istiod-ready", Label: "istiod is running",
		Hint: "istioctl install -y --set profile=demo ...",
		Run:  func() CheckResult { return deployReady("istiod", "istio-system") },
	},
	"istio-crds": {
		ID: "istio-crds", Label: "Istio networking CRDs are installed",
		Hint: "kubectl get crd virtualservices.networking.istio.io",
		Run: func() CheckResult {
			items := asSlice(get(kjson("get", "crd", "virtualservices.networking.istio.io",
				"destinationrules.networking.istio.io"), "items"))
			if len(items) == 2 {
				return pass("VirtualService + DestinationRule CRDs")
			}
			return fail("Istio CRDs missing")
		},
	},
	"ns-injected": {
		ID: "ns-injected", Label: "The canary namespace has injection enabled",
		Hint: "kubectl label ns canary istio-injection=enabled",
		Run: func() CheckResult {
			ns := kjson("get", "ns", "canary")
			if str(get(ns, "metadata", "labels", "istio-injection")) == "enabled" {
				return pass("istio-injection=enabled")
			}
			return fail("label missing")
		},
	},
	"sidecars-present": {
		ID: "sidecars-present", Label: "Pods in canary have 2 containers (app + istio-proxy)",
		Hint: "Restart deployments after labelling the namespace",
		Run: func() CheckResult {
			pods := []map[string]any{}
			for _, p := range asSlice(get(kjson("get", "pods", "-n", "canary"), "items")) {
				m := asMap(p)
				if str(get(m, "metadata", "labels", "app")) == "demo" {
					pods = append(pods, m)
				}
			}
			ok := len(pods) >= 2
			for _, p := range pods {
				hasProxy := false
				for _, c := range append(asSlice(get(p, "spec", "containers")), asSlice(get(p, "spec", "initContainers"))...) {
					if str(get(c, "name")) == "istio-proxy" {
						hasProxy = true
					}
				}
				if !hasProxy {
					ok = false
				}
			}
			if ok {
				return pass(fmt.Sprintf("%d pods with istio-proxy sidecars", len(pods)))
			}
			return fail(fmt.Sprintf("%d demo pods; sidecars not injected", len(pods)))
		},
	},
	"proxy-synced": {
		ID: "proxy-synced", Label: "istioctl proxy-status shows SYNCED sidecars",
		Hint: "istioctl proxy-status",
		Run: func() CheckResult {
			r := runCommand(30*time.Second, ISTIOCTL, "proxy-status", "--context", CTX)
			// Istio 1.32 shows SUBSCRIBED TYPES instead of a SYNCED column.
			lines := 0
			for _, line := range strings.Split(r.Out+r.Err, "\n") {
				if strings.Contains(line, ".canary") && strings.Contains(line, "istiod-") {
					lines++
				}
			}
			if lines >= 3 {
				return pass(fmt.Sprintf("%d canary proxies connected to istiod", lines))
			}
			return fail("proxies not connected: " + clip(orDetail(r.Err, r.Out), 160))
		},
	},
	"vs-exists": {
		ID: "vs-exists", Label: "A VirtualService defines traffic weights",
		Hint: "Apply lab/05-istio/canary.yaml",
		Run: func() CheckResult {
			v := kjson("get", "virtualservice", "demo", "-n", "canary")
			routes := asSlice(get(first(get(v, "spec", "http")), "route"))
			if len(routes) == 2 {
				weights := []string{}
				for _, rt := range routes {
					weights = append(weights, str(get(rt, "weight")))
				}
				return pass(fmt.Sprintf("weights: %s", strings.Join(weights, "/")))
			}
			return fail("VirtualService missing or not 2 routes")
		},
	},
	"dr-subsets": {
		ID: "dr-subsets", Label: "DestinationRule defines v1 and v2 subsets",
		Hint: "Apply lab/05-istio/canary.yaml",
		Run: func() CheckResult {
			names := []string{}
			for _, s := range asSlice(get(kjson("get", "destinationrule", "demo", "-n", "canary"), "spec", "subsets")) {
				names = append(names, str(get(s, "name")))
			}
			joined := strings.Join(names, ",")
			if strings.Contains(joined, "v1") && strings.Contains(joined, "v2") {
				return pass(fmt.Sprintf("subsets: %s", joined))
			}
			return fail(fmt.Sprintf("subsets: %s", orDetail(joined, "none")))
		},
	},
	"canary-split": {
		ID: "canary-split", Label: "Traffic actually splits across v1 and v2",
		Hint: "curl demo 40 times and count responses",
		Run: func() CheckResult {
			r := kubectl("exec", "-n", "canary", "client", "--", "sh", "-c",
				"for i in $(seq 1 40); do curl -s http://demo.canary.svc.cluster.local; echo; done")
			v1 := strings.Count(r.Out, "v1")
			v2 := strings.Count(r.Out, "v2")
			if v1 > 0 && v2 > 0 {
				return pass(fmt.Sprintf("v1=%d, v2=%d of 40", v1, v2))
			}
			return fail(fmt.Sprintf("v1=%d, v2=%d — no split observed", v1, v2))
		},
	},
	"peer-auth-strict": {
		ID: "peer-auth-strict", Label: "PeerAuthentication enforces STRICT mTLS",
		Hint: "Apply lab/05-istio/mtls.yaml",
		Run: func() CheckResult {
			p := kjson("get", "peerauthentication", "demo-mtls", "-n", "canary")
			if str(get(p, "spec", "mtls", "mode")) == "STRICT" {
				return pass("STRICT")
			}
			return fail("PeerAuthentication missing or not STRICT")
		},
	},
	"mtls-curl": {
		ID: "mtls-curl", Label: "Services still work with mTLS enabled",
		Hint: "curl from the injected client",
		Run: func() CheckResult {
			r := curlIn("canary", "client", "http://demo.canary.svc.cluster.local", "")
			if r.Out == "200" {
				return pass("HTTP 200 over mTLS")
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, r.Err)))
		},
	},
	"vs-header-match": {
		ID: "vs-header-match", Label: "VirtualService has a header-based match",
		Hint: "Apply lab/05-istio/header-route.yaml before uninstalling Istio",
		Run: func() CheckResult {
			if istioGone() {
				return pass("already demonstrated: Istio removed during cleanup")
			}
			v := kjson("get", "virtualservice", "demo", "-n", "canary")
			for _, h := range asSlice(get(v, "spec", "http")) {
				for _, m := range asSlice(get(h, "match")) {
					if get(m, "headers") != nil {
						return pass("header match found")
					}
				}
			}
			return fail("no header match in VirtualService")
		},
	},
	"header-route-v2": {
		ID: "header-route-v2", Label: "x-canary: true routes to v2",
		Hint: `curl -H "x-canary: true" http://demo.canary.svc.cluster.local before uninstalling Istio`,
		Run: func() CheckResult {
			if istioGone() {
				return pass("already demonstrated: Istio removed during cleanup")
			}
			r := kubectl("exec", "-n", "canary", "client", "--", "sh", "-c",
				`curl -s -H "x-canary: true" http://demo.canary.svc.cluster.local`)
			if strings.Contains(r.Out, "v2") {
				return pass(fmt.Sprintf("body: %s", clip(r.Out, 50)))
			}
			return fail(fmt.Sprintf("body: %s", orDetail(clip(r.Out, 120), r.Err)))
		},
	},
	"istio-removed": {
		ID: "istio-removed", Label: "Istio has been cleaned up",
		Hint: "istioctl uninstall --purge -y",
		Run: func() CheckResult {
			if kjson("get", "ns", "istio-system") != nil {
				return fail("istio-system still exists")
			}
			return pass("Istio removed")
		},
	},
	"metallb-controller": {
		ID: "metallb-controller", Label: "MetalLB controller is running",
		Hint: "helm upgrade --install metallb metallb/metallb --version 0.16.2 ...",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "deploy", "-n", "metallb-system"), "items")), func(d map[string]any) bool {
				return strings.Contains(str(get(d, "metadata", "name")), "controller") &&
					num(get(d, "status", "readyReplicas")) >= 1
			})
			if found {
				return pass("controller ready")
			}
			return fail("controller not ready")
		},
	},
	"metallb-speaker": {
		ID: "metallb-speaker", Label: "MetalLB speaker DaemonSet is running",
		Hint: "helm install metallb ...",
		Run: func() CheckResult {
			found := anyItem(asSlice(get(kjson("get", "ds", "-n", "metallb-system"), "items")), func(d map[string]any) bool {
				return strings.Contains(str(get(d, "metadata", "name")), "speaker") &&
					num(get(d, "status", "numberReady")) >= 1
			})
			if found {
				return pass("speaker ready")
			}
			return fail("speaker not ready")
		},
	},
	"ip-pool": {
		ID: "ip-pool", Label: "An IPAddressPool and L2Advertisement exist",
		Hint: "Apply lab/06-loadbalancer/metallb-pool.yaml",
		Run: func() CheckResult {
			pool := kjson("get", "ipaddresspool", "kind-pool", "-n", "metallb-system")
			adv := kjson("get", "l2advertisement", "kind-l2", "-n", "metallb-system")
			if pool != nil && adv != nil {
				return pass(jsonStr(get(pool, "spec", "addresses")))
			}
			return fail("pool or L2Advertisement missing")
		},
	},
	"lb-external-ip": {
		ID: "lb-external-ip", Label: "The LoadBalancer Service has an EXTERNAL-IP",
		Hint: "kubectl get svc nginx-lb",
		Run: func() CheckResult {
			ip := lbIP(kjson("get", "svc", "nginx-lb", "-n", "default"))
			if ip != "" {
				return pass(ip)
			}
			return fail("no EXTERNAL-IP assigned")
		},
	},
	"lb-curl-ok": {
		ID: "lb-curl-ok", Label: "The EXTERNAL-IP serves traffic",
		Hint: "docker run --rm --network kind curlimages/curl ... http://<EXTERNAL-IP>/",
		Run: func() CheckResult {
			ip := lbIP(kjson("get", "svc", "nginx-lb", "-n", "default"))
			if ip == "" {
				return fail("no EXTERNAL-IP yet")
			}
			r := lbCurl(ip)
			if r.OK && strings.HasSuffix(r.Out, "200") {
				return pass(fmt.Sprintf("HTTP 200 via %s", ip))
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, orDetail(r.Err, "error"))))
		},
	},
	"etp-local": {
		ID: "etp-local", Label: "externalTrafficPolicy is Local",
		Hint: "kubectl patch svc nginx-lb -p ...",
		Run: func() CheckResult {
			s := kjson("get", "svc", "nginx-lb", "-n", "default")
			if str(get(s, "spec", "externalTrafficPolicy")) == "Local" {
				return pass("Local")
			}
			return fail("not Local")
		},
	},
	"etp-curl": {
		ID: "etp-curl", Label: "Traffic still works with externalTrafficPolicy: Local",
		Hint: "curl the EXTERNAL-IP again",
		Run: func() CheckResult {
			ip := lbIP(kjson("get", "svc", "nginx-lb", "-n", "default"))
			if ip == "" {
				return fail("no EXTERNAL-IP")
			}
			r := lbCurl(ip)
			if r.OK && strings.HasSuffix(r.Out, "200") {
				return pass(fmt.Sprintf("HTTP 200 via %s", ip))
			}
			return fail(fmt.Sprintf("curl returned %s", orDetail(r.Out, r.Err)))
		},
	},
	"nipio-resolves": {
		ID: "nipio-resolves", Label: "A wildcard DNS name points at the LoadBalancer IP",
		Hint: "dig +short <EXTERNAL-IP>.nip.io  (or: nslookup <EXTERNAL-IP>.nip.io)",
		Run: func() CheckResult {
			ip := lbIP(kjson("get", "svc", "nginx-lb", "-n", "default"))
			if ip == "" {
				return fail("no EXTERNAL-IP")
			}
			ips, err := net.LookupIP(ip + ".nip.io")
			if err != nil {
				return fail("DNS lookup failed: " + err.Error())
			}
			resolved := ""
			for _, candidate := range ips {
				if candidate.To4() != nil {
					resolved = candidate.String()
					break
				}
			}
			if resolved == "" && len(ips) > 0 {
				resolved = ips[0].String()
			}
			if resolved == ip {
				return pass(fmt.Sprintf("%s.nip.io → %s", ip, resolved))
			}
			return fail(fmt.Sprintf("resolved to %s", resolved))
		},
	},
}
