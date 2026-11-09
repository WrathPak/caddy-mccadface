// Package server is the helper's WebSocket API on 127.0.0.1: origin check, pairing, and the printer operations.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/lan"
)

// DefaultOrigins are the web pages allowed to talk to the helper.
var DefaultOrigins = []string{"https://wrathpak.github.io", "http://localhost:*", "http://127.0.0.1:*"}

// Options configure a Server.
type Options struct {
	Version  string
	Origins  []string      // allowed origins; DefaultOrigins plus --allow-origin
	Mocks    []bambu.Found // the simulated printers (--mock), listed by discover
	Logf     func(format string, a ...any)
	Discover time.Duration // how long a discover listens, 4s by default
}

// Server is the helper's API.
type Server struct {
	opt   Options
	store *config.Store
	mgr   *Manager

	mu     sync.Mutex
	code   string
	failed int
	conns  map[*conn]bool
}

// New makes a server over a config store and starts its printers.
func New(store *config.Store, opt Options) *Server {
	if opt.Logf == nil {
		opt.Logf = func(string, ...any) {}
	}
	if opt.Discover == 0 {
		opt.Discover = 4 * time.Second
	}
	if len(opt.Origins) == 0 {
		opt.Origins = DefaultOrigins
	}
	s := &Server{opt: opt, store: store, conns: map[*conn]bool{}}
	s.code = newCode()
	s.mgr = NewManager(store, opt.Logf)
	s.mgr.OnStatus = func(st bambu.Status) { s.broadcast(map[string]any{"type": "status", "status": st}) }
	s.mgr.Run()
	return s
}

// isMock says whether an add request names one of the simulated printers.
func (s *Server) isMock(r addReq) bool {
	for _, f := range s.opt.Mocks {
		if f.Kind == "bambu" || f.Kind == "" {
			if strings.EqualFold(r.Serial, f.Serial) && r.Serial != "" {
				return true
			}
		} else if f.Kind == r.Kind && f.Port == r.Port && r.Port != 0 {
			return true
		}
	}
	return false
}

// Close stops the printers' connections.
func (s *Server) Close() { s.mgr.Close() }

// PairingCode is the code a new browser must type.
func (s *Server) PairingCode() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.code
}

func newCode() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

// OriginAllowed checks an Origin header against patterns. A pattern ending in ":*" allows any port on that host.
func OriginAllowed(origin string, patterns []string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" || u.User != nil {
		return false
	}
	o := strings.ToLower(u.Scheme + "://" + u.Host)
	for _, p := range patterns {
		p = strings.ToLower(strings.TrimSpace(p))
		if strings.HasSuffix(p, ":*") {
			base := strings.TrimSuffix(p, ":*")
			if o == base || (strings.HasPrefix(o, base+":") && regexp.MustCompile(`^\d+$`).MatchString(o[len(base)+1:])) {
				return true
			}
		} else if o == p {
			return true
		}
	}
	return false
}

func hostOK(h string) bool {
	host, _, err := net.SplitHostPort(h)
	if err != nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// Handler serves the WebSocket and a small /health for the browser's private-network preflight.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !hostOK(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !OriginAllowed(origin, s.opt.Origins) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			// Chrome asks before a public page may reach a local server (Local Network Access)
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "*")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			s.serveWS(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":"caddy-link","version":%q,"protocol":%d}`, s.opt.Version, ProtocolVersion)
	})
	return mux
}

type conn struct {
	s      *Server
	ws     *websocket.Conn
	ctx    context.Context
	authed bool
	job    *job
	jm     sync.Mutex
}

func (c *conn) write(b []byte) {
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageText, b)
}

func (c *conn) reply(id string, fields map[string]any) {
	m := map[string]any{"type": "reply", "id": id}
	for k, v := range fields {
		m[k] = v
	}
	c.write(marshal(m))
}

func (c *conn) fail(id, code, msg string) {
	c.write(marshal(errorMsg{Type: "error", ID: id, Code: code, Message: msg}))
}

func (c *conn) failErr(id string, err error) {
	var e *bambu.Error
	if errors.As(err, &e) {
		c.fail(id, e.Code, e.Msg)
		return
	}
	c.fail(id, ErrInternal, err.Error())
}

func (s *Server) broadcast(v any) {
	b := marshal(v)
	s.mu.Lock()
	cs := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		if c.authed {
			cs = append(cs, c)
		}
	}
	s.mu.Unlock()
	for _, c := range cs {
		c.write(b)
	}
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		http.Error(w, "an origin is required", http.StatusForbidden)
		return
	}
	// the origin was checked above; the library's own check would only compare it to the host
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 20)
	c := &conn{s: s, ws: ws, ctx: r.Context()}
	s.mu.Lock()
	s.conns[c] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		c.dropJob()
		ws.CloseNow()
	}()
	c.write(marshal(helloMsg{Type: "hello", Version: ProtocolVersion, Helper: s.opt.Version, Capabilities: []string{"bambu", "prusa", "klipper", "octoprint", "proxy", "trust"}, Mock: len(s.opt.Mocks) > 0}))
	for {
		typ, data, err := ws.Read(r.Context())
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			c.onBinary(data)
			continue
		}
		var env envelope
		if json.Unmarshal(data, &env) != nil || env.Type == "" {
			c.fail("", ErrBadRequest, "That message is not valid.")
			continue
		}
		c.handle(env, data)
	}
}

// greet sends the printers and their latest status to a connection that just authed.
func (c *conn) greet() {
	c.write(marshal(map[string]any{"type": "printers", "printers": c.s.mgr.Infos()}))
	for _, st := range c.s.mgr.Statuses() {
		c.write(marshal(map[string]any{"type": "status", "status": st}))
	}
}

