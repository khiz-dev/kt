package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

var state = loadProgress()
var args = os.Args[1:]

func allLessons() []Lesson {
	out := []Lesson{}
	for _, ch := range chapters {
		out = append(out, ch.Lessons...)
	}
	return out
}

func allIDs() []string {
	ids := []string{}
	for _, l := range allLessons() {
		ids = append(ids, l.ID)
	}
	return ids
}

func lessonByID(id string) (Lesson, bool) {
	for _, l := range allLessons() {
		if l.ID == id {
			return l, true
		}
	}
	return Lesson{}, false
}

func chapterForLesson(id string) Chapter {
	for _, ch := range chapters {
		for _, l := range ch.Lessons {
			if l.ID == id {
				return ch
			}
		}
	}
	return Chapter{}
}

func nextLessonID(after string) string {
	ids := allIDs()
	start := -1
	for i, id := range ids {
		if id == after {
			start = i
			break
		}
	}
	for i := start + 1; i < len(ids); i++ {
		if !isDone(state, ids[i]) {
			return ids[i]
		}
	}
	return ""
}

func header() {
	fmt.Printf("%skt%s %s·%s %sKubernetes Networking Academy%s\n", green, reset, dim, reset, bold, reset)
	fmt.Printf("%scluster %s  ·  progress %s%s\n", dim, CTX, stripANSI(progressLine(state, allIDs())), reset)
	rule()
}

func printConcept(lines []string) {
	fmt.Printf("\n%sTHE IDEA%s\n", bold, reset)
	for _, line := range lines {
		fmt.Println()
		fmt.Println(paint(wrap(line, 88, "  ")))
	}
}

func printDiagram(diagram string) {
	if diagram == "" {
		return
	}
	fmt.Printf("\n%sTHE PICTURE%s\n", bold, reset)
	lines := strings.Split(diagram, "\n")
	for _, line := range lines {
		fmt.Println(dim + "  " + line + reset)
	}
}

func verifyLesson(id string, showDetails bool) (bool, []CheckResult) {
	lesson, ok := lessonByID(id)
	if !ok {
		fmt.Printf("%sUnknown lesson: %s%s\n", red, id, reset)
		return false, nil
	}

	stop := startSpinner("Inspecting the live cluster...")
	results := []CheckResult{}
	for _, cid := range lesson.Checks {
		def, found := checks[cid]
		if !found {
			results = append(results, CheckResult{Detail: "verifier missing"})
			continue
		}
		r := def.Run()
		r.ID = def.ID
		r.Label = def.Label
		r.Hint = def.Hint
		results = append(results, r)
	}
	stop()

	allOK := true
	failed := []string{}
	for _, r := range results {
		if !r.OK {
			allOK = false
			failed = append(failed, r.Label)
		}
	}
	if allOK {
		markPass(state, id, "all checks passed")
	} else {
		markAttempt(state, id, strings.Join(failed, ", "))
	}

	if showDetails {
		if allOK {
			fmt.Printf("\n%s%s  ALL CHECKS PASSED%s\n\n", green, bold, reset)
		} else {
			fmt.Printf("\n%s%s  SOME CHECKS FAILED%s\n\n", red, bold, reset)
		}
		for _, r := range results {
			mark := red + "✘"
			if r.OK {
				mark = green + "✔"
			}
			fmt.Printf("  %s %s%s%s\n", mark, reset, r.Label, reset)
			if r.Detail != "" {
				fmt.Printf("    %s%s%s\n", dim, wrap(r.Detail, 82, ""), reset)
			}
			if !r.OK && r.Hint != "" {
				fmt.Printf("    %shint: %s%s\n", yellow, paint(r.Hint), reset)
			}
		}
		fmt.Printf("\n  %sprogress %s%s\n\n", dim, stripANSI(progressLine(state, allIDs())), reset)
	}
	return allOK, results
}

