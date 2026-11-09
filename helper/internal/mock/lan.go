package mock

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// The fake web API printers for --mock: a PrusaLink (digest login, user maker), a Moonraker (no login, like a trusted client,
// with CORS for local pages) and an OctoPrint (API key). Each runs a print as a simulation when a file arrives with the print flag.

// PrusaPassword is the password of the fake PrusaLink, and OctoKey the API key of the fake OctoPrint.
const (
	PrusaPassword = "mockpass"
	OctoKey       = "mockoctokey"
)

// Web is the set of fake web API printers.
type Web struct {
	Prusa, Moonraker, Octo *sim
	servers                []*http.Server
	// Files lists what each printer received: kind to file names, for tests
	mu    sync.Mutex
	files map[string][]string
}

// sim is one simulated print: a progress that runs from 0 to 1 over a minute divided by the speed.
type sim struct {
	kind     string
	port     int
	speed    float64
	mu       sync.Mutex
	state    string // idle, printing, paused, done, stopped
	file     string
	progress float64
	last     time.Time
	jobID    int
}

func newSim(kind string, speed float64) *sim {
	if speed <= 0 {
		speed = 1
	}
	return &sim{kind: kind, speed: speed, state: "idle", last: time.Now()}
}

func (s *sim) tick() {
	now := time.Now()
	if s.state == "printing" {
		s.progress += now.Sub(s.last).Seconds() * s.speed / 60
		if s.progress >= 1 {
			s.progress, s.state = 1, "done"
		}
	}
	s.last = now
}

func (s *sim) start(file string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick()
	if s.state == "printing" || s.state == "paused" {
		return false
	}
	s.file, s.progress, s.state = file, 0, "printing"
	s.jobID++
	return true
}

func (s *sim) set(state string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick()
	switch {
	case state == "paused" && s.state == "printing", state == "printing" && s.state == "paused", state == "stopped" && (s.state == "printing" || s.state == "paused"):
		s.state = state
		return true
	}
	return false
}

// view is a consistent copy of the numbers.
func (s *sim) view() (state string, progress float64, file string, id int, nozzle, bed float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick()
	hot := s.state == "printing" || s.state == "paused"
	nozzle, bed = 24, 23
	if hot {
		ramp := 0.3 + s.progress*8
		if ramp > 1 {
			ramp = 1
		}
		nozzle, bed = 24+(215-24)*ramp, 23+(60-23)*ramp
	}
	return s.state, s.progress, s.file, s.jobID, nozzle, bed
}

// listen takes a port below the range the system hands out to outgoing connections, like the fake Bambu printer does.
func listen() (net.Listener, int, error) {
	for try := 0; try < 50; try++ {
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", freePort())); err == nil {
			return l, l.Addr().(*net.TCPAddr).Port, nil
		}
	}
	return nil, 0, fmt.Errorf("no free port for the fake printers")
}

// StartWeb starts the three fake printers; speed is as for the fake Bambu printer.
func StartWeb(speed float64) (*Web, error) {
	w := &Web{files: map[string][]string{}}
	w.Prusa, w.Moonraker, w.Octo = newSim("prusa", speed), newSim("klipper", speed), newSim("octoprint", speed)
	for _, x := range []struct {
		s *sim
		h http.Handler
	}{{w.Prusa, http.HandlerFunc(w.prusaHandler)}, {w.Moonraker, http.HandlerFunc(w.moonrakerHandler)}, {w.Octo, http.HandlerFunc(w.octoHandler)}} {
		l, port, err := listen()
		if err != nil {
			w.Close()
			return nil, err
		}
		x.s.port = port
		srv := &http.Server{Handler: x.h, ReadHeaderTimeout: 10 * time.Second}
		w.servers = append(w.servers, srv)
		go srv.Serve(l)
	}
	return w, nil
}

// Close stops the fake printers.
func (w *Web) Close() {
	for _, s := range w.servers {
		s.Close()
	}
}

// Found lists the fake printers as discovery would.
func (w *Web) Found() []bambu.Found {
	return []bambu.Found{
		{Kind: "prusa", Name: "Simulated Prusa MK4S", ModelNm: "PrusaLink", IP: "127.0.0.1", Port: w.Prusa.port, Mock: true, AccessCode: PrusaPassword},
		{Kind: "klipper", Name: "Simulated Klipper", ModelNm: "Klipper", IP: "127.0.0.1", Port: w.Moonraker.port, Mock: true},
		{Kind: "octoprint", Name: "Simulated OctoPrint", ModelNm: "OctoPrint", IP: "127.0.0.1", Port: w.Octo.port, Mock: true, AccessCode: OctoKey},
	}
}

