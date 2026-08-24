package frp

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type PortRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type Settings struct {
	BindPort             int         `json:"bindPort"`
	ControlPorts         []PortRange `json:"controlPorts"`
	KCPBindPort          int         `json:"kcpBindPort"`
	QUICBindPort         int         `json:"quicBindPort"`
	VhostHTTPPort        int         `json:"vhostHTTPPort"`
	VhostHTTPSPort       int         `json:"vhostHTTPSPort"`
	TCPMuxHTTPPort       int         `json:"tcpMuxHTTPPort"`
	DashboardPort        int         `json:"dashboardPort"`
	Token                string      `json:"token"`
	DashboardUser        string      `json:"dashboardUser"`
	DashboardPassword    string      `json:"dashboardPassword"`
	AllowedPorts         []PortRange `json:"allowedPorts"`
	MaxPortsPerClient    int         `json:"maxPortsPerClient"`
	MaxPoolCount         int         `json:"maxPoolCount"`
	TLSEnforced          bool        `json:"tlsEnforced"`
	DetailedClientErrors bool        `json:"detailedClientErrors"`
}

func (s Settings) EffectiveControlPorts() []PortRange {
	if len(s.ControlPorts) == 0 {
		return []PortRange{{Start: s.BindPort, End: s.BindPort}}
	}
	return append([]PortRange(nil), s.ControlPorts...)
}

func (s Settings) ExpandedControlPorts() []int {
	ranges := s.EffectiveControlPorts()
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Start < ranges[j].Start })
	ports := make([]int, 0)
	for _, portRange := range ranges {
		for port := portRange.Start; port <= portRange.End; port++ {
			ports = append(ports, port)
		}
	}
	return ports
}

func validPort(port int, optional bool) error {
	if optional && port == 0 {
		return nil
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("端口 %d 超出 1-65535 范围", port)
	}
	return nil
}

func (s Settings) Validate(occupied []int) error {
	ports := []struct {
		name     string
		value    int
		optional bool
	}{
		{"控制端口", s.BindPort, false},
		{"KCP 端口", s.KCPBindPort, true},
		{"QUIC 端口", s.QUICBindPort, true},
		{"HTTP 虚拟主机端口", s.VhostHTTPPort, true},
		{"HTTPS 虚拟主机端口", s.VhostHTTPSPort, true},
		{"TCPMUX 端口", s.TCPMuxHTTPPort, true},
		{"原生仪表盘端口", s.DashboardPort, false},
	}
	for _, port := range ports {
		if err := validPort(port.value, port.optional); err != nil {
			return fmt.Errorf("%s: %w", port.name, err)
		}
	}

	controlRanges := s.EffectiveControlPorts()
	if len(controlRanges) > 8 {
		return errors.New("客户端接入端口段最多允许 8 段")
	}
	sort.Slice(controlRanges, func(i, j int) bool { return controlRanges[i].Start < controlRanges[j].Start })
	primaryIncluded := false
	controlPortCount := 0
	for index, portRange := range controlRanges {
		if err := validPort(portRange.Start, false); err != nil {
			return fmt.Errorf("客户端接入端口段起点: %w", err)
		}
		if err := validPort(portRange.End, false); err != nil {
			return fmt.Errorf("客户端接入端口段终点: %w", err)
		}
		if portRange.Start < 1024 {
			return errors.New("客户端接入端口必须不小于 1024")
		}
		if portRange.Start > portRange.End {
			return fmt.Errorf("客户端接入端口段 %d-%d 的起点不能大于终点", portRange.Start, portRange.End)
		}
		if index > 0 && portRange.Start <= controlRanges[index-1].End {
			return fmt.Errorf("客户端接入端口段 %d-%d 与 %d-%d 重叠", controlRanges[index-1].Start, controlRanges[index-1].End, portRange.Start, portRange.End)
		}
		if s.BindPort >= portRange.Start && s.BindPort <= portRange.End {
			primaryIncluded = true
		}
		controlPortCount += portRange.End - portRange.Start + 1
		if controlPortCount > 64 {
			return errors.New("客户端接入端口总数不能超过 64 个")
		}
	}
	if !primaryIncluded {
		return fmt.Errorf("客户端接入端口段必须包含主控制端口 %d", s.BindPort)
	}

	// TCP and UDP have independent namespaces. KCP may therefore intentionally
	// share its number with the TCP bind port, matching the official example.
	tcpSeen := map[int]string{}
	for _, port := range s.ExpandedControlPorts() {
		tcpSeen[port] = "客户端接入端口"
	}
	for _, port := range []struct {
		name  string
		value int
	}{
		{"HTTP 虚拟主机端口", s.VhostHTTPPort},
		{"HTTPS 虚拟主机端口", s.VhostHTTPSPort},
		{"TCPMUX 端口", s.TCPMuxHTTPPort},
		{"原生仪表盘端口", s.DashboardPort},
	} {
		if port.value == 0 {
			continue
		}
		if previous, ok := tcpSeen[port.value]; ok {
			return fmt.Errorf("%s与%s不能共用 TCP %d", previous, port.name, port.value)
		}
		tcpSeen[port.value] = port.name
	}
	if s.KCPBindPort != 0 && s.KCPBindPort == s.QUICBindPort {
		return errors.New("KCP 与 QUIC 不能共用同一个 UDP 端口")
	}
	if len(strings.TrimSpace(s.Token)) < 16 {
		return errors.New("认证 Token 至少需要 16 个字符")
	}
	if len(strings.TrimSpace(s.DashboardUser)) < 4 || len(s.DashboardPassword) < 16 {
		return errors.New("原生仪表盘内部凭据不符合安全要求")
	}
	if s.MaxPortsPerClient < 1 || s.MaxPortsPerClient > 10000 {
		return errors.New("每客户端最大端口数必须在 1-10000 之间")
	}
	if s.MaxPoolCount < 1 || s.MaxPoolCount > 10000 {
		return errors.New("最大连接池数量必须在 1-10000 之间")
	}
	if len(s.AllowedPorts) == 0 || len(s.AllowedPorts) > 32 {
		return errors.New("允许端口段数量必须在 1-32 之间")
	}

	ranges := append([]PortRange(nil), s.AllowedPorts...)
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Start < ranges[j].Start })
	reserved := map[int]bool{}
	occupiedSet := map[int]bool{}
	for _, port := range occupied {
		if port > 0 && port <= 65535 {
			reserved[port] = true
			occupiedSet[port] = true
		}
	}
	for _, port := range ports {
		if port.value > 0 {
			reserved[port.value] = true
		}
	}
	for _, port := range s.ExpandedControlPorts() {
		if port != s.BindPort && occupiedSet[port] {
			return fmt.Errorf("客户端接入端口 %d 已被系统占用", port)
		}
		reserved[port] = true
	}
	for index, portRange := range ranges {
		if err := validPort(portRange.Start, false); err != nil {
			return fmt.Errorf("端口段起点: %w", err)
		}
		if err := validPort(portRange.End, false); err != nil {
			return fmt.Errorf("端口段终点: %w", err)
		}
		if portRange.Start > portRange.End {
			return fmt.Errorf("端口段 %d-%d 的起点不能大于终点", portRange.Start, portRange.End)
		}
		if index > 0 && portRange.Start <= ranges[index-1].End {
			return fmt.Errorf("端口段 %d-%d 与 %d-%d 重叠", ranges[index-1].Start, ranges[index-1].End, portRange.Start, portRange.End)
		}
		for port := range reserved {
			if port >= portRange.Start && port <= portRange.End {
				return fmt.Errorf("允许端口段 %d-%d 包含已占用或保留端口 %d", portRange.Start, portRange.End, port)
			}
		}
	}
	return nil
}

