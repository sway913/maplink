package frp

import (
	"strings"
	"testing"
)

func validSettings() Settings {
	return Settings{
		BindPort:             7000,
		ControlPorts:         []PortRange{{Start: 7000, End: 7010}},
		KCPBindPort:          7000,
		QUICBindPort:         7002,
		VhostHTTPPort:        8080,
		VhostHTTPSPort:       8443,
		TCPMuxHTTPPort:       7100,
		DashboardPort:        7500,
		Token:                "a-long-random-token",
		DashboardUser:        "frp-internal",
		DashboardPassword:    "another-long-random-secret",
		AllowedPorts:         []PortRange{{Start: 30000, End: 39999}, {Start: 41000, End: 50000}},
		MaxPortsPerClient:    50,
		MaxPoolCount:         20,
		TLSEnforced:          true,
		DetailedClientErrors: false,
	}
}

func TestSettingsValidateAcceptsTCPControlPortRangeAlongsideUDPTransports(t *testing.T) {
	s := validSettings()
	if err := s.Validate([]int{22, 443, 7400}); err != nil {
		t.Fatalf("expected 7000-7010 control range to be valid, got %v", err)
	}
	ports := s.ExpandedControlPorts()
	if len(ports) != 11 || ports[0] != 7000 || ports[10] != 7010 {
		t.Fatalf("unexpected expanded ports: %v", ports)
	}
}

func TestSettingsValidateRejectsControlRangeWithoutPrimaryPort(t *testing.T) {
	s := validSettings()
	s.ControlPorts = []PortRange{{Start: 7001, End: 7010}}
	if err := s.Validate(nil); err == nil || !strings.Contains(err.Error(), "主控制端口") {
		t.Fatalf("expected primary port error, got %v", err)
	}
}

func TestSettingsValidateRejectsControlRangeConflictingWithTCPListener(t *testing.T) {
	s := validSettings()
	s.TCPMuxHTTPPort = 7003
	if err := s.Validate(nil); err == nil || !strings.Contains(err.Error(), "TCPMUX") {
		t.Fatalf("expected TCP listener conflict, got %v", err)
	}
}

func TestSettingsValidateAcceptsIndependentTCPAndUDPPorts(t *testing.T) {
	s := validSettings()
	if err := s.Validate([]int{22, 443, 7400, 17920, 23333, 24444}); err != nil {
		t.Fatalf("expected valid settings, got %v", err)
	}
}

func TestSettingsValidateRejectsOverlappingRanges(t *testing.T) {
	s := validSettings()
	s.AllowedPorts = []PortRange{{Start: 30000, End: 40000}, {Start: 39999, End: 50000}}
	if err := s.Validate(nil); err == nil || !strings.Contains(err.Error(), "重叠") {
		t.Fatalf("expected overlap error, got %v", err)
	}
}

func TestSettingsValidateRejectsOccupiedOrListenerPortInAllowedRange(t *testing.T) {
	for _, tc := range []struct {
		name     string
		occupied []int
	}{
		{name: "existing service", occupied: []int{35000}},
		{name: "manager listener", occupied: []int{7400}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := validSettings()
			s.AllowedPorts = []PortRange{{Start: 7000, End: 36000}}
			if err := s.Validate(tc.occupied); err == nil {
				t.Fatal("expected conflicting port validation error")
			}
		})
	}
}

func TestRenderIncludesOfficialFRPSOptionsAndAllRanges(t *testing.T) {
	got, err := validSettings().RenderTOML()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"bindPort = 7000",
		"kcpBindPort = 7000",
		"quicBindPort = 7002",
		"webServer.addr = \"127.0.0.1\"",
		"enablePrometheus = true",
		"auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]",
		"transport.tls.force = true",
		"{ start = 30000, end = 39999 }",
		"{ start = 41000, end = 50000 }",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered config missing %q\n%s", want, got)
		}
	}
	if strings.Count(got, "bindPort =") != 1 {
		t.Fatalf("official frps config must keep one bindPort, got:\n%s", got)
	}
}
