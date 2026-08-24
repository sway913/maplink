package manager

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

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
