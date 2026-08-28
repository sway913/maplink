package manager

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	remoteHostTTL       = 30 * time.Second
	remoteSessionTTL    = 90 * time.Second
	remoteFrameLimit    = 3 << 20
	remoteJSONLimit     = 128 << 10
	remoteLongPoll      = 18 * time.Second
	remoteInputQueueCap = 256
)

type remoteHub struct {
	mu       sync.Mutex
	hosts    map[string]remoteHost
	sessions map[string]*remoteSession
	nonces   map[string]time.Time
}

type remoteHost struct {
	DeviceID   string    `json:"deviceID"`
	Name       string    `json:"name"`
	Platform   string    `json:"platform"`
	Permission string    `json:"permission"`
	LastSeen   time.Time `json:"-"`
}

type remoteSession struct {
	ID                 string
	TargetDeviceID     string
	ControllerDeviceID string
	State              string
	Error              string
	ScreenX            int
	ScreenY            int
	ScreenWidth        int
	ScreenHeight       int
	CreatedAt          time.Time
	UpdatedAt          time.Time
	FrameSequence      uint64
	Frame              []byte
	InputSequence      uint64
	Inputs             []sequencedRemoteInput
}

type remoteSessionView struct {
	ID                 string `json:"id"`
	TargetDeviceID     string `json:"targetDeviceID"`
	ControllerDeviceID string `json:"controllerDeviceID"`
	State              string `json:"state"`
	Error              string `json:"error,omitempty"`
	ScreenX            int    `json:"screenX"`
	ScreenY            int    `json:"screenY"`
	ScreenWidth        int    `json:"screenWidth"`
	ScreenHeight       int    `json:"screenHeight"`
	FrameSequence      uint64 `json:"frameSequence"`
}

