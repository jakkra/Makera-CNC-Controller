package service

import (
	"bufio"
	"reflect"
	"strings"
	"testing"
)

func TestLeadingGcodeNotesSkipsToolsAndStopsAtMotion(t *testing.T) {
	program := "%\n(Program: bracket)\n(T1 D=3.175 CR=0 - flat end mill)\n; Sensei alignment setup v2 1 2 3\n; Two holes\nG21\n(Op: Face)\nG0 X1\n(after motion)\n"
	got := leadingGcodeNotes(bufio.NewScanner(strings.NewReader(program)), 4)
	want := []string{"Program: bracket", "Two holes", "Op: Face"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("notes = %q, want %q", got, want)
	}
}

func TestLeadingGcodeNotesSkipsTheCAMMachineBlockAndRules(t *testing.T) {
	program := "(1001-fix1)\n(Machine)\n(  vendor: Makera)\n(  model: Carvera)\n(=====================)\n(Washer seat)\nG90\n"
	got := leadingGcodeNotes(bufio.NewScanner(strings.NewReader(program)), 4)
	if want := []string{"1001-fix1", "Washer seat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("notes = %q, want %q", got, want)
	}
}
