package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

const (
	reset     = "\x1b[0m"
	bold      = "\x1b[1m"
	dim       = "\x1b[2m"
	underline = "\x1b[4m"
	red       = "\x1b[31m"
	green     = "\x1b[32m"
	yellow    = "\x1b[33m"
	blue      = "\x1b[34m"
	magenta   = "\x1b[35m"
	cyan      = "\x1b[36m"
)

var (
	ansiRE      = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	boldRE      = regexp.MustCompile(`\*\*(.+?)\*\*`)
	codeRE      = regexp.MustCompile("`([^`]+)`")
	http200RE   = regexp.MustCompile(`(^|[^0-9])200([^0-9]|$)`)
	stdinReader = bufio.NewReader(os.Stdin)
)

func stripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }

func lipColor(ansi string) lipgloss.Color {
	switch ansi {
	case green:
		return lipgloss.Color("#7ee787")
	case red:
		return lipgloss.Color("#ff7b72")
	case yellow:
		return lipgloss.Color("#e3b341")
	case blue:
		return lipgloss.Color("#79c0ff")
	case magenta:
		return lipgloss.Color("#d2a8ff")
	case cyan:
		return lipgloss.Color("#56d4dd")
	default:
		return lipgloss.Color("#8b949e")
	}
}

func styled(s, color string) string {
	return lipgloss.NewStyle().Foreground(lipColor(color)).Render(s)
}

func paint(s string) string {
	s = boldRE.ReplaceAllString(s, lipgloss.NewStyle().Bold(true).Render("$1"))
	s = codeRE.ReplaceAllString(s, lipgloss.NewStyle().Foreground(lipgloss.Color("#56d4dd")).Render("$1"))
	return s
}

// glowRender uses Glamour, the Markdown renderer behind charmbracelet/glow, to
// give lesson explanations the same polished terminal typography.
func glowRender(markdown string, width int) string {
	r, err := glamour.NewTermRenderer(glamour.WithAutoStyle(), glamour.WithWordWrap(width))
	if err != nil {
		return markdown
	}
	out, err := r.Render(markdown)
	if err != nil {
		return markdown
	}
	return strings.TrimRight(out, "\n")
}

func wrap(text string, width int, indent string) string {
	words := strings.Fields(text)
	lines := []string{}
	line := ""
	for _, w := range words {
		candidate := w
		if line != "" {
			candidate = line + " " + w
		}
		if len(stripANSI(candidate)) > width && line != "" {
			lines = append(lines, indent+line)
			line = w
		} else {
			line = candidate
		}
	}
	if line != "" {
		lines = append(lines, indent+line)
	}
	return strings.Join(lines, "\n")
}

func rule() {
	fmt.Println(lipgloss.NewStyle().Foreground(lipgloss.Color("#30363d")).Render(strings.Repeat("─", 76)))
}

func box(title string, lines []string, color string) {
	content := append([]string{styled(title, color), ""}, lines...)
	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipColor(color)).
		Padding(0, 1).
		Width(76)
	fmt.Println(style.Render(lipgloss.JoinVertical(lipgloss.Left, content...)))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func showCommand(cmd string) {
	fmt.Printf("\n  %s  %s%s\n\n", styled("$", green), styled(cmd, green), reset)
}

func clear() { fmt.Print("\x1b[2J\x1b[H") }

func isTTY() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && (fi.Mode()&os.ModeCharDevice) != 0
}

// readKey reads one key. In raw TTY mode it understands arrows; otherwise it
// reads a line. It returns "enter", "up", "down", "esc", or a lowercase key.
func readKey(prompt string) string {
	fmt.Print(prompt)
	if !isTTY() {
		line, _ := stdinReader.ReadString('\n')
		return strings.ToLower(strings.TrimSpace(line))
	}

	state := exec.Command("stty", "-g")
	state.Stdin = os.Stdin
	saved, err := state.Output()
	if err == nil {
		raw := exec.Command("stty", "-echo", "-icanon", "min", "1", "time", "0")
		raw.Stdin = os.Stdin
		_ = raw.Run()
		defer func() {
			restore := exec.Command("stty", strings.TrimSpace(string(saved)))
			restore.Stdin = os.Stdin
			_ = restore.Run()
		}()
	}

	buf := make([]byte, 1)
	if _, err := os.Stdin.Read(buf); err != nil {
		return ""
	}
	b := buf[0]
	switch b {
	case '\r', '\n':
		fmt.Println()
		return "enter"
	case 3:
		fmt.Println()
		os.Exit(0)
	case 27:
		seq := make([]byte, 2)
		_, _ = io.ReadFull(os.Stdin, seq)
		fmt.Println()
		if seq[0] == '[' && seq[1] == 'A' {
			return "up"
		}
		if seq[0] == '[' && seq[1] == 'B' {
			return "down"
		}
		return "esc"
	default:
		fmt.Println()
		return strings.ToLower(string(b))
	}
	return ""
}

