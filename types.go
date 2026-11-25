package main

// Step is one guided action in a lesson.
//
// Cmd is shown for the learner to run. Explain is printed after the learner
// confirms they ran it (or after the CLI runs it with [r]), so the output is
// never left unexplained. Note is optional pre-run context.
type Step struct {
	Title   string
	Cmd     string
	Note    string
	Explain string
}

// Lesson is a single verified exercise.
type Lesson struct {
	ID           string
	Title        string
	Min          int
	ChapterID    string
	ChapterTitle string
	Checks       []string
	Concept      []string
	Diagram      string
	Steps        []Step
	Task         string
	Hint         string
	Solution     []string
	Takeaway     string
}

// Chapter groups lessons.
type Chapter struct {
	ID       string
	Title    string
	Subtitle string
	Lessons  []Lesson
}

// CheckResult is returned by every verifier.
type CheckResult struct {
	ID     string
	Label  string
	Hint   string
	OK     bool
	Detail string
}

// Check is a named real-cluster verification.
type Check struct {
	ID    string
	Label string
	Hint  string
	Run   func() CheckResult
}

// LessonRecord is persisted progress for one lesson.
type LessonRecord struct {
	Attempts   int    `json:"attempts,omitempty"`
	Passed     bool   `json:"passed"`
	PassedAt   string `json:"passedAt,omitempty"`
	LastDetail string `json:"lastDetail,omitempty"`
}

// Progress is the on-disk progress file.
type Progress struct {
	Lessons   map[string]*LessonRecord `json:"lessons"`
	Current   string                   `json:"current,omitempty"`
	StartedAt int64                    `json:"startedAt"`
}
