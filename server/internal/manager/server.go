package manager

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"frp-manager/internal/auth"
	"frp-manager/internal/frp"
)

type ServerOptions struct {
	Store         *Store
	System        SystemRunner
	AdminUser     string
	AdminHash     string
	AdminHashPath string
	PublicIP      string
	WebRoot       string
	ManagerPort   int
	SessionSecure bool
}

type session struct {
	CSRF      string
	ExpiresAt time.Time
}

type attempt struct {
	Count        int
	BlockedUntil time.Time
}

type Server struct {
	options       ServerOptions
	mux           *http.ServeMux
	client        *http.Client
	mu            sync.Mutex
	credentialsMu sync.Mutex
	adminHash     string
	sessions      map[string]session
	attempts      map[string]attempt
	remote        *remoteHub
}

func randomToken(bytes int) (string, error) {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func NewServer(options ServerOptions) (*Server, error) {
	if options.Store == nil || options.Store.Runner == nil {
		return nil, errors.New("配置仓储未初始化")
	}
	if options.AdminUser == "" || options.AdminHash == "" {
		return nil, errors.New("管理员凭据未配置")
	}
	adminHash := strings.TrimSpace(options.AdminHash)
	if options.AdminHashPath != "" {
		data, err := os.ReadFile(options.AdminHashPath)
		if err == nil {
			adminHash = strings.TrimSpace(string(data))
		} else if errors.Is(err, os.ErrNotExist) {
			if err := writeSecure(options.AdminHashPath, []byte(adminHash+"\n"), 0o600, 0); err != nil {
				return nil, fmt.Errorf("初始化管理员密码文件失败: %w", err)
			}
		} else {
			return nil, fmt.Errorf("读取管理员密码文件失败: %w", err)
		}
	}
	if !strings.HasPrefix(adminHash, "$pbkdf2-sha256$") {
		return nil, errors.New("管理员密码哈希格式无效")
	}
	if options.ManagerPort == 0 {
		options.ManagerPort = 7400
	}
	server := &Server{
		options:   options,
		mux:       http.NewServeMux(),
		client:    &http.Client{Timeout: 8 * time.Second},
		adminHash: adminHash,
		sessions:  map[string]session{},
		attempts:  map[string]attempt{},
		remote:    newRemoteHub(),
	}
	server.routes()
	return server, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("POST /api/auth/login", s.login)
	s.mux.HandleFunc("GET /api/auth/session", s.authenticated(s.sessionInfo))
	s.mux.HandleFunc("POST /api/auth/logout", s.authenticated(s.requireCSRF(s.logout)))
	s.mux.HandleFunc("POST /api/auth/password", s.authenticated(s.requireCSRF(s.changePassword)))
	s.mux.HandleFunc("GET /api/system", s.authenticated(s.systemInfo))
	s.mux.HandleFunc("GET /api/config", s.authenticated(s.getConfig))
	s.mux.HandleFunc("PUT /api/config", s.authenticated(s.requireCSRF(s.putConfig)))
	s.mux.HandleFunc("GET /api/credentials", s.authenticated(s.credentials))
	s.mux.HandleFunc("POST /api/credentials/rotate", s.authenticated(s.requireCSRF(s.rotateToken)))
	s.mux.HandleFunc("POST /api/service", s.authenticated(s.requireCSRF(s.serviceAction)))
	s.mux.HandleFunc("GET /api/logs", s.authenticated(s.logs))
	s.mux.HandleFunc("GET /api/ports", s.authenticated(s.ports))
	s.mux.HandleFunc("GET /api/frp/{resource...}", s.authenticated(s.frpAPI))
	s.mux.HandleFunc("GET /api/client/devices", s.onlineSSHDevices)
	s.mux.HandleFunc("GET /api/remote/devices", s.remoteDevices)
	s.mux.HandleFunc("POST /api/remote/hosts/heartbeat", s.remoteHostHeartbeat)
	s.mux.HandleFunc("GET /api/remote/hosts/{deviceID}/sessions", s.remoteHostSessions)
	s.mux.HandleFunc("POST /api/remote/sessions", s.remoteCreateSession)
	s.mux.HandleFunc("GET /api/remote/sessions/{sessionID}", s.remoteSessionStatus)
	s.mux.HandleFunc("DELETE /api/remote/sessions/{sessionID}", s.remoteCloseSession)
	s.mux.HandleFunc("POST /api/remote/sessions/{sessionID}/accept", s.remoteAcceptSession)
	s.mux.HandleFunc("POST /api/remote/sessions/{sessionID}/frames", s.remoteUploadFrame)
	s.mux.HandleFunc("GET /api/remote/sessions/{sessionID}/frames", s.remoteDownloadFrame)
	s.mux.HandleFunc("POST /api/remote/sessions/{sessionID}/inputs", s.remotePostInputs)
	s.mux.HandleFunc("GET /api/remote/sessions/{sessionID}/inputs", s.remotePollInputs)
	s.mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":   "ok",
			"version":  "0.5.1",
			"features": []string{"remote-control"},
		})
	})
	if s.options.WebRoot != "" {
		files := http.FileServer(http.Dir(s.options.WebRoot))
		s.mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			path := s.options.WebRoot + r.URL.Path
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				files.ServeHTTP(w, r)
				return
			}
			http.ServeFile(w, r, s.options.WebRoot+"/index.html")
		}))
	}
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		s.mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("请求格式无效: %w", err))
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, errors.New("请求只能包含一个 JSON 对象"))
		return false
	}
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	s.mu.Lock()
	a := s.attempts[ip]
	adminHash := s.adminHash
	if time.Now().Before(a.BlockedUntil) {
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, errors.New("登录尝试过多，请稍后重试"))
		return
	}
	s.mu.Unlock()
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Username != s.options.AdminUser || !auth.VerifyPassword(adminHash, body.Password) {
		s.mu.Lock()
		a = s.attempts[ip]
		a.Count++
		if a.Count >= 5 {
			a.BlockedUntil = time.Now().Add(5 * time.Minute)
			a.Count = 0
		}
		s.attempts[ip] = a
		s.mu.Unlock()
		writeError(w, http.StatusUnauthorized, errors.New("用户名或密码错误"))
		return
	}
	sessionID, err := randomToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	csrf, err := randomToken(24)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.mu.Lock()
	delete(s.attempts, ip)
	s.sessions[sessionID] = session{CSRF: csrf, ExpiresAt: time.Now().Add(12 * time.Hour)}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "frpm_session", Value: sessionID, Path: "/", HttpOnly: true, Secure: s.options.SessionSecure, SameSite: http.SameSiteStrictMode, MaxAge: 43200})
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrfToken": csrf, "username": s.options.AdminUser})
}