func readLine(prompt string) string {
	fmt.Print(prompt)
	line, _ := stdinReader.ReadString('\n')
	return strings.TrimSpace(line)
}

func parseJSONMap(raw string) map[string]any {
	var m map[string]any
	if json.Unmarshal([]byte(raw), &m) != nil {
		return nil
	}
	return m
}

type menuOption struct {
	Label       string
	Description string
}

type menuModel struct {
	title    string
	options  []menuOption
	cursor   int
	selected int
}

func (m menuModel) Init() tea.Cmd { return nil }

func (m menuModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch key.String() {
	case "up", "k", "ctrl+p":
		m.cursor = (m.cursor - 1 + len(m.options)) % len(m.options)
	case "down", "j", "ctrl+n":
		m.cursor = (m.cursor + 1) % len(m.options)
	case "enter":
		m.selected = m.cursor
		return m, tea.Quit
	case "q", "esc", "ctrl+c":
		m.selected = -1
		return m, tea.Quit
	default:
		if n, err := strconv.Atoi(key.String()); err == nil && n >= 1 && n <= len(m.options) {
			m.cursor = n - 1
			m.selected = n - 1
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m menuModel) View() string {
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#d2a8ff")).Render(m.title)
	lines := []string{"", title, ""}
	for i, o := range m.options {
		label := o.Label
		if o.Description != "" {
			label += "  " + lipgloss.NewStyle().Foreground(lipgloss.Color("#8b949e")).Render(o.Description)
		}
		if i == m.cursor {
			label = lipgloss.NewStyle().Foreground(lipgloss.Color("#7ee787")).Bold(true).Render("❯ " + label)
		} else {
			label = "  " + label
		}
		lines = append(lines, label)
	}
	help := lipgloss.NewStyle().Foreground(lipgloss.Color("#8b949e")).Render("\n↑/↓ move · Enter select · q quit")
	lines = append(lines, help)
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func selectMenu(title string, options []menuOption) int {
	if len(options) == 0 {
		return -1
	}
	if !isTTY() {
		fmt.Printf("\n%s%s%s\n\n", bold, title, reset)
		for i, o := range options {
			fmt.Printf("  %s%d%s. %s\n", yellow, i+1, reset, o.Label)
		}
		ans := readKey(dim + "\nEnter a number (q to quit): " + reset)
		if ans == "q" {
			return -1
		}
		n, err := strconv.Atoi(ans)
		if err != nil || n < 1 || n > len(options) {
			return -1
		}
		return n - 1
	}

	model := menuModel{title: title, options: options}
	p := tea.NewProgram(model, tea.WithAltScreen())
	final, err := p.Run()
	if err != nil || final == nil {
		return -1
	}
	return final.(menuModel).selected
}

type finishMsg struct{}

type spinnerModel struct {
	spinner spinner.Model
	label   string
	done    bool
}

func (m spinnerModel) Init() tea.Cmd { return m.spinner.Tick }

func (m spinnerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case finishMsg:
		m.done = true
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m spinnerModel) View() string {
	if m.done {
		return ""
	}
	return m.spinner.View() + " " + m.label
}

// spinner starts an animated Charmbracelet spinner and returns a stop function.
// Non-interactive invocations print one quiet line instead of escape sequences.
func startSpinner(label string) func() {
	if !isTTY() {
		fmt.Printf("%s%s%s %s\n", cyan, "•", reset, label)
		var once sync.Once
		return func() { once.Do(func() {}) }
	}
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("#56d4dd"))
	p := tea.NewProgram(spinnerModel{spinner: s, label: label})
	go func() { _, _ = p.Run() }()
	var once sync.Once
	return func() {
		once.Do(func() {
			p.Send(finishMsg{})
			p.Wait()
		})
	}
}

func projectRoot() string {
	wd, _ := os.Getwd()
	return wd
}

func shellCommand(ctx context.Context, cmd string, stream bool) (bool, string) {
	c := exec.CommandContext(ctx, "sh", "-c", cmd)
	c.Dir = projectRoot()
	var buf bytes.Buffer
	if stream {
		c.Stdout = io.MultiWriter(os.Stdout, &buf)
		c.Stderr = io.MultiWriter(os.Stderr, &buf)
	} else {
		c.Stdout = &buf
		c.Stderr = &buf
	}
	err := c.Run()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			fmt.Println(yellow + "  command timed out" + reset)
		}
		return false, strings.TrimSpace(buf.String())
	}
	return true, strings.TrimSpace(buf.String())
}

