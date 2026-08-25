package manager

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"frp-manager/internal/auth"
	"frp-manager/internal/frp"
)

func integrationServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	runner := &fakeRunner{}
	store := &Store{StatePath: filepath.Join(dir, "state.json"), ConfigPath: filepath.Join(dir, "frps.toml"), Runner: runner}
	settings := frp.Settings{
		BindPort: 7000, ControlPorts: []frp.PortRange{{Start: 7000, End: 7010}}, KCPBindPort: 7000, QUICBindPort: 7002,
		VhostHTTPPort: 8080, VhostHTTPSPort: 8443, TCPMuxHTTPPort: 7100,
		DashboardPort: 7500, Token: "0123456789abcdef",
		DashboardUser: "internal-user", DashboardPassword: "0123456789abcdef",
		AllowedPorts:      []frp.PortRange{{Start: 30000, End: 50000}},
		MaxPortsPerClient: 50, MaxPoolCount: 20, TLSEnforced: true,
	}
	if err := store.Apply(settings, nil); err != nil {
		t.Fatal(err)
	}
	hash, err := auth.HashPassword("a-strong-admin-password")
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(ServerOptions{Store: store, AdminUser: "admin", AdminHash: hash, AdminHashPath: filepath.Join(dir, "admin-password.hash"), PublicIP: "203.0.113.10", ManagerPort: 7400})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestClientDeviceDiscoveryRequiresTokenAndReturnsOnlineSSHEndpoints(t *testing.T) {
	if signature := clientDeviceSignature("0123456789abcdef", 1700000000); signature != "f2b1286b57ce28ed4e1a9cca5d12a1bebb6cf22d876d3a0cb92bf6abe9487d0a" {
		t.Fatalf("unexpected HMAC signature: %s", signature)
	}
	server := integrationServer(t)
	dashboard := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "internal-user" || password != "0123456789abcdef" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/clients":
			_, _ = w.Write([]byte(`[
				{"key":"alpha.alpha","user":"alpha","clientID":"alpha","hostname":"Office Mac","online":true},
				{"key":"beta.beta","user":"beta","clientID":"beta","hostname":"Windows PC","online":true},
				{"key":"offline.offline","user":"offline","clientID":"offline","hostname":"Offline PC","online":false}
			]`))
		case "/api/proxy/tcp":
			_, _ = w.Write([]byte(`{"proxies":[
				{"name":"alpha.remote-shell","user":"alpha","clientID":"alpha","status":"online","conf":{"localPort":22,"remotePort":30022,"metadatas":{"maplinkPlatform":"macos","maplinkSSHUser":"alice"}}},
				{"name":"beta.web","user":"beta","clientID":"beta","status":"online","conf":{"localPort":8080,"remotePort":38080}},
				{"name":"offline.remote-shell","user":"offline","clientID":"offline","status":"online","conf":{"localPort":22,"remotePort":30024}}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer dashboard.Close()
	parsed, err := url.Parse(dashboard.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, found := strings.Cut(parsed.Host, ":")
	if !found {
		t.Fatalf("dashboard URL has no port: %s", dashboard.URL)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := server.options.Store.Load()
	if err != nil {
		t.Fatal(err)
	}
	settings.DashboardPort = port
	if err := server.options.Store.Apply(settings, nil); err != nil {
		t.Fatal(err)
	}

	for name, token := range map[string]string{"missing": "", "wrong": "wrong-token-value"} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/client/devices", nil)
			if token != "" {
				timestamp := time.Now().Unix()
				request.Header.Set("X-MapLink-Timestamp", strconv.FormatInt(timestamp, 10))
				request.Header.Set("X-MapLink-Signature", clientDeviceSignature(token, timestamp))
			}
			server.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d: %s", response.Code, response.Body.String())
			}
		})
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/client/devices", nil)
	timestamp := time.Now().Unix()
	request.Header.Set("X-MapLink-Timestamp", strconv.FormatInt(timestamp, 10))
	request.Header.Set("X-MapLink-Signature", clientDeviceSignature("0123456789abcdef", timestamp))
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, expected := range []string{"Office Mac", `"remotePort":30022`, `"platform":"macos"`, `"sshUser":"alice"`} {
		if !strings.Contains(body, expected) {
			t.Errorf("missing %q in %s", expected, body)
		}
	}
	for _, forbidden := range []string{"0123456789abcdef", "Windows PC", "Offline PC", "38080", "30024"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("unexpected %q in %s", forbidden, body)
		}
	}
}

func TestCredentialsGenerateDistinctDeviceConfigOnSelectedControlPort(t *testing.T) {
	server := integrationServer(t)
	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`))
	server.Handler().ServeHTTP(login, loginRequest)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/credentials?device=office-pc&port=7005", nil)
	request.AddCookie(login.Result().Cookies()[0])
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	for _, expected := range []string{`"deviceID":"office-pc"`, `clientID = \"office-pc\"`, `user = \"office-pc\"`, `serverPort = 7005`, `auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]`} {
		if !bytes.Contains(response.Body.Bytes(), []byte(expected)) {
			t.Errorf("missing %q in %s", expected, response.Body.String())
		}
	}
}

