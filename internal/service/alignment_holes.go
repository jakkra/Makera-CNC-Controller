package service

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/store"
)

const alignmentProgramPrefix = "alignment-holes-"
const alignmentSetupHeader = "; Sensei alignment setup v1 "
const alignmentSetupToleranceMM = 0.01

type alignmentSetup struct {
	tool   int
	offset float64
	origin [3]float64
}

func isAlignmentProgram(remotePath string) bool {
	return strings.HasPrefix(path.Base(remotePath), alignmentProgramPrefix)
}

func readAlignmentSetup(entry store.Entry) (alignmentSetup, error) {
	var setup alignmentSetup
	invalid := fmt.Errorf("%w: alignment hole setup could not be read; queue a new program", ErrActiveGcodeUnavailable)
	if entry.CachePath == "" || entry.CacheState != store.CacheReady {
		return setup, invalid
	}
	file, err := os.Open(entry.CachePath)
	if err != nil {
		return setup, invalid
	}
	defer file.Close()
	line, err := bufio.NewReader(io.LimitReader(file, 256)).ReadString('\n')
	if err != nil {
		return setup, invalid
	}
	header, ok := strings.CutPrefix(line, alignmentSetupHeader)
	values := strings.Fields(header)
	if !ok || len(values) != 5 {
		return setup, invalid
	}
	setup.tool, err = strconv.Atoi(values[0])
	if err != nil || setup.tool < 1 || setup.tool > 999 {
		return setup, invalid
	}
	targets := []*float64{&setup.offset, &setup.origin[0], &setup.origin[1], &setup.origin[2]}
	for i, target := range targets {
		value, valid := parseMachineNumber(values[i+1])
		if !valid {
			return setup, invalid
		}
		*target = value
	}
	return setup, nil
}

func (setup alignmentSetup) verify(st machine.Status) error {
	if st.Tool == nil || st.Tool.Active != setup.tool || !finite(st.Tool.Offset) ||
		math.Abs(st.Tool.Offset-setup.offset) > alignmentSetupToleranceMM {
		return fmt.Errorf("%w: restore calibrated tool T%d before running the alignment holes", ErrActiveGcodeUnavailable, setup.tool)
	}
	if raw, reported := st.Fields["R"]; reported {
		rotation, valid := parseMachineNumber(raw)
		if !valid || rotation != 0 {
			return fmt.Errorf("%w: clear work coordinate rotation before running the alignment holes", ErrActiveGcodeUnavailable)
		}
	}
	if st.Controller != nil && st.Controller.InchMode {
		return fmt.Errorf("%w: switch to millimeters before running the alignment holes", ErrActiveGcodeUnavailable)
	}
	for i, axis := range [...]string{"x", "y", "z"} {
		m, haveMachine := finiteAxisValue(st.MPos, axis)
		w, haveWork := finiteAxisValue(st.WPos, axis)
		if !haveMachine || !haveWork || math.Abs(m-w-setup.origin[i]) > alignmentSetupToleranceMM {
			return fmt.Errorf("%w: restore the work zero used to queue the alignment holes", ErrActiveGcodeUnavailable)
		}
	}
	return nil
}