// Files returns the names of the files a fake printer received ("prusa", "klipper" or "octoprint").
func (w *Web) Files(kind string) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.files[kind]...)
}

func (w *Web) got(kind, name string) {
	w.mu.Lock()
	w.files[kind] = append(w.files[kind], name)
	w.mu.Unlock()
}

func writeJSON(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	_ = json.NewEncoder(rw).Encode(v)
}

// ---- PrusaLink

var digestKV = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|([^\s,]*))`)

var prusaNonce = func() string { b := make([]byte, 12); rand.Read(b); return hex.EncodeToString(b) }()

// digestOK checks an Authorization header the way a server does (MD5, qop auth), against user maker.
func digestOK(r *http.Request, pass string) bool {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Digest ") {
		return false
	}
	f := map[string]string{}
	for _, m := range digestKV.FindAllStringSubmatch(h[7:], -1) {
		v := m[2]
		if v == "" {
			v = m[3]
		}
		f[strings.ToLower(m[1])] = v
	}
	md := func(s string) string { x := md5.Sum([]byte(s)); return hex.EncodeToString(x[:]) }
	if f["username"] != "maker" || f["nonce"] != prusaNonce || f["uri"] != r.URL.RequestURI() {
		return false
	}
	ha1 := md("maker:Printer API:" + pass)
	ha2 := md(r.Method + ":" + f["uri"])
	want := md(ha1 + ":" + f["nonce"] + ":" + f["nc"] + ":" + f["cnonce"] + ":" + f["qop"] + ":" + ha2)
	return f["response"] == want
}

func (w *Web) prusaHandler(rw http.ResponseWriter, r *http.Request) {
	if !digestOK(r, PrusaPassword) {
		rw.Header().Set("WWW-Authenticate", fmt.Sprintf(`Digest realm="Printer API", nonce=%q, qop="auth", opaque="x", algorithm=MD5`, prusaNonce))
		http.Error(rw, "unauthorized", http.StatusUnauthorized)
		return
	}
	s := w.Prusa
	state, progress, file, id, nozzle, bed := s.view()
	api := map[string]string{"idle": "IDLE", "printing": "PRINTING", "paused": "PAUSED", "done": "FINISHED", "stopped": "STOPPED"}[state]
	remaining := int((1 - progress) * 60 / s.speed)
	p := r.URL.Path
	switch {
	case p == "/api/version":
		writeJSON(rw, 200, obj{"api": "1.0.0", "version": "0.7.0", "printer": "1.3.1", "text": "PrusaLink 0.7.0", "firmware": "6.2.0", "capabilities": obj{"upload-by-put": true}})
	case p == "/api/v1/info":
		writeJSON(rw, 200, obj{"name": "Simulated Prusa MK4S", "serial": "CZPXMOCK0001", "nozzle_diameter": 0.4, "hostname": "mock-mk4s"})
	case p == "/api/v1/storage":
		writeJSON(rw, 200, obj{"storage_list": []obj{{"name": "USB", "type": "USB", "path": "/usb", "available": true, "read_only": false, "free_space": 1 << 30}}})
	case p == "/api/v1/status":
		out := obj{"printer": obj{"state": api, "temp_nozzle": nozzle, "target_nozzle": 215.0, "temp_bed": bed, "target_bed": 60.0, "axis_z": 0.2 + progress*20, "flow": 95, "speed": 100, "fan_hotend": 5200, "fan_print": 3100, "status_printer": obj{"ok": true, "message": "OK"}}}
		if state == "printing" || state == "paused" {
			out["job"] = obj{"id": id, "progress": progress * 100, "time_remaining": remaining, "time_printing": int(progress * 60 / s.speed)}
		}
		writeJSON(rw, 200, out)
	case p == "/api/v1/job":
		if state != "printing" && state != "paused" {
			rw.WriteHeader(204)
			return
		}
		writeJSON(rw, 200, obj{"id": id, "state": api, "progress": progress * 100, "time_remaining": remaining, "time_printing": 1, "file": obj{"name": file, "display_name": file, "path": "/usb"}})
	case strings.HasPrefix(p, "/api/v1/job/"):
		rest := strings.TrimPrefix(p, "/api/v1/job/")
		jid, action, _ := strings.Cut(rest, "/")
		if n, _ := strconv.Atoi(jid); n != id {
			http.Error(rw, "not found", 404)
			return
		}
		ok := false
		switch {
		case r.Method == "PUT" && action == "pause":
			ok = s.set("paused")
		case r.Method == "PUT" && action == "resume":
			ok = s.set("printing")
		case r.Method == "DELETE" && action == "":
			ok = s.set("stopped")
		}
		if !ok {
			http.Error(rw, "conflict", 409)
			return
		}
		rw.WriteHeader(204)
	case strings.HasPrefix(p, "/api/v1/files/") && r.Method == "PUT":
		name := strings.TrimPrefix(p, "/api/v1/files/usb/")
		if name == p {
			http.Error(rw, "storage not found", 404)
			return
		}
		n, _ := io.Copy(io.Discard, r.Body)
		if n == 0 {
			http.Error(rw, "empty", 400)
			return
		}
		if r.Header.Get("Print-After-Upload") == "?1" {
			if !s.start(name) {
				http.Error(rw, "printer busy", 409)
				return
			}
		}
		w.got("prusa", name)
		rw.WriteHeader(201)
	default:
		http.Error(rw, "not found", 404)
	}
}

type obj = map[string]any

// ---- Moonraker

var localOrigin = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

func (w *Web) klipperSnapshot() obj {
	state, progress, file, _, nozzle, bed := w.Moonraker.view()
	ks := map[string]string{"idle": "standby", "printing": "printing", "paused": "paused", "done": "complete", "stopped": "cancelled"}[state]
	dur := progress * 60 / w.Moonraker.speed
	return obj{
		"print_stats":    obj{"state": ks, "filename": file, "print_duration": dur, "message": "", "info": obj{"current_layer": int(progress * 20), "total_layer": 20}},
		"display_status": obj{"progress": progress},
		"virtual_sdcard": obj{"progress": progress},
		"extruder":       obj{"temperature": nozzle, "target": 215.0},
		"heater_bed":     obj{"temperature": bed, "target": 60.0},
		"fan":            obj{"speed": 0.5},
		"toolhead":       obj{"position": []float64{100, 100, 0.2 + progress*20, 0}},
	}
}

func (w *Web) moonrakerHandler(rw http.ResponseWriter, r *http.Request) {
	// like cors_domains in moonraker.conf: local pages may call it from the browser
	if o := r.Header.Get("Origin"); o != "" && localOrigin.MatchString(o) {
		rw.Header().Set("Access-Control-Allow-Origin", o)
		rw.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		rw.Header().Set("Access-Control-Allow-Headers", "*")
		rw.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	if r.Method == http.MethodOptions {
		rw.WriteHeader(204)
		return
	}
	s := w.Moonraker
	switch r.URL.Path {
	case "/server/info":
		writeJSON(rw, 200, obj{"result": obj{"klippy_connected": true, "klippy_state": "ready", "moonraker_version": "v0.9.3-mock"}})
	case "/printer/info":
		writeJSON(rw, 200, obj{"result": obj{"state": "ready", "hostname": "mock-klipper", "software_version": "v0.12-mock"}})
	case "/printer/objects/query":
		writeJSON(rw, 200, obj{"result": obj{"status": w.klipperSnapshot()}})
	case "/printer/print/pause", "/printer/print/resume", "/printer/print/cancel":
		to := map[string]string{"pause": "paused", "resume": "printing", "cancel": "stopped"}[strings.TrimPrefix(r.URL.Path, "/printer/print/")]
		if !s.set(to) {
			http.Error(rw, "not allowed in this state", 400)
			return
		}
		writeJSON(rw, 200, obj{"result": "ok"})
	case "/server/files/upload":
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(rw, err.Error(), 400)
			return
		}
		f, h, err := r.FormFile("file")
		if err != nil {
			http.Error(rw, "no file", 400)
			return
		}
		n, _ := io.Copy(io.Discard, f)
		f.Close()
		if n == 0 || r.FormValue("root") != "gcodes" {
			http.Error(rw, "bad upload", 400)
			return
		}
		started := false
		if r.FormValue("print") == "true" {
			started = s.start(h.Filename)
		}
		w.got("klipper", h.Filename)
		writeJSON(rw, 201, obj{"item": obj{"path": h.Filename, "root": "gcodes"}, "print_started": started, "print_queued": false, "action": "create_file"})
	case "/websocket":
		w.klipperSocket(rw, r)
	default:
		http.Error(rw, "not found", 404)
	}
}

// klipperSocket speaks Moonraker's JSON-RPC: server.info, printer.objects.subscribe, and status notifications.
func (w *Web) klipperSocket(rw http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" && !localOrigin.MatchString(o) {
		http.Error(rw, "origin not allowed", 403)
		return
	}
	ws, err := websocket.Accept(rw, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ctx := r.Context()
	var mu sync.Mutex
	send := func(v any) {
		b, _ := json.Marshal(v)
		mu.Lock()
		defer mu.Unlock()
		_ = ws.Write(ctx, websocket.MessageText, b)
	}
	subscribed := make(chan struct{})
	go func() {
		select {
		case <-subscribed:
		case <-ctx.Done():
			return
		}
		var prev []byte
		tk := time.NewTicker(400 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				snap := w.klipperSnapshot()
				if b, _ := json.Marshal(snap); string(b) != string(prev) {
					prev = b
					send(obj{"jsonrpc": "2.0", "method": "notify_status_update", "params": []any{snap, float64(time.Now().UnixNano()) / 1e9}})
				}
			}
		}
	}()
	var once sync.Once
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var m struct {
			Method string `json:"method"`
			ID     any    `json:"id"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Method {
		case "server.info":
			send(obj{"jsonrpc": "2.0", "id": m.ID, "result": obj{"klippy_connected": true, "klippy_state": "ready", "moonraker_version": "v0.9.3-mock"}})
		case "printer.objects.subscribe":
			send(obj{"jsonrpc": "2.0", "id": m.ID, "result": obj{"eventtime": 1.0, "status": w.klipperSnapshot()}})
			once.Do(func() { close(subscribed) })
		default:
			send(obj{"jsonrpc": "2.0", "id": m.ID, "error": obj{"code": -32601, "message": "method not found"}})
		}
	}
}