func guided(id string) {
	lesson, found := lessonByID(id)
	if !found {
		fmt.Printf("%sUnknown lesson: %s%s\n", red, id, reset)
		return
	}
	chapter := chapterForLesson(id)
	setCurrent(state, id)

	clear()
	header()
	fmt.Printf("\n%s%s%s\n", magenta, chapter.Title, reset)
	fmt.Printf("%s%s%s  %s· %d min%s\n", bold, underline, lesson.Title, dim, lesson.Min, reset)
	printConcept(lesson.Concept)
	printDiagram(lesson.Diagram)
	checkLines := []string{}
	for _, cid := range lesson.Checks {
		if def, ok := checks[cid]; ok {
			checkLines = append(checkLines, "  • "+def.Label)
		} else {
			checkLines = append(checkLines, "  • "+cid)
		}
	}
	box("YOU WILL BE VERIFIED ON", checkLines, magenta)
	readKey(dim + "Press Enter to start doing..." + reset)

	for i, step := range lesson.Steps {
		clear()
		header()
		fmt.Printf("\n%s%s%s %s›%s %s\n", magenta, chapter.Title, reset, dim, reset, lesson.Title)
		box(fmt.Sprintf("STEP %d OF %d: %s", i+1, len(lesson.Steps), step.Title), []string{"", "  $ " + step.Cmd}, blue)
		if step.Note != "" {
			fmt.Println("\n" + paint(wrap(step.Note, 88, "  ")))
		}
		if strings.Contains(step.Cmd, "port-forward") || strings.Contains(step.Cmd, " -w") {
			fmt.Printf("\n%s  This command blocks. Run it in a second terminal, then come back here.%s\n", yellow, reset)
			fmt.Printf("%s  The verifier opens its own port-forward when needed.%s\n", yellow, reset)
		}
		fmt.Printf("\n%s  Run this command yourself in your terminal, then tell kt what you saw.%s\n", cyan, reset)
		key := readKey(fmt.Sprintf("\n%s[Enter]%s I ran it   %s[r]%s run for me   %s[s]%s skip  %s[h]%s hint  %s[q]%s quit lesson  ",
			bold, reset, dim, reset, dim, reset, dim, reset, dim, reset))
		switch key {
		case "q":
			return
		case "h":
			fmt.Printf("\n%s%s%s\n", yellow, paint(wrap(lesson.Hint, 88, "  ")), reset)
			readKey(dim + "Press Enter to continue..." + reset)
			i--
			continue
		case "s":
			fmt.Printf("\n%s  Skipped. You can still verify the lesson at the end.%s\n", dim, reset)
			readKey(dim + "Press Enter to continue..." + reset)
			continue
		case "r":
			_, out := runCmdCapture(step.Cmd)
			explainStep(step, out, true)
			readKey(dim + "Press Enter to continue..." + reset)
		default:
			explainStep(step, "", false)
			readKey(dim + "Press Enter to continue..." + reset)
		}
	}

	for {
		clear()
		header()
		fmt.Printf("\n%s%s%s %s›%s %s\n", magenta, chapter.Title, reset, dim, reset, lesson.Title)
		box("YOUR TASK", append([]string{""}, strings.Split(wrap(lesson.Task, 74, "  "), "\n")...), green)
		fmt.Printf("\n  %schecks: %s%s\n\n", dim, strings.Join(lesson.Checks, " · "), reset)
		key := readKey(fmt.Sprintf("%s[Enter/v]%s verify   %s[h]%s hint  %s[c]%s solution  %s[n]%s next  %s[q]%s chapters  ",
			bold, reset, dim, reset, dim, reset, dim, reset, dim, reset))
		switch key {
		case "q":
			return
		case "h":
			fmt.Printf("\n%s%s%s\n\n", yellow, paint(wrap(lesson.Hint, 88, "  ")), reset)
			readKey(dim + "Press Enter..." + reset)
			continue
		case "c":
			fmt.Printf("\n%sSolution commands:%s\n", dim, reset)
			for _, cmd := range lesson.Solution {
				showCommand(cmd)
			}
			readKey(dim + "Press Enter..." + reset)
			continue
		case "n":
			if next := nextLessonID(id); next != "" {
				guided(next)
				return
			}
			fmt.Printf("%sCourse complete! Run 'kt progress' to see your record.%s\n", green, reset)
			readKey(dim + "Press Enter..." + reset)
			return
		}

		ok, _ := verifyLesson(id, true)
		if ok {
			fmt.Printf("\n%s%s  TAKEAWAY: %s%s\n\n", green, bold, paint(lesson.Takeaway), reset)
			k2 := readKey(fmt.Sprintf("%s[Enter]%s next lesson   %s[q]%s back to chapters  ", bold, reset, dim, reset))
			if k2 == "q" {
				return
			}
			if next := nextLessonID(id); next != "" {
				guided(next)
				return
			}
			fmt.Printf("%sYou finished the whole course. Nice work.%s\n", green, reset)
			readKey(dim + "Press Enter..." + reset)
			return
		}
		readKey(dim + "Press Enter to try again..." + reset)
	}
}