func TestAPIRequiresLoginAndReturnsSessionWithCSRF(t *testing.T) {
	server := integrationServer(t)
	unauthorized := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorized.Code)
	}

	login := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`))
	request.Header.Set("Content-Type", "application/json")
	server.Handler().ServeHTTP(login, request)
	if login.Code != http.StatusOK {
		t.Fatalf("expected login 200, got %d: %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("expected hardened session cookie, got %#v", cookies)
	}

	session := httptest.NewRecorder()
	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	sessionRequest.AddCookie(cookies[0])
	server.Handler().ServeHTTP(session, sessionRequest)
	if session.Code != http.StatusOK || !bytes.Contains(session.Body.Bytes(), []byte("csrfToken")) {
		t.Fatalf("expected authenticated session response, got %d: %s", session.Code, session.Body.String())
	}
}

func TestMutatingAPIRejectsMissingCSRF(t *testing.T) {
	server := integrationServer(t)
	login := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`))
	server.Handler().ServeHTTP(login, request)

	mutation := httptest.NewRecorder()
	mutationRequest := httptest.NewRequest(http.MethodPost, "/api/service", bytes.NewBufferString(`{"action":"restart"}`))
	mutationRequest.AddCookie(login.Result().Cookies()[0])
	server.Handler().ServeHTTP(mutation, mutationRequest)
	if mutation.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", mutation.Code)
	}
}

func TestSecurityPolicyAllowsNextBootstrapButBlocksInlineEventHandlers(t *testing.T) {
	server := integrationServer(t)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := response.Header().Get("Content-Security-Policy")
	for _, expected := range []string{
		"script-src 'self' 'unsafe-inline'",
		"script-src-attr 'none'",
		"object-src 'none'",
	} {
		if !strings.Contains(csp, expected) {
			t.Errorf("CSP missing %q: %s", expected, csp)
		}
	}
}

func TestAdminCanChangePasswordAndNewHashSurvivesRestart(t *testing.T) {
	server := integrationServer(t)
	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`))
	server.Handler().ServeHTTP(login, loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", login.Code, login.Body.String())
	}
	var session struct {
		CSRF string `json:"csrfToken"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}

	change := httptest.NewRecorder()
	changeRequest := httptest.NewRequest(http.MethodPost, "/api/auth/password", bytes.NewBufferString(`{"currentPassword":"a-strong-admin-password","newPassword":"a-new-strong-admin-password","confirmPassword":"a-new-strong-admin-password"}`))
	changeRequest.AddCookie(login.Result().Cookies()[0])
	changeRequest.Header.Set("X-CSRF-Token", session.CSRF)
	server.Handler().ServeHTTP(change, changeRequest)
	if change.Code != http.StatusOK {
		t.Fatalf("password change failed: %d %s", change.Code, change.Body.String())
	}

	oldLogin := httptest.NewRecorder()
	server.Handler().ServeHTTP(oldLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`)))
	if oldLogin.Code != http.StatusUnauthorized {
		t.Fatalf("old password should fail, got %d", oldLogin.Code)
	}
	newLogin := httptest.NewRecorder()
	server.Handler().ServeHTTP(newLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-new-strong-admin-password"}`)))
	if newLogin.Code != http.StatusOK {
		t.Fatalf("new password should work, got %d: %s", newLogin.Code, newLogin.Body.String())
	}

	restarted, err := NewServer(server.options)
	if err != nil {
		t.Fatal(err)
	}
	restartedLogin := httptest.NewRecorder()
	restarted.Handler().ServeHTTP(restartedLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-new-strong-admin-password"}`)))
	if restartedLogin.Code != http.StatusOK {
		t.Fatalf("persisted password should work after restart, got %d: %s", restartedLogin.Code, restartedLogin.Body.String())
	}
}

func TestPasswordChangeRejectsWrongCurrentPasswordAndMismatch(t *testing.T) {
	server := integrationServer(t)
	login := httptest.NewRecorder()
	server.Handler().ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"a-strong-admin-password"}`)))
	var session struct {
		CSRF string `json:"csrfToken"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"wrong current": `{"currentPassword":"wrong-current-password","newPassword":"a-new-strong-admin-password","confirmPassword":"a-new-strong-admin-password"}`,
		"mismatch":      `{"currentPassword":"a-strong-admin-password","newPassword":"a-new-strong-admin-password","confirmPassword":"a-different-admin-password"}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/auth/password", bytes.NewBufferString(body))
			request.AddCookie(login.Result().Cookies()[0])
			request.Header.Set("X-CSRF-Token", session.CSRF)
			server.Handler().ServeHTTP(response, request)
			if response.Code < 400 {
				t.Fatalf("expected rejection, got %d: %s", response.Code, response.Body.String())
			}
		})
	}
}