func runCmd(cmd string) bool {
	fmt.Printf("%s┌ running %s%s\n", dim, styled(cmd, green), reset)
	ok, _ := shellCommand(context.Background(), cmd, true)
	code := styled("0", green)
	if !ok {
		code = styled("1", red)
	}
	fmt.Printf("%s└ exit %s%s\n", dim, code, reset)
	return ok
}

func runCmdCapture(cmd string) (bool, string) {
	fmt.Printf("%s┌ running %s%s\n", dim, styled(cmd, green), reset)
	ok, out := shellCommand(context.Background(), cmd, true)
	code := styled("0", green)
	if !ok {
		code = styled("1", red)
	}
	fmt.Printf("%s└ exit %s%s\n", dim, code, reset)
	return ok, out
}

// explainStep prints the meaning of a command's output. Lesson explanations are
// rendered with Glamour (the renderer used by charmbracelet/glow).
func explainStep(step Step, output string, ranHere bool) {
	fmt.Printf("\n%s\n", styled("HOW TO READ THE OUTPUT", green))
	explanation := step.Explain
	if explanation == "" {
		explanation = "This command changes or inspects live cluster state. Check that the resource names and values match what the lesson described."
	}
	fmt.Println(glowRender(explanation, 88))
	for _, cue := range outputCues(output) {
		fmt.Printf("  %s• %s%s\n", cyan, cue, reset)
	}
	if ranHere && output == "" {
		fmt.Printf("  %s• no output was produced; that is normal for some commands%s%s\n", dim, "", reset)
	}
}

func outputCues(output string) []string {
	if output == "" {
		return nil
	}
	low := strings.ToLower(output)
	cues := []string{}
	add := func(cond bool, msg string) {
		if cond {
			cues = append(cues, msg)
		}
	}
	add(strings.Contains(low, "ready") && !strings.Contains(low, "notready"), "`Ready` means the kubelet is healthy and registered with the API server.")
	add(strings.Contains(low, "containercreating") || strings.Contains(low, "pending"), "`Pending`/`ContainerCreating` means the pod has been accepted but is not serving yet — wait a moment.")
	add(strings.Contains(low, "created") || strings.Contains(low, "configured") || strings.Contains(low, "serverside-applied"), "`created`/`configured` means the API server accepted your manifest.")
	add(strings.Contains(low, "blocked") || strings.Contains(low, "000") || strings.Contains(low, "exit status 7") || strings.Contains(low, "exit status 28"), "`BLOCKED`/`000`/curl exit 7 or 28 means the connection was refused or timed out — exactly what a deny policy should look like.")
	add(http200RE.MatchString(output), "`200` is a successful HTTP response from the requested Service.")
	add(strings.Contains(low, "strict"), "`STRICT` means the sidecars require an authenticated mTLS handshake.")
	add(strings.Contains(low, "external-ip"), "An EXTERNAL-IP has been assigned by MetalLB from the configured pool.")
	if len(cues) > 4 {
		return cues[:4]
	}
	return cues
}

func progressBar(done, total, width int) string {
	filled := 0
	if total > 0 {
		filled = (done * width) / total
	}
	return styled(strings.Repeat("█", filled), green) + lipgloss.NewStyle().Foreground(lipgloss.Color("#30363d")).Render(strings.Repeat("░", width-filled))
}

func progressLine(p *Progress, ids []string) string {
	done := passedCount(p, ids)
	return fmt.Sprintf("%s %s%d/%d%s", progressBar(done, len(ids), 20), bold, done, len(ids), reset)
}