func listAll() {
	clear()
	header()
	n := 0
	for _, ch := range chapters {
		done := 0
		for _, l := range ch.Lessons {
			if isDone(state, l.ID) {
				done++
			}
		}
		fmt.Printf("\n%s%s%s %s%d/%d%s\n", bold, ch.Title, reset, dim, done, len(ch.Lessons), reset)
		fmt.Printf("  %s%s%s\n", dim, ch.Subtitle, reset)
		for i, l := range ch.Lessons {
			n++
			mark := dim + "○"
			if isDone(state, l.ID) {
				mark = green + "✔"
			}
			cur := ""
			if state.Current == l.ID {
				cur = cyan + " ← you are here" + reset
			}
			fmt.Printf("  %s%s  %s%d%s. %-18s %s%s\n", mark, reset, yellow, i+1, reset, l.ID, l.Title, cur)
		}
	}
	fmt.Println()
	_ = n
}

func menu() {
	for {
		clear()
		header()
		opts := []menuOption{}
		if state.Current != "" && !isDone(state, state.Current) {
			if l, ok := lessonByID(state.Current); ok {
				opts = append(opts, menuOption{Label: "Resume: " + l.Title, Description: "chapter " + chapterForLesson(l.ID).Title})
			}
		}
		opts = append(opts,
			menuOption{Label: "Browse chapters & lessons", Description: "guided, step by step"},
			menuOption{Label: "Cluster status", Description: "nodes, CNI, installed stacks"},
			menuOption{Label: "My progress", Description: "what you have verified"},
			menuOption{Label: "Verify a lesson manually", Description: "re-run its checks"},
			menuOption{Label: "Reset lab namespaces", Description: "start the exercises over"},
		)
		choice := selectMenu("What do you want to learn?", opts)
		if choice < 0 {
			fmt.Printf("%sSee you soon.%s\n\n", dim, reset)
			return
		}
		label := opts[choice].Label
		switch {
		case strings.HasPrefix(label, "Resume"):
			guided(state.Current)
		case strings.HasPrefix(label, "Browse"):
			browse()
		case strings.HasPrefix(label, "Cluster"):
			status(true)
		case strings.HasPrefix(label, "My"):
			showProgress(true)
		case strings.HasPrefix(label, "Verify"):
			verifyManually()
		default:
			resetLab()
		}
	}
}

func browse() {
	for {
		opts := []menuOption{}
		for _, ch := range chapters {
			done := 0
			for _, l := range ch.Lessons {
				if isDone(state, l.ID) {
					done++
				}
			}
			opts = append(opts, menuOption{Label: ch.Title, Description: fmt.Sprintf("%d/%d verified", done, len(ch.Lessons))})
		}
		opts = append(opts, menuOption{Label: "← Back", Description: ""})
		ci := selectMenu("Choose a chapter", opts)
		if ci < 0 || ci == len(chapters) {
			return
		}
		ch := chapters[ci]
		lopts := []menuOption{}
		for _, l := range ch.Lessons {
			desc := fmt.Sprintf("%d min", l.Min)
			if isDone(state, l.ID) {
				desc = "verified"
			}
			lopts = append(lopts, menuOption{Label: l.Title, Description: desc})
		}
		lopts = append(lopts, menuOption{Label: "← Back", Description: ""})
		li := selectMenu(ch.Title, lopts)
		if li < 0 || li == len(ch.Lessons) {
			continue
		}
		guided(ch.Lessons[li].ID)
		return
	}
}

func verifyManually() {
	opts := []menuOption{}
	for _, l := range allLessons() {
		desc := "not verified"
		if isDone(state, l.ID) {
			desc = "verified"
		}
		opts = append(opts, menuOption{Label: l.Title, Description: desc})
	}
	opts = append(opts, menuOption{Label: "← Back", Description: ""})
	i := selectMenu("Verify which lesson?", opts)
	if i < 0 || i == len(allLessons()) {
		return
	}
	verifyLesson(allLessons()[i].ID, true)
	readKey(dim + "Press Enter..." + reset)
}

func mapAt(m map[string]any, keys ...string) map[string]any {
	cur := m
	for _, k := range keys {
		next, ok := cur[k].(map[string]any)
		if !ok {
			return nil
		}
		cur = next
	}
	return cur
}