func (s Settings) RenderTOML() (string, error) {
	if err := s.Validate(nil); err != nil {
		return "", err
	}
	var out strings.Builder
	out.WriteString("# Generated by MapLink Server. Edit through the management console.\n")
	out.WriteString("bindAddr = \"0.0.0.0\"\n")
	fmt.Fprintf(&out, "bindPort = %d\n", s.BindPort)
	if s.KCPBindPort != 0 {
		fmt.Fprintf(&out, "kcpBindPort = %d\n", s.KCPBindPort)
	}
	if s.QUICBindPort != 0 {
		fmt.Fprintf(&out, "quicBindPort = %d\n", s.QUICBindPort)
	}
	if s.VhostHTTPPort != 0 {
		fmt.Fprintf(&out, "vhostHTTPPort = %d\n", s.VhostHTTPPort)
	}
	if s.VhostHTTPSPort != 0 {
		fmt.Fprintf(&out, "vhostHTTPSPort = %d\n", s.VhostHTTPSPort)
	}
	if s.TCPMuxHTTPPort != 0 {
		fmt.Fprintf(&out, "tcpmuxHTTPConnectPort = %d\n", s.TCPMuxHTTPPort)
	}
	out.WriteString("webServer.addr = \"127.0.0.1\"\n")
	fmt.Fprintf(&out, "webServer.port = %d\n", s.DashboardPort)
	fmt.Fprintf(&out, "webServer.user = %s\n", strconv.Quote(s.DashboardUser))
	fmt.Fprintf(&out, "webServer.password = %s\n", strconv.Quote(s.DashboardPassword))
	out.WriteString("enablePrometheus = true\n")
	out.WriteString("auth.method = \"token\"\n")
	fmt.Fprintf(&out, "auth.token = %s\n", strconv.Quote(s.Token))
	out.WriteString("auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]\n")
	fmt.Fprintf(&out, "transport.maxPoolCount = %d\n", s.MaxPoolCount)
	fmt.Fprintf(&out, "transport.tls.force = %t\n", s.TLSEnforced)
	fmt.Fprintf(&out, "maxPortsPerClient = %d\n", s.MaxPortsPerClient)
	out.WriteString("udpPacketSize = 1500\n")
	fmt.Fprintf(&out, "detailedErrorsToClient = %t\n", s.DetailedClientErrors)
	out.WriteString("allowPorts = [\n")
	for _, portRange := range s.AllowedPorts {
		if portRange.Start == portRange.End {
			fmt.Fprintf(&out, "  { single = %d },\n", portRange.Start)
		} else {
			fmt.Fprintf(&out, "  { start = %d, end = %d },\n", portRange.Start, portRange.End)
		}
	}
	out.WriteString("]\n")
	return out.String(), nil
}