func (s *Server) currentSession(r *http.Request) (string, session, bool) {
	cookie, err := r.Cookie("frpm_session")
	if err != nil {
		return "", session{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.sessions[cookie.Value]
	if !ok || time.Now().After(current.ExpiresAt) {
		delete(s.sessions, cookie.Value)
		return "", session{}, false
	}
	current.ExpiresAt = time.Now().Add(12 * time.Hour)
	s.sessions[cookie.Value] = current
	return cookie.Value, current, true
}

func (s *Server) authenticated(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := s.currentSession(r); !ok {
			writeError(w, http.StatusUnauthorized, errors.New("请先登录"))
			return
		}
		next(w, r)
	}
}

func (s *Server) requireCSRF(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, current, ok := s.currentSession(r)
		if !ok || r.Header.Get("X-CSRF-Token") == "" || r.Header.Get("X-CSRF-Token") != current.CSRF {
			writeError(w, http.StatusForbidden, errors.New("CSRF 校验失败"))
			return
		}
		next(w, r)
	}
}

func (s *Server) sessionInfo(w http.ResponseWriter, r *http.Request) {
	_, current, _ := s.currentSession(r)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrfToken": current.CSRF, "username": s.options.AdminUser})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	id, _, _ := s.currentSession(r)
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "frpm_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.options.SessionSecure, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
		ConfirmPassword string `json:"confirmPassword"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.NewPassword != body.ConfirmPassword {
		writeError(w, http.StatusBadRequest, errors.New("两次输入的新密码不一致"))
		return
	}
	if body.CurrentPassword == body.NewPassword {
		writeError(w, http.StatusBadRequest, errors.New("新密码不能与当前密码相同"))
		return
	}
	if s.options.AdminHashPath == "" {
		writeError(w, http.StatusInternalServerError, errors.New("管理员密码持久化路径未配置"))
		return
	}

	s.credentialsMu.Lock()
	defer s.credentialsMu.Unlock()
	s.mu.Lock()
	currentHash := s.adminHash
	s.mu.Unlock()
	if !auth.VerifyPassword(currentHash, body.CurrentPassword) {
		writeError(w, http.StatusUnauthorized, errors.New("当前密码错误"))
		return
	}
	newHash, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := writeSecure(s.options.AdminHashPath, []byte(newHash+"\n"), 0o600, 0); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("保存新密码失败: %w", err))
		return
	}
	s.mu.Lock()
	s.adminHash = newHash
	s.sessions = map[string]session{}
	s.attempts = map[string]attempt{}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "frpm_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.options.SessionSecure, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "requiresLogin": true})
}

func (s *Server) publicIP() string {
	if s.options.PublicIP != "" {
		return s.options.PublicIP
	}
	return "unknown"
}

func (s *Server) systemInfo(w http.ResponseWriter, _ *http.Request) {
	hostname, _ := os.Hostname()
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"publicIP": s.publicIP(), "hostname": hostname, "frpVersion": s.options.System.Version(),
		"serviceState": s.options.System.ServiceState(), "bindPort": settings.BindPort,
		"controlPorts": settings.EffectiveControlPorts(), "allowedPorts": settings.AllowedPorts,
	})
}

type EditableConfig struct {
	BindPort             int             `json:"bindPort"`
	ControlPorts         []frp.PortRange `json:"controlPorts"`
	KCPBindPort          int             `json:"kcpBindPort"`
	QUICBindPort         int             `json:"quicBindPort"`
	VhostHTTPPort        int             `json:"vhostHTTPPort"`
	VhostHTTPSPort       int             `json:"vhostHTTPSPort"`
	TCPMuxHTTPPort       int             `json:"tcpMuxHTTPPort"`
	AllowedPorts         []frp.PortRange `json:"allowedPorts"`
	MaxPortsPerClient    int             `json:"maxPortsPerClient"`
	MaxPoolCount         int             `json:"maxPoolCount"`
	TLSEnforced          bool            `json:"tlsEnforced"`
	DetailedClientErrors bool            `json:"detailedClientErrors"`
}

func editable(settings frp.Settings) EditableConfig {
	return EditableConfig{
		BindPort: settings.BindPort, ControlPorts: settings.EffectiveControlPorts(),
		KCPBindPort: settings.KCPBindPort, QUICBindPort: settings.QUICBindPort,
		VhostHTTPPort: settings.VhostHTTPPort, VhostHTTPSPort: settings.VhostHTTPSPort,
		TCPMuxHTTPPort: settings.TCPMuxHTTPPort, AllowedPorts: settings.AllowedPorts,
		MaxPortsPerClient: settings.MaxPortsPerClient, MaxPoolCount: settings.MaxPoolCount,
		TLSEnforced: settings.TLSEnforced, DetailedClientErrors: settings.DetailedClientErrors,
	}
}

func (s *Server) getConfig(w http.ResponseWriter, _ *http.Request) {
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, editable(settings))
}

func occupiedWithoutCurrent(settings frp.Settings, managerPort int) []int {
	ports, _ := ListeningPorts()
	current := map[int]bool{settings.BindPort: true, settings.KCPBindPort: true, settings.QUICBindPort: true, settings.VhostHTTPPort: true, settings.VhostHTTPSPort: true, settings.TCPMuxHTTPPort: true, settings.DashboardPort: true}
	for _, port := range settings.ExpandedControlPorts() {
		current[port] = true
	}
	result := []int{managerPort}
	seen := map[int]bool{managerPort: true}
	for _, port := range ports {
		if !current[port.Port] && !seen[port.Port] {
			result = append(result, port.Port)
			seen[port.Port] = true
		}
	}
	return result
}

func mergeEditable(current frp.Settings, input EditableConfig) frp.Settings {
	current.BindPort = input.BindPort
	current.ControlPorts = input.ControlPorts
	current.KCPBindPort = input.KCPBindPort
	current.QUICBindPort = input.QUICBindPort
	current.VhostHTTPPort = input.VhostHTTPPort
	current.VhostHTTPSPort = input.VhostHTTPSPort
	current.TCPMuxHTTPPort = input.TCPMuxHTTPPort
	current.AllowedPorts = input.AllowedPorts
	current.MaxPortsPerClient = input.MaxPortsPerClient
	current.MaxPoolCount = input.MaxPoolCount
	current.TLSEnforced = input.TLSEnforced
	current.DetailedClientErrors = input.DetailedClientErrors
	return current
}

func (s *Server) putConfig(w http.ResponseWriter, r *http.Request) {
	var input EditableConfig
	if !decodeJSON(w, r, &input) {
		return
	}
	current, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	next := mergeEditable(current, input)
	if err := s.options.Store.Apply(next, occupiedWithoutCurrent(current, s.options.ManagerPort)); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": editable(next)})
}

func clientConfig(settings frp.Settings, publicIP, protocol, deviceID string, serverPort int) string {
	if protocol == "" {
		protocol = "tcp"
	}
	return fmt.Sprintf("clientID = %s\nuser = %s\nserverAddr = %s\nserverPort = %d\nloginFailExit = false\n\nauth.method = \"token\"\nauth.token = %s\nauth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]\n\ntransport.protocol = %s\ntransport.tls.enable = true\n", strconv.Quote(deviceID), strconv.Quote(deviceID), strconv.Quote(publicIP), serverPort, strconv.Quote(settings.Token), strconv.Quote(protocol))
}

func validDeviceID(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}

func (s *Server) credentials(w http.ResponseWriter, r *http.Request) {
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	deviceID := strings.TrimSpace(r.URL.Query().Get("device"))
	if deviceID == "" {
		deviceID = "device-01"
	}
	if !validDeviceID(deviceID) {
		writeError(w, http.StatusBadRequest, errors.New("设备标识只能包含字母、数字、短横线和下划线，长度 1-32"))
		return
	}
	serverPort := settings.BindPort
	if value := r.URL.Query().Get("port"); value != "" {
		serverPort, err = strconv.Atoi(value)
		if err != nil {
			writeError(w, http.StatusBadRequest, errors.New("接入端口无效"))
			return
		}
	}
	controlPorts := settings.ExpandedControlPorts()
	allowedPort := false
	for _, port := range controlPorts {
		if port == serverPort {
			allowedPort = true
			break
		}
	}
	if !allowedPort {
		writeError(w, http.StatusBadRequest, errors.New("该端口不在客户端接入端口段内"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"serverAddr": s.publicIP(), "serverPort": serverPort, "controlPorts": controlPorts,
		"deviceID": deviceID, "token": settings.Token,
		"tcpConfig":  clientConfig(settings, s.publicIP(), "tcp", deviceID, serverPort),
		"kcpConfig":  clientConfig(settings, s.publicIP(), "kcp", deviceID, serverPort),
		"quicConfig": clientConfig(settings, s.publicIP(), "quic", deviceID, serverPort),
	})
}

func (s *Server) rotateToken(w http.ResponseWriter, _ *http.Request) {
	current, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	token, err := randomToken(32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	current.Token = token
	if err := s.options.Store.Apply(current, occupiedWithoutCurrent(current, s.options.ManagerPort)); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "token": token})
}

func (s *Server) serviceAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string `json:"action"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := s.options.System.ServiceAction(body.Action); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": s.options.System.ServiceState()})
}

