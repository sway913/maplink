package manager

import (
	"strings"
	"testing"

	"frp-manager/internal/frp"
)

func TestRenderControlNFTConfigExpandsRangeAndSkipsPrimary(t *testing.T) {
	got, count, err := renderControlNFTConfig(7000, []frp.PortRange{{Start: 7000, End: 7010}}, "203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	if count != 10 {
		t.Fatalf("expected 10 redirected ports, got %d", count)
	}
	for _, expected := range []string{
		"delete table inet frp_manager",
		"elements = { 7001-7010 }",
		"tcp dport @control_ports redirect to :7000",
		"ip daddr 203.0.113.10 tcp dport @control_ports redirect to :7000",
	} {
		if !strings.Contains(got, expected) {
			t.Errorf("missing %q in:\n%s", expected, got)
		}
	}
	if strings.Contains(got, "elements = { 7000-") {
		t.Fatalf("primary port must not be redirected:\n%s", got)
	}
}

func TestRenderControlNFTConfigSplitsRangeAroundPrimary(t *testing.T) {
	got, count, err := renderControlNFTConfig(7005, []frp.PortRange{{Start: 7000, End: 7010}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if count != 10 || !strings.Contains(got, "elements = { 7000-7004, 7006-7010 }") {
		t.Fatalf("unexpected split range:\n%s", got)
	}
}