// ---- OctoPrint

func (w *Web) octoHandler(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Api-Key") != OctoKey {
		http.Error(rw, "forbidden", 403)
		return
	}
	s := w.Octo
	state, progress, file, _, nozzle, bed := s.view()
	text := map[string]string{"idle": "Operational", "printing": "Printing", "paused": "Paused", "done": "Operational", "stopped": "Operational"}[state]
	switch r.URL.Path {
	case "/api/job":
		if r.Method == http.MethodPost {
			var c struct{ Command, Action string }
			_ = json.NewDecoder(r.Body).Decode(&c)
			ok := false
			switch {
			case c.Command == "pause" && c.Action == "pause":
				ok = s.set("paused")
			case c.Command == "pause" && c.Action == "resume":
				ok = s.set("printing")
			case c.Command == "cancel":
				ok = s.set("stopped")
			}
			if !ok {
				http.Error(rw, "conflict", 409)
				return
			}
			rw.WriteHeader(204)
			return
		}
		left := int((1 - progress) * 60 / s.speed)
		writeJSON(rw, 200, obj{"job": obj{"file": obj{"name": file, "display": file}}, "progress": obj{"completion": progress * 100, "printTimeLeft": left}, "state": text})
	case "/api/printer":
		writeJSON(rw, 200, obj{"temperature": obj{"tool0": obj{"actual": nozzle, "target": 215.0}, "bed": obj{"actual": bed, "target": 60.0}}})
	case "/api/files/local":
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(rw, err.Error(), 400)
			return
		}
		f, h, err := r.FormFile("file")
		if err != nil {
			http.Error(rw, "no file", 400)
			return
		}
		io.Copy(io.Discard, f)
		f.Close()
		if r.FormValue("print") == "true" && !s.start(h.Filename) {
			http.Error(rw, "printer is busy", 409)
			return
		}
		w.got("octoprint", h.Filename)
		writeJSON(rw, 201, obj{"done": true, "files": obj{"local": obj{"name": h.Filename}}})
	default:
		http.Error(rw, "not found", 404)
	}
}