func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	logs, err := s.options.System.Logs(lines)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"logs": logs})
}

func (s *Server) ports(w http.ResponseWriter, _ *http.Request) {
	ports, err := ListeningPorts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ports": ports})
}

var allowedFRPResources = map[string]bool{
	"serverinfo": true, "clients": true, "proxy/tcp": true, "proxy/udp": true,
	"proxy/http": true, "proxy/https": true, "proxy/stcp": true, "proxy/sudp": true,
	"proxy/xtcp": true, "proxy/tcpmux": true,
}

type frpClientInfo struct {
	Key      string `json:"key"`
	User     string `json:"user"`
	ClientID string `json:"clientID"`
	Hostname string `json:"hostname"`
	Online   bool   `json:"online"`
}

type frpTCPProxyInfo struct {
	Name     string `json:"name"`
	User     string `json:"user"`
	ClientID string `json:"clientID"`
	Status   string `json:"status"`
	Conf     struct {
		RemotePort int               `json:"remotePort"`
		Metadatas  map[string]string `json:"metadatas"`
	} `json:"conf"`
}

type frpTCPProxyList struct {
	Proxies []frpTCPProxyInfo `json:"proxies"`
}

type onlineSSHDevice struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ClientID   string `json:"clientID"`
	Hostname   string `json:"hostname"`
	ProxyName  string `json:"proxyName"`
	RemotePort int    `json:"remotePort"`
	Platform   string `json:"platform"`
	SSHUser    string `json:"sshUser"`
}