func (c *conn) handle(env envelope, data []byte) {
	s := c.s
	switch env.Type {
	case "auth":
		var r authReq
		_ = json.Unmarshal(data, &r)
		if !s.store.ValidToken(r.Token) {
			time.Sleep(300 * time.Millisecond)
			c.fail(env.ID, ErrPairingRequired, "This browser is not paired yet. Type the code shown in the CADdy Link window.")
			return
		}
		c.setAuthed()
		c.reply(env.ID, nil)
		c.greet()
		return
	case "pair":
		var r pairReq
		_ = json.Unmarshal(data, &r)
		tok, err := s.pair(strings.TrimSpace(r.Code))
		if err != nil {
			c.failErr(env.ID, err)
			return
		}
		c.setAuthed()
		c.reply(env.ID, map[string]any{"token": tok})
		c.greet()
		return
	}
	if !c.isAuthed() {
		c.fail(env.ID, ErrUnauthorized, "Pair this browser with CADdy Link first.")
		return
	}
	switch env.Type {
	case "printers.list":
		c.reply(env.ID, map[string]any{"printers": s.mgr.Infos()})
	case "printers.discover":
		go func() {
			var wg sync.WaitGroup
			var bam, web []bambu.Found
			wg.Add(2)
			go func() { defer wg.Done(); bam = bambu.Discover(s.opt.Discover) }()
			go func() { defer wg.Done(); web = lan.Discover(s.opt.Discover) }()
			wg.Wait()
			found := append([]bambu.Found{}, bam...)
			found = append(found, web...)
			found = append(found, s.opt.Mocks...)
			c.reply(env.ID, map[string]any{"found": found})
		}()
	case "printers.add":
		var r addReq
		if json.Unmarshal(data, &r) != nil {
			c.fail(env.ID, ErrBadRequest, "That request is not valid.")
			return
		}
		go func() {
			mock := s.isMock(r)
			p, err := s.mgr.Add(r, mock)
			if err != nil {
				c.failErr(env.ID, err)
				return
			}
			c.reply(env.ID, map[string]any{"printer": Info(p)})
			s.broadcast(map[string]any{"type": "printers", "printers": s.mgr.Infos()})
		}()
	case "printers.remove":
		var r printerReq
		_ = json.Unmarshal(data, &r)
		if err := s.mgr.Remove(r.PrinterID); err != nil {
			c.fail(env.ID, ErrNotFound, "No such printer.")
			return
		}
		c.reply(env.ID, nil)
		s.broadcast(map[string]any{"type": "printers", "printers": s.mgr.Infos()})
	case "printers.trust":
		var r trustReq
		_ = json.Unmarshal(data, &r)
		go func() {
			if err := s.mgr.Trust(r.PrinterID, r.Which, r.Fingerprint); err != nil {
				c.failErr(env.ID, err)
				return
			}
			c.reply(env.ID, nil)
		}()
	case "http.request":
		go c.proxy(env.ID, data)
	case "printer.pause", "printer.resume", "printer.stop", "printer.light", "printer.speed":
		var r printerReq
		_ = json.Unmarshal(data, &r)
		ctl := s.mgr.Controller(r.PrinterID)
		if ctl == nil {
			c.fail(env.ID, ErrNotFound, "No such printer.")
			return
		}
		var err error
		switch env.Type {
		case "printer.pause":
			err = ctl.Pause()
		case "printer.resume":
			err = ctl.Resume()
		case "printer.stop":
			err = ctl.Cancel()
		default:
			// the light and the speed levels are Bambu features
			cl := s.mgr.Client(r.PrinterID)
			if cl == nil {
				c.fail(env.ID, ErrBadRequest, "This printer has no such control.")
				return
			}
			if env.Type == "printer.light" {
				err = cl.Light(r.On)
			} else {
				err = cl.Speed(r.Level)
			}
		}
		if err != nil {
			c.failErr(env.ID, err)
			return
		}
		c.reply(env.ID, nil)
	case "send.begin":
		c.sendBegin(env.ID, data)
	case "send.cancel":
		var r cancelReq
		_ = json.Unmarshal(data, &r)
		if err := c.cancelJob(r.JobID); err != nil {
			c.failErr(env.ID, err)
			return
		}
		c.reply(env.ID, nil)
	default:
		c.fail(env.ID, ErrBadRequest, "Unknown request "+env.Type+".")
	}
}

func (c *conn) setAuthed() {
	c.s.mu.Lock()
	c.authed = true
	c.s.mu.Unlock()
}

func (c *conn) isAuthed() bool {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	return c.authed
}

// pair checks the code. Five wrong tries replace it; a right one makes a token and replaces it too.
func (s *Server) pair(code string) (string, error) {
	s.mu.Lock()
	ok := subtle.ConstantTimeCompare([]byte(code), []byte(s.code)) == 1
	if !ok {
		s.failed++
		if s.failed >= 5 {
			s.failed = 0
			s.code = newCode()
			s.opt.Logf("Too many wrong codes. The new pairing code is %s.", s.code)
		}
		s.mu.Unlock()
		time.Sleep(500 * time.Millisecond)
		return "", &bambu.Error{Code: ErrBadCode, Msg: "That code is not right. Look at the CADdy Link window for the current one."}
	}
	s.failed = 0
	s.code = newCode()
	next := s.code
	s.mu.Unlock()
	tok, err := s.store.NewToken()
	if err != nil {
		return "", err
	}
	s.opt.Logf("Paired a browser. The next pairing code is %s.", next)
	return tok, nil
}
