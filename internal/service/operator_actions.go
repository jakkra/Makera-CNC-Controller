package service

import (
	"regexp"
	"strings"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
)

var operatorToolChange = regexp.MustCompile(`(?i)(?:^|\s)M0*6(?:T|\s|$)`)
var operatorPause = regexp.MustCompile(`(?i)(?:^|\s)M0*[01](?:\s|$)`)
var operatorContinue = regexp.MustCompile(`(?i)(?:^|\s)(?:M490\.2|M0*999|G0*28|\$X)(?:\s|$)`)

func (s *Service) operatorCommandIntent(line string) func() {
	line = strings.TrimSpace(strings.SplitN(line, ";", 2)[0])
	switch {
	case operatorToolChange.MatchString(line):
		return s.attention.BeginOperatorAction([]machine.State{machine.Tool}, false)
	case strings.EqualFold(line, "suspend") || operatorPause.MatchString(line):
		return s.attention.BeginOperatorAction([]machine.State{machine.Pause, machine.Wait, machine.Hold}, false)
	case strings.EqualFold(line, "resume") || operatorContinue.MatchString(line):
		return s.attention.BeginOperatorAction(nil, true)
	default:
		return func() {}
	}
}

func (s *Service) sendOperatorGcode(c *client.Conn, line string, opts client.GcodeOpts) (string, error) {
	cancel := s.operatorCommandIntent(line)
	out, err := c.SendGcodeLine(line, opts)
	if err != nil {
		cancel()
	}
	return out, err
}

func (s *Service) sendOperatorConsole(c *client.Conn, line string, opts client.GcodeOpts) (string, error) {
	cancel := s.operatorCommandIntent(line)
	out, err := c.SendConsoleCommand(line, opts)
	if err != nil {
		cancel()
	}
	return out, err
}