func sliceAt(m map[string]any, keys ...string) []any {
	cur := m
	for i, k := range keys {
		if i == len(keys)-1 {
			s, _ := cur[k].([]any)
			return s
		}
		next, ok := cur[k].(map[string]any)
		if !ok {
			return nil
		}
		cur = next
	}
	return nil
}

func status(pause bool) {
	clear()
	header()
	stop := startSpinner("Asking the cluster...")
	nodes := kjson("get", "nodes")
	cilium := kjson("get", "ds", "cilium", "-n", "kube-system")
	gw := kjson("get", "crd", "gatewayclasses.gateway.networking.k8s.io")
	eg := kjson("get", "deploy", "envoy-gateway", "-n", "envoy-gateway-system")
	istio := kjson("get", "deploy", "istiod", "-n", "istio-system")
	metallb := kjson("get", "deploy", "-n", "metallb-system")
	stop()

	nodeItems := sliceAt(nodes, "items")
	ready := 0
	for _, raw := range nodeItems {
		n, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for _, c := range sliceAt(n, "status", "conditions") {
			cm, ok := c.(map[string]any)
			if ok && cm["type"] == "Ready" && cm["status"] == "True" {
				ready++
			}
		}
	}
	ver := ""
	vr := runCommand(10*time.Second, "kubectl", "--context", CTX, "version", "-o", "json")
	if vr.OK {
		if sv := mapAt(parseJSONMap(vr.Out), "serverVersion"); sv != nil {
			ver, _ = sv["gitVersion"].(string)
		}
	}
	ciliumAgents := "NOT INSTALLED"
	if cilium != nil {
		st := mapAt(cilium, "status")
		if st != nil {
			ciliumAgents = fmt.Sprintf("%v/%v agents", st["numberReady"], st["desiredNumberScheduled"])
		}
	}
	gwText := dim + "not installed" + reset
	if gw != nil {
		gwText = "installed"
	}
	egText := dim + "not installed" + reset
	if st := mapAt(eg, "status"); st != nil && numericGreaterZero(st["readyReplicas"]) {
		egText = "running"
	}
	istioText := dim + "not installed" + reset
	if st := mapAt(istio, "status"); st != nil && numericGreaterZero(st["readyReplicas"]) {
		istioText = "running"
	}
	lbText := dim + "not installed" + reset
	for _, raw := range sliceAt(metallb, "items") {
		d, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := mapAt(d, "metadata")["name"].(string)
		if strings.Contains(name, "controller") {
			if st := mapAt(d, "status"); st != nil && numericGreaterZero(st["readyReplicas"]) {
				lbText = "running"
			}
		}
	}

	box("CLUSTER STATUS", []string{
		"  cluster:        " + green + CTX + reset + "  (" + ver + ")",
		fmt.Sprintf("  nodes:          %d/%d Ready", ready, len(nodeItems)),
		"  CNI:            Cilium " + ciliumAgents,
		"  Gateway API:    " + gwText,
		"  Envoy Gateway:  " + egText,
		"  Istio:          " + istioText,
		"  MetalLB:        " + lbText,
	}, blue)
	fmt.Printf("\n  %sprogress %s%s\n\n", dim, stripANSI(progressLine(state, allIDs())), reset)
	if pause {
		readKey(dim + "Press Enter..." + reset)
	}
}

func numericGreaterZero(v any) bool {
	switch n := v.(type) {
	case float64:
		return n > 0
	case int:
		return n > 0
	}
	return false
}

func showProgress(pause bool) {
	clear()
	header()
	n := 0
	for _, ch := range chapters {
		done := 0
		for _, l := range ch.Lessons {
			if isDone(state, l.ID) {
				done++
			}
		}
		fmt.Printf("\n%s%s%s %s%d/%d %s%s\n", bold, ch.Title, reset, dim, done, len(ch.Lessons), progressBar(done, len(ch.Lessons), 14), reset)
		for _, l := range ch.Lessons {
			n++
			r := state.Lessons[l.ID]
			mark := dim + "----"
			if r != nil && r.Passed {
				mark = green + "PASS"
			} else if r != nil && r.Attempts > 0 {
				mark = yellow + "TRY "
			}
			extra := ""
			if r != nil && r.Attempts > 0 {
				word := "attempts"
				if r.Attempts == 1 {
					word = "attempt"
				}
				extra = dim + fmt.Sprintf("  (%d %s)", r.Attempts, word) + reset
			}
			fmt.Printf("  %s%s  %2d  %-18s %s%s\n", mark, reset, n, l.ID, l.Title, extra)
		}
	}
	fmt.Printf("\n  %soverall %s%s\n", dim, stripANSI(progressLine(state, allIDs())), reset)
	fmt.Printf("  %ssaved in .kt-progress.json%s\n\n", dim, reset)
	if pause {
		readKey(dim + "Press Enter..." + reset)
	}
}

