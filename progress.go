package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const progressFile = ".kt-progress.json"

func progressPath() string {
	wd, err := os.Getwd()
	if err != nil {
		return progressFile
	}
	return filepath.Join(wd, progressFile)
}

func loadProgress() *Progress {
	p := &Progress{
		Lessons:   map[string]*LessonRecord{},
		StartedAt: time.Now().UnixMilli(),
	}
	b, err := os.ReadFile(progressPath())
	if err != nil || len(b) == 0 {
		return p
	}
	var loaded Progress
	if err := json.Unmarshal(b, &loaded); err != nil {
		return p
	}
	if loaded.Lessons == nil {
		loaded.Lessons = map[string]*LessonRecord{}
	}
	if loaded.StartedAt == 0 {
		loaded.StartedAt = time.Now().UnixMilli()
	}
	return &loaded
}

func saveProgress(p *Progress) {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(progressPath(), append(b, '\n'), 0o644)
}

func record(p *Progress, id string) *LessonRecord {
	r := p.Lessons[id]
	if r == nil {
		r = &LessonRecord{}
		p.Lessons[id] = r
	}
	return r
}

func isDone(p *Progress, id string) bool {
	return p.Lessons[id] != nil && p.Lessons[id].Passed
}

func setCurrent(p *Progress, id string) {
	p.Current = id
	saveProgress(p)
}

func markPass(p *Progress, id, detail string) {
	r := record(p, id)
	if !r.Passed {
		r.Passed = true
		r.PassedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	r.Attempts++
	r.LastDetail = detail
	saveProgress(p)
}

func markAttempt(p *Progress, id, detail string) {
	r := record(p, id)
	r.Attempts++
	r.LastDetail = detail
	saveProgress(p)
}

func passedCount(p *Progress, ids []string) int {
	n := 0
	for _, id := range ids {
		if isDone(p, id) {
			n++
		}
	}
	return n
}
