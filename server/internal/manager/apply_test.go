package manager

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"frp-manager/internal/frp"
)

type fakeRunner struct {
	verifyErr  error
	restartErr error
	controlErr error
	restarts   int
	controls   int
}

func (f *fakeRunner) Verify(string) error { return f.verifyErr }
func (f *fakeRunner) Restart() error {
	f.restarts++
	return f.restartErr
}
func (f *fakeRunner) ConfigureControlPorts(int, []frp.PortRange) error {
	f.controls++
	return f.controlErr
}

func TestApplyWritesVerifiedConfigAndState(t *testing.T) {
	dir := t.TempDir()
	store := &Store{
		StatePath:  filepath.Join(dir, "state.json"),
		ConfigPath: filepath.Join(dir, "frps.toml"),
		Runner:     &fakeRunner{},
	}
	s := frp.Settings{
		BindPort: 7000, ControlPorts: []frp.PortRange{{Start: 7000, End: 7010}}, KCPBindPort: 7000, QUICBindPort: 7002,
		VhostHTTPPort: 8080, VhostHTTPSPort: 8443, TCPMuxHTTPPort: 7100,
		DashboardPort: 7500, Token: "0123456789abcdef",
		DashboardUser: "internal-user", DashboardPassword: "0123456789abcdef",
		AllowedPorts:      []frp.PortRange{{Start: 30000, End: 50000}},
		MaxPortsPerClient: 50, MaxPoolCount: 20, TLSEnforced: true,
	}
	if err := store.Apply(s, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.StatePath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.ConfigPath); err != nil {
		t.Fatal(err)
	}
	if runner := store.Runner.(*fakeRunner); runner.controls != 1 {
		t.Fatalf("expected control port proxy configuration, got %d", runner.controls)
	}
}

func TestApplyRollsBackWhenControlPortProxyFails(t *testing.T) {
	dir := t.TempDir()
	runner := &fakeRunner{controlErr: errors.New("socket proxy failed")}
	store := &Store{StatePath: filepath.Join(dir, "state.json"), ConfigPath: filepath.Join(dir, "frps.toml"), Runner: runner}
	s := frp.Settings{
		BindPort: 7000, ControlPorts: []frp.PortRange{{Start: 7000, End: 7010}}, DashboardPort: 7500,
		Token: "0123456789abcdef", DashboardUser: "internal-user", DashboardPassword: "0123456789abcdef",
		AllowedPorts: []frp.PortRange{{Start: 30000, End: 50000}}, MaxPortsPerClient: 50, MaxPoolCount: 20,
	}
	if err := store.Apply(s, nil); err == nil || !strings.Contains(err.Error(), "接入端口") {
		t.Fatalf("expected control proxy error, got %v", err)
	}
	if _, err := os.Stat(store.StatePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected state rollback, got %v", err)
	}
	if runner.controls != 2 {
		t.Fatalf("expected apply and rollback of control ports, got %d", runner.controls)
	}
}

func TestApplyRollsBackWhenRestartFails(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	configPath := filepath.Join(dir, "frps.toml")
	if err := os.WriteFile(statePath, []byte("old-state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("old-config"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{restartErr: errors.New("restart failed")}
	store := &Store{StatePath: statePath, ConfigPath: configPath, Runner: runner}
	s := frp.Settings{
		BindPort: 7000, DashboardPort: 7500, Token: "0123456789abcdef",
		DashboardUser: "internal-user", DashboardPassword: "0123456789abcdef",
		AllowedPorts:      []frp.PortRange{{Start: 30000, End: 50000}},
		MaxPortsPerClient: 50, MaxPoolCount: 20,
	}
	if err := store.Apply(s, nil); err == nil {
		t.Fatal("expected restart failure")
	}
	got, _ := os.ReadFile(configPath)
	if string(got) != "old-config" {
		t.Fatalf("expected config rollback, got %q", got)
	}
	if runner.restarts != 2 {
		t.Fatalf("expected failed restart plus rollback restart, got %d", runner.restarts)
	}
}