func resetLab() {
	fmt.Printf("\n%sThis deletes the lab namespaces (net-lab, trusted, untrusted, other, canary, metallb-system)%s\n", yellow, reset)
	fmt.Printf("%sand uninstalls Envoy Gateway, Istio and MetalLB. Progress is kept.%s\n", yellow, reset)
	ans := readLine(red + "Type 'yes' to continue: " + reset)
	if ans != "yes" {
		fmt.Println("Cancelled.")
		return
	}
	cmds := []string{
		"./bin/istioctl uninstall --purge -y --context " + CTX + " || true",
		"helm uninstall eg -n envoy-gateway-system --kube-context " + CTX + " || true",
		"helm uninstall metallb -n metallb-system --kube-context " + CTX + " || true",
		fmt.Sprintf("kubectl --context %s delete ns net-lab trusted untrusted other canary envoy-gateway-system istio-system metallb-system --ignore-not-found", CTX),
	}
	for _, c := range cmds {
		runCmd(c)
	}
	fmt.Printf("%sLab reset. Start with: kt start apps%s\n", green, reset)
}

func help() {
	fmt.Printf("\n%skt%s %s— interactive Kubernetes networking course%s\n\n", green, reset, dim, reset)
	fmt.Printf("  %skt%s                 interactive menu\n", yellow, reset)
	fmt.Printf("  %skt start <lesson>%s   guided lesson (you run the commands)\n", yellow, reset)
	fmt.Printf("  %skt verify <lesson>%s  verify a lesson's checks\n", yellow, reset)
	fmt.Printf("  %skt check <check>%s    run one check\n", yellow, reset)
	fmt.Printf("  %skt list%s             all chapters and lessons\n", yellow, reset)
	fmt.Printf("  %skt chapters%s         chapter picker\n", yellow, reset)
	fmt.Printf("  %skt status%s           cluster/component status\n", yellow, reset)
	fmt.Printf("  %skt progress%s         progress report\n", yellow, reset)
	fmt.Printf("  %skt next%s             next unverified lesson\n", yellow, reset)
	fmt.Printf("  %skt reset%s            reset the lab namespaces\n", yellow, reset)
}

func main() {
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "":
		menu()
	case "start", "go":
		id := ""
		if len(args) > 1 {
			id = args[1]
		} else if state.Current != "" {
			id = state.Current
		} else {
			ids := allIDs()
			if len(ids) > 0 {
				id = ids[0]
			}
		}
		guided(id)
	case "verify":
		id := ""
		if len(args) > 1 {
			id = args[1]
		} else if state.Current != "" {
			id = state.Current
		} else {
			ids := allIDs()
			if len(ids) > 0 {
				id = ids[0]
			}
		}
		verifyLesson(id, true)
	case "check":
		if len(args) < 2 {
			fmt.Printf("%sUsage: kt check <check>%s\n", red, reset)
			return
		}
		def, ok := checks[args[1]]
		if !ok {
			ids := make([]string, 0, len(checks))
			for id := range checks {
				ids = append(ids, id)
			}
			fmt.Printf("%sUnknown check. Available: %s%s\n", red, strings.Join(ids, ", "), reset)
			return
		}
		stop := startSpinner(def.Label)
		r := def.Run()
		stop()
		if r.OK {
			fmt.Printf("%sPASS%s  %s\n  %s\n", green, reset, def.Label, r.Detail)
		} else {
			fmt.Printf("%sFAIL%s  %s\n  %s\n", red, reset, def.Label, r.Detail)
		}
	case "list", "lessons":
		listAll()
	case "chapters":
		browse()
	case "status":
		status(false)
	case "progress":
		showProgress(false)
	case "reset":
		resetLab()
	case "next":
		after := ""
		if len(args) > 1 {
			after = args[1]
		} else {
			after = state.Current
		}
		next := nextLessonID(after)
		if next == "" {
			fmt.Printf("%sNothing left — course complete.%s\n", green, reset)
			return
		}
		guided(next)
	case "help":
		help()
	default:
		fmt.Printf("%sUnknown command: %s%s (try 'kt help')\n", red, cmd, reset)
	}
}