func clientKey(user, clientID string) string {
	return user + "\x00" + clientID
}

func clientDeviceSignature(token string, timestamp int64) string {
	payload := fmt.Sprintf("GET\n/api/client/devices\n%d", timestamp)
	mac := hmac.New(sha256.New, []byte(token))
	_, _ = mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) fetchFRPJSON(ctx context.Context, settings frp.Settings, resource string, value any) error {
	target := fmt.Sprintf("http://127.0.0.1:%d/api/%s", settings.DashboardPort, resource)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	request.SetBasicAuth(settings.DashboardUser, settings.DashboardPassword)
	response, err := s.client.Do(request)
	if err != nil {
		return fmt.Errorf("原生监控暂不可用: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("原生监控返回 HTTP %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(value); err != nil {
		return fmt.Errorf("解析原生监控数据失败: %w", err)
	}
	return nil
}

func (s *Server) onlineSSHDevices(w http.ResponseWriter, r *http.Request) {
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	timestamp, timestampErr := strconv.ParseInt(r.Header.Get("X-MapLink-Timestamp"), 10, 64)
	provided, signatureErr := hex.DecodeString(r.Header.Get("X-MapLink-Signature"))
	expected, _ := hex.DecodeString(clientDeviceSignature(settings.Token, timestamp))
	age := time.Now().Unix() - timestamp
	if age < 0 {
		age = -age
	}
	if timestampErr != nil || signatureErr != nil || age > 120 || len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 {
		writeError(w, http.StatusUnauthorized, errors.New("Token 无效"))
		return
	}

	var clients []frpClientInfo
	var proxies frpTCPProxyList
	if err := s.fetchFRPJSON(r.Context(), settings, "clients", &clients); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	if err := s.fetchFRPJSON(r.Context(), settings, "proxy/tcp", &proxies); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}

	online := make(map[string]frpClientInfo)
	for _, client := range clients {
		if client.Online {
			online[clientKey(client.User, client.ClientID)] = client
		}
	}
	byClient := make(map[string]onlineSSHDevice)
	for _, proxy := range proxies.Proxies {
		platform := strings.ToLower(strings.TrimSpace(proxy.Conf.Metadatas["maplinkPlatform"]))
		if !strings.EqualFold(proxy.Status, "online") || (platform != "windows" && platform != "macos") || proxy.Conf.RemotePort < 1 || proxy.Conf.RemotePort > 65535 {
			continue
		}
		key := clientKey(proxy.User, proxy.ClientID)
		client, ok := online[key]
		if !ok {
			continue
		}
		name := client.Hostname
		if name == "" {
			name = client.ClientID
		}
		if name == "" {
			name = client.User
		}
		id := client.Key
		if id == "" {
			id = proxy.User + "." + proxy.ClientID
		}
		device := onlineSSHDevice{
			ID: id, Name: name, ClientID: client.ClientID, Hostname: client.Hostname,
			ProxyName: proxy.Name, RemotePort: proxy.Conf.RemotePort,
			Platform: platform, SSHUser: strings.TrimSpace(proxy.Conf.Metadatas["maplinkSSHUser"]),
		}
		if existing, exists := byClient[key]; !exists || device.RemotePort < existing.RemotePort {
			byClient[key] = device
		}
	}
	devices := make([]onlineSSHDevice, 0, len(byClient))
	for _, device := range byClient {
		devices = append(devices, device)
	}
	sort.Slice(devices, func(i, j int) bool {
		if devices[i].Name == devices[j].Name {
			return devices[i].RemotePort < devices[j].RemotePort
		}
		return devices[i].Name < devices[j].Name
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) frpAPI(w http.ResponseWriter, r *http.Request) {
	resource, err := url.PathUnescape(r.PathValue("resource"))
	if err != nil || !allowedFRPResources[resource] {
		writeError(w, http.StatusNotFound, errors.New("不支持的 FRP 监控资源"))
		return
	}
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	target := fmt.Sprintf("http://127.0.0.1:%d/api/%s", settings.DashboardPort, resource)
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	request.SetBasicAuth(settings.DashboardUser, settings.DashboardPassword)
	response, err := s.client.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Errorf("原生监控暂不可用: %w", err))
		return
	}
	defer response.Body.Close()
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 4<<20))
}