type remoteInput struct {
	Type   string  `json:"type"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button int     `json:"button,omitempty"`
	DeltaX int     `json:"deltaX,omitempty"`
	DeltaY int     `json:"deltaY,omitempty"`
	Key    string  `json:"key,omitempty"`
	Code   string  `json:"code,omitempty"`
	Down   bool    `json:"down,omitempty"`
}

type sequencedRemoteInput struct {
	Sequence uint64      `json:"sequence"`
	Event    remoteInput `json:"event"`
}

func newRemoteHub() *remoteHub {
	return &remoteHub{
		hosts:    make(map[string]remoteHost),
		sessions: make(map[string]*remoteSession),
		nonces:   make(map[string]time.Time),
	}
}

func validRemoteDeviceID(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func remoteSignature(token, method, requestURI, timestamp, nonce string, body []byte) string {
	bodyHash := sha256.Sum256(body)
	payload := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, requestURI, timestamp, nonce, hex.EncodeToString(bodyHash[:]))
	mac := hmac.New(sha256.New, []byte(token))
	_, _ = mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) authenticateRemoteRequest(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	settings, err := s.options.Store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("远程控制请求过大"))
		return nil, false
	}
	timestampText := r.Header.Get("X-MapLink-Timestamp")
	nonce := r.Header.Get("X-MapLink-Nonce")
	timestamp, timestampErr := strconv.ParseInt(timestampText, 10, 64)
	provided, signatureErr := hex.DecodeString(r.Header.Get("X-MapLink-Signature"))
	expected, _ := hex.DecodeString(remoteSignature(settings.Token, r.Method, r.URL.RequestURI(), timestampText, nonce, body))
	age := time.Now().Unix() - timestamp
	if age < 0 {
		age = -age
	}
	if timestampErr != nil || signatureErr != nil || age > 120 || len(nonce) < 16 || len(nonce) > 96 ||
		len(provided) != len(expected) || subtle.ConstantTimeCompare(provided, expected) != 1 {
		writeError(w, http.StatusUnauthorized, errors.New("Token 无效"))
		return nil, false
	}

	now := time.Now()
	s.remote.mu.Lock()
	for value, expiresAt := range s.remote.nonces {
		if now.After(expiresAt) {
			delete(s.remote.nonces, value)
		}
	}
	if _, replayed := s.remote.nonces[nonce]; replayed {
		s.remote.mu.Unlock()
		writeError(w, http.StatusUnauthorized, errors.New("请求已使用"))
		return nil, false
	}
	s.remote.nonces[nonce] = now.Add(3 * time.Minute)
	s.remote.mu.Unlock()
	return body, true
}

func decodeRemoteJSON(w http.ResponseWriter, body []byte, value any) bool {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
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

func (h *remoteHub) cleanupLocked(now time.Time) {
	for id, host := range h.hosts {
		if now.Sub(host.LastSeen) > remoteHostTTL {
			delete(h.hosts, id)
		}
	}
	for id, session := range h.sessions {
		if now.Sub(session.UpdatedAt) > remoteSessionTTL {
			delete(h.sessions, id)
		}
	}
}

func viewRemoteSession(session *remoteSession) remoteSessionView {
	return remoteSessionView{
		ID: session.ID, TargetDeviceID: session.TargetDeviceID, ControllerDeviceID: session.ControllerDeviceID,
		State: session.State, Error: session.Error, ScreenX: session.ScreenX, ScreenY: session.ScreenY,
		ScreenWidth: session.ScreenWidth, ScreenHeight: session.ScreenHeight, FrameSequence: session.FrameSequence,
	}
}

func (s *Server) remoteHostHeartbeat(w http.ResponseWriter, r *http.Request) {
	body, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit)
	if !ok {
		return
	}
	var request struct {
		DeviceID   string `json:"deviceID"`
		Name       string `json:"name"`
		Platform   string `json:"platform"`
		Permission string `json:"permission"`
	}
	if !decodeRemoteJSON(w, body, &request) {
		return
	}
	request.DeviceID = strings.TrimSpace(request.DeviceID)
	request.Name = strings.TrimSpace(request.Name)
	request.Platform = strings.ToLower(strings.TrimSpace(request.Platform))
	if !validRemoteDeviceID(request.DeviceID) || len(request.Name) > 128 ||
		(request.Platform != "windows" && request.Platform != "macos") ||
		(request.Permission != "ready" && request.Permission != "permission-required" && request.Permission != "unavailable") {
		writeError(w, http.StatusBadRequest, errors.New("远程主机信息无效"))
		return
	}
	if request.Name == "" {
		request.Name = request.DeviceID
	}
	now := time.Now()
	s.remote.mu.Lock()
	s.remote.cleanupLocked(now)
	s.remote.hosts[request.DeviceID] = remoteHost{
		DeviceID: request.DeviceID, Name: request.Name, Platform: request.Platform,
		Permission: request.Permission, LastSeen: now,
	}
	s.remote.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"registered": true})
}

func (s *Server) remoteDevices(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	now := time.Now()
	s.remote.mu.Lock()
	s.remote.cleanupLocked(now)
	devices := make([]remoteHost, 0, len(s.remote.hosts))
	for _, host := range s.remote.hosts {
		devices = append(devices, host)
	}
	s.remote.mu.Unlock()
	sort.Slice(devices, func(i, j int) bool { return devices[i].Name < devices[j].Name })
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) remoteHostSessions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	deviceID := r.PathValue("deviceID")
	if !validRemoteDeviceID(deviceID) {
		writeError(w, http.StatusBadRequest, errors.New("设备 ID 无效"))
		return
	}
	now := time.Now()
	s.remote.mu.Lock()
	s.remote.cleanupLocked(now)
	sessions := make([]remoteSessionView, 0, 1)
	for _, session := range s.remote.sessions {
		if session.TargetDeviceID == deviceID && (session.State == "pending" || session.State == "active") {
			sessions = append(sessions, viewRemoteSession(session))
		}
	}
	s.remote.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *Server) remoteCreateSession(w http.ResponseWriter, r *http.Request) {
	body, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit)
	if !ok {
		return
	}
	var request struct {
		TargetDeviceID     string `json:"targetDeviceID"`
		ControllerDeviceID string `json:"controllerDeviceID"`
	}
	if !decodeRemoteJSON(w, body, &request) {
		return
	}
	if !validRemoteDeviceID(request.TargetDeviceID) || !validRemoteDeviceID(request.ControllerDeviceID) || request.TargetDeviceID == request.ControllerDeviceID {
		writeError(w, http.StatusBadRequest, errors.New("远程会话设备无效"))
		return
	}
	now := time.Now()
	s.remote.mu.Lock()
	s.remote.cleanupLocked(now)
	host, exists := s.remote.hosts[request.TargetDeviceID]
	if !exists || now.Sub(host.LastSeen) > remoteHostTTL {
		s.remote.mu.Unlock()
		writeError(w, http.StatusConflict, errors.New("目标设备已离线"))
		return
	}
	if host.Permission != "ready" {
		s.remote.mu.Unlock()
		writeError(w, http.StatusConflict, errors.New("目标设备尚未授予屏幕录制或辅助控制权限"))
		return
	}
	for _, session := range s.remote.sessions {
		if session.TargetDeviceID == request.TargetDeviceID && (session.State == "pending" || session.State == "active") {
			s.remote.mu.Unlock()
			writeError(w, http.StatusConflict, errors.New("目标设备正在被远程控制"))
			return
		}
	}
	id, err := randomToken(18)
	if err != nil {
		s.remote.mu.Unlock()
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	session := &remoteSession{
		ID: id, TargetDeviceID: request.TargetDeviceID, ControllerDeviceID: request.ControllerDeviceID,
		State: "pending", CreatedAt: now, UpdatedAt: now,
	}
	s.remote.sessions[id] = session
	view := viewRemoteSession(session)
	s.remote.mu.Unlock()
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) withRemoteSession(w http.ResponseWriter, r *http.Request) (*remoteSession, bool) {
	session := s.remote.sessions[r.PathValue("sessionID")]
	if session == nil {
		writeError(w, http.StatusNotFound, errors.New("远程会话不存在或已过期"))
		return nil, false
	}
	return session, true
}

func (s *Server) remoteSessionStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	s.remote.mu.Lock()
	s.remote.cleanupLocked(time.Now())
	session, ok := s.withRemoteSession(w, r)
	if !ok {
		s.remote.mu.Unlock()
		return
	}
	view := viewRemoteSession(session)
	s.remote.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) remoteAcceptSession(w http.ResponseWriter, r *http.Request) {
	body, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit)
	if !ok {
		return
	}
	var request struct {
		ScreenX      int    `json:"screenX"`
		ScreenY      int    `json:"screenY"`
		ScreenWidth  int    `json:"screenWidth"`
		ScreenHeight int    `json:"screenHeight"`
		Error        string `json:"error"`
	}
	if !decodeRemoteJSON(w, body, &request) {
		return
	}
	s.remote.mu.Lock()
	session, found := s.withRemoteSession(w, r)
	if !found {
		s.remote.mu.Unlock()
		return
	}
	if len(request.Error) > 300 {
		s.remote.mu.Unlock()
		writeError(w, http.StatusBadRequest, errors.New("错误信息过长"))
		return
	}
	if request.Error != "" {
		session.State, session.Error = "failed", request.Error
	} else if request.ScreenWidth < 1 || request.ScreenHeight < 1 || request.ScreenWidth > 32768 || request.ScreenHeight > 32768 {
		s.remote.mu.Unlock()
		writeError(w, http.StatusBadRequest, errors.New("屏幕尺寸无效"))
		return
	} else {
		session.State = "active"
		session.ScreenX, session.ScreenY = request.ScreenX, request.ScreenY
		session.ScreenWidth, session.ScreenHeight = request.ScreenWidth, request.ScreenHeight
	}
	session.UpdatedAt = time.Now()
	view := viewRemoteSession(session)
	s.remote.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) remoteCloseSession(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	s.remote.mu.Lock()
	if session := s.remote.sessions[r.PathValue("sessionID")]; session != nil {
		session.State = "closed"
		session.Frame = nil
		session.Inputs = nil
		session.UpdatedAt = time.Now()
	}
	s.remote.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) remoteUploadFrame(w http.ResponseWriter, r *http.Request) {
	body, ok := s.authenticateRemoteRequest(w, r, remoteFrameLimit)
	if !ok {
		return
	}
	sequence, sequenceErr := strconv.ParseUint(r.Header.Get("X-MapLink-Sequence"), 10, 64)
	width, widthErr := strconv.Atoi(r.Header.Get("X-MapLink-Width"))
	height, heightErr := strconv.Atoi(r.Header.Get("X-MapLink-Height"))
	if sequenceErr != nil || widthErr != nil || heightErr != nil || sequence == 0 || width < 1 || height < 1 || len(body) < 4 {
		writeError(w, http.StatusBadRequest, errors.New("远程画面参数无效"))
		return
	}
	s.remote.mu.Lock()
	session, found := s.withRemoteSession(w, r)
	if !found {
		s.remote.mu.Unlock()
		return
	}
	if session.State != "active" {
		s.remote.mu.Unlock()
		writeError(w, http.StatusConflict, errors.New("远程会话未激活"))
		return
	}
	if sequence > session.FrameSequence {
		session.FrameSequence = sequence
		session.Frame = append(session.Frame[:0], body...)
		session.ScreenWidth, session.ScreenHeight = width, height
		session.UpdatedAt = time.Now()
	}
	s.remote.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) remoteDownloadFrame(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	deadline := time.Now().Add(remoteLongPoll)
	for {
		s.remote.mu.Lock()
		session, found := s.withRemoteSession(w, r)
		if !found {
			s.remote.mu.Unlock()
			return
		}
		if session.FrameSequence > after && len(session.Frame) > 0 {
			frame := append([]byte(nil), session.Frame...)
			sequence, width, height := session.FrameSequence, session.ScreenWidth, session.ScreenHeight
			session.UpdatedAt = time.Now()
			s.remote.mu.Unlock()
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-MapLink-Sequence", strconv.FormatUint(sequence, 10))
			w.Header().Set("X-MapLink-Width", strconv.Itoa(width))
			w.Header().Set("X-MapLink-Height", strconv.Itoa(height))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(frame)
			return
		}
		state := session.State
		s.remote.mu.Unlock()
		if state == "closed" || state == "failed" || time.Now().After(deadline) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func validRemoteInput(event remoteInput) bool {
	switch event.Type {
	case "move", "button":
		return event.X >= 0 && event.X <= 1 && event.Y >= 0 && event.Y <= 1 && event.Button >= 0 && event.Button <= 4
	case "wheel":
		return event.DeltaX >= -4000 && event.DeltaX <= 4000 && event.DeltaY >= -4000 && event.DeltaY <= 4000
	case "key":
		return len(event.Key) <= 32 && len(event.Code) <= 32
	default:
		return false
	}
}

func (s *Server) remotePostInputs(w http.ResponseWriter, r *http.Request) {
	body, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit)
	if !ok {
		return
	}
	var request struct {
		Events []remoteInput `json:"events"`
	}
	if !decodeRemoteJSON(w, body, &request) {
		return
	}
	if len(request.Events) < 1 || len(request.Events) > 64 {
		writeError(w, http.StatusBadRequest, errors.New("远程输入批次数量无效"))
		return
	}
	for _, event := range request.Events {
		if !validRemoteInput(event) {
			writeError(w, http.StatusBadRequest, errors.New("远程输入事件无效"))
			return
		}
	}
	s.remote.mu.Lock()
	session, found := s.withRemoteSession(w, r)
	if !found {
		s.remote.mu.Unlock()
		return
	}
	if session.State != "active" {
		s.remote.mu.Unlock()
		writeError(w, http.StatusConflict, errors.New("远程会话未激活"))
		return
	}
	for _, event := range request.Events {
		session.InputSequence++
		session.Inputs = append(session.Inputs, sequencedRemoteInput{Sequence: session.InputSequence, Event: event})
	}
	if len(session.Inputs) > remoteInputQueueCap {
		session.Inputs = session.Inputs[len(session.Inputs)-remoteInputQueueCap:]
	}
	session.UpdatedAt = time.Now()
	sequence := session.InputSequence
	s.remote.mu.Unlock()
	writeJSON(w, http.StatusAccepted, map[string]uint64{"sequence": sequence})
}

func (s *Server) remotePollInputs(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authenticateRemoteRequest(w, r, remoteJSONLimit); !ok {
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	deadline := time.Now().Add(5 * time.Second)
	if r.URL.Query().Get("wait") == "0" {
		deadline = time.Now()
	}
	for {
		s.remote.mu.Lock()
		session, found := s.withRemoteSession(w, r)
		if !found {
			s.remote.mu.Unlock()
			return
		}
		events := make([]sequencedRemoteInput, 0)
		for _, event := range session.Inputs {
			if event.Sequence > after {
				events = append(events, event)
			}
		}
		state, sequence := session.State, session.InputSequence
		if len(events) > 0 {
			session.UpdatedAt = time.Now()
		}
		s.remote.mu.Unlock()
		if len(events) > 0 || state != "active" || time.Now().After(deadline) {
			writeJSON(w, http.StatusOK, map[string]any{"sequence": sequence, "state": state, "events": events})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}
