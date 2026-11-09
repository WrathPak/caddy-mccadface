package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/mock"
	"github.com/wrathpak/caddy-mccadface/helper/internal/server"
)

type msg = map[string]any

// client is a bare WebSocket client like the app's: JSON requests with ids, and everything else queued.
type client struct {
	t    *testing.T
	ws   *websocket.Conn
	mu   sync.Mutex
	in   []msg
	raw  []string
	next int
}

func dial(t *testing.T, url, origin string) (*client, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
	if err != nil {
		return nil, resp, err
	}
	ws.SetReadLimit(64 << 20)
	c := &client{t: t, ws: ws}
	go func() {
		for {
			_, b, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			var m msg
			_ = json.Unmarshal(b, &m)
			c.mu.Lock()
			c.in = append(c.in, m)
			c.raw = append(c.raw, string(b))
			c.mu.Unlock()
		}
	}()
	return c, resp, nil
}

// wait returns the first queued message the test accepts.
func (c *client) wait(d time.Duration, ok func(msg) bool) msg {
	c.t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		c.mu.Lock()
		for i, m := range c.in {
			if ok(m) {
				c.in = append(c.in[:i], c.in[i+1:]...)
				c.mu.Unlock()
				return m
			}
		}
		c.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	c.t.Fatalf("timed out waiting for a message")
	return nil
}

// call sends a request and returns its reply or error.
func (c *client) call(typ string, fields msg) msg {
	c.t.Helper()
	c.next++
	id := typ + "-" + string(rune('a'+c.next))
	m := msg{"id": id, "type": typ}
	for k, v := range fields {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
	return c.wait(20*time.Second, func(r msg) bool { return r["id"] == id })
}

func (c *client) status(d time.Duration, ok func(msg) bool) msg {
	c.t.Helper()
	m := c.wait(d, func(m msg) bool {
		if m["type"] != "status" {
			return false
		}
		s, _ := m["status"].(msg)
		return ok(s)
	})
	return m["status"].(msg)
}

func threeMF(t *testing.T) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("Metadata/plate_1.gcode")
	w.Write([]byte("; HEADER_BLOCK_START\n; total layer number: 20\nG1 X1\n"))
	pad, _ := zw.Create("Metadata/pad.bin")
	pad.Write(bytes.Repeat([]byte{7}, 600*1024))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestMockPrinterThroughTheHelper(t *testing.T) {
	fake, err := mock.Start(mock.Options{Speed: 20, SlowWrites: 4 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	found := fake.Found()
	store, err := config.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(store, server.Options{Version: "test", Mocks: []bambu.Found{found}, Discover: 300 * time.Millisecond})
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// a page that is not allowed cannot connect, and neither can a client with no origin
	if _, resp, err := dial(t, ts.URL, "https://evil.example"); err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatalf("a foreign origin got in: %v", err)
	}
	if _, _, err := dial(t, ts.URL, ""); err == nil {
		t.Fatal("an empty origin got in")
	}

	c, _, err := dial(t, ts.URL, "http://localhost:5173")
	if err != nil {
		t.Fatal(err)
	}
	defer c.ws.CloseNow()
	hello := c.wait(3*time.Second, func(m msg) bool { return m["type"] == "hello" })
	if hello["version"].(float64) != 1 || hello["mock"] != true {
		t.Fatalf("hello: %v", hello)
	}

	// nothing works before pairing
	if r := c.call("printers.list", nil); r["code"] != "unauthorized" {
		t.Fatalf("list before pairing: %v", r)
	}
	if r := c.call("auth", msg{"token": "nope"}); r["code"] != "pairing_required" {
		t.Fatalf("auth with a bad token: %v", r)
	}
	if r := c.call("pair", msg{"code": "000000x"}); r["code"] != "bad_code" {
		t.Fatalf("pair with a bad code: %v", r)
	}
	r := c.call("pair", msg{"code": srv.PairingCode()})
	token, _ := r["token"].(string)
	if r["type"] != "reply" || len(token) < 32 {
		t.Fatalf("pair: %v", r)
	}
	if srv.PairingCode() == "" {
		t.Fatal("no new code")
	}

	// a second connection signs in with the token
	c2, _, err := dial(t, ts.URL, "http://127.0.0.1:4000")
	if err != nil {
		t.Fatal(err)
	}
	defer c2.ws.CloseNow()
	if r := c2.call("auth", msg{"token": token}); r["type"] != "reply" {
		t.Fatalf("auth with the token: %v", r)
	}

	// discover finds the mock printer, add checks the access code and never hands it back
	d := c.call("printers.discover", nil)
	// (a real network may add printers of its own to the list)
	list, _ := d["found"].([]any)
	var seen bool
	for _, f := range list {
		if f.(msg)["serial"] == found.Serial {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("discover: %v", d)
	}
	bad := c.call("printers.add", msg{"serial": found.Serial, "ip": "127.0.0.1", "accessCode": "00000000", "mqttPort": found.MQTTPort, "ftpPort": found.FTPPort})
	if bad["code"] != "bad_access_code" {
		t.Fatalf("add with a wrong access code: %v", bad)
	}
	add := c.call("printers.add", msg{"serial": found.Serial, "ip": "127.0.0.1", "accessCode": found.AccessCode, "name": "Mock A1", "model": found.Model, "mqttPort": found.MQTTPort, "ftpPort": found.FTPPort})
	pr, _ := add["printer"].(msg)
	if pr == nil || pr["modelLabel"] != "Bambu Lab A1" || pr["pinned"] != true {
		t.Fatalf("add: %v", add)
	}
	id := pr["id"].(string)
	c.mu.Lock()
	for _, raw := range c.raw {
		if strings.Contains(raw, found.AccessCode) && !strings.Contains(raw, `"found"`) {
			t.Fatalf("the access code went back to the browser: %s", raw)
		}
	}
	c.mu.Unlock()

	// status: merged from the pushall report, with the AMS
	st := c.status(10*time.Second, func(s msg) bool {
		ams, _ := s["ams"].(msg)
		u, _ := ams["units"].([]any)
		return s["printerId"] == id && s["online"] == true && len(u) == 1
	})
	trays := st["ams"].(msg)["units"].([]any)[0].(msg)["trays"].([]any)
	if len(trays) != 4 || trays[2].(msg)["type"] != "PETG" || trays[0].(msg)["color"] != "#C12E1F" {
		t.Fatalf("AMS: %v", trays)
	}
	if st["state"] != "idle" {
		t.Fatalf("state: %v", st["state"])
	}

	// a send canceled while it uploads stops, and the partial file is deleted from the printer
	{
		big := bytes.Repeat([]byte("0123456789abcdef"), 256*1024) // 4 MB, slow enough on the mock to be caught under way
		begin := c.call("send.begin", msg{"printerId": id, "fileName": "cancel me.gcode.3mf", "size": len(big), "useAms": false, "amsMapping": []int{}})
		job, _ := begin["jobId"].(string)
		if job == "" {
			t.Fatalf("send.begin: %v", begin)
		}
		for off := 0; off < len(big); off += 256 * 1024 {
			if err := c.ws.Write(context.Background(), websocket.MessageBinary, big[off:off+256*1024]); err != nil {
				t.Fatal(err)
			}
		}
		c.wait(10*time.Second, func(m msg) bool { return m["type"] == "send" && m["jobId"] == job && m["stage"] == "uploading" })
		if r := c.call("send.cancel", msg{"jobId": job}); r["type"] != "reply" {
			t.Fatalf("cancel: %v", r)
		}
		e := c.wait(20*time.Second, func(m msg) bool {
			return m["type"] == "send" && m["jobId"] == job && (m["stage"] == "cancelled" || m["stage"] == "done" || m["stage"] == "error")
		})
		if e["stage"] != "cancelled" {
			t.Fatalf("an upload under way was not canceled: %v", e)
		}
		for _, f := range fake.Received() {
			if strings.Contains(f, "cancel_me") {
				t.Fatalf("the partial file is still on the printer: %v", fake.Received())
			}
		}
	}

	// send a file: a wrong mapping is refused by the printer, a right one starts the print
	file := threeMF(t)
	send := func(mapping []int) (msg, msg) {
		begin := c.call("send.begin", msg{"printerId": id, "fileName": "cube test.gcode.3mf", "size": len(file), "useAms": true, "amsMapping": mapping, "bedLeveling": true, "flowCali": false, "timelapse": false})
		if begin["type"] != "reply" {
			t.Fatalf("send.begin: %v", begin)
		}
		job := begin["jobId"].(string)
		for off := 0; off < len(file); off += 256 * 1024 {
			end := off + 256*1024
			if end > len(file) {
				end = len(file)
			}
			if err := c.ws.Write(context.Background(), websocket.MessageBinary, file[off:end]); err != nil {
				t.Fatal(err)
			}
		}
		var sawUpload bool
		for {
			e := c.wait(30*time.Second, func(m msg) bool { return m["type"] == "send" && m["jobId"] == job })
			switch e["stage"] {
			case "uploading":
				sawUpload = true
			case "done", "error":
				if e["stage"] == "done" && !sawUpload {
					t.Fatal("no upload progress")
				}
				return begin, e
			}
		}
	}
	if _, e := send([]int{9}); e["stage"] != "error" || e["code"] != "print_rejected" {
		t.Fatalf("a bad mapping was not refused: %v", e)
	}
	if _, e := send([]int{2}); e["stage"] != "done" {
		t.Fatalf("send: %v", e)
	}
	got := fake.Received()
	if len(got) == 0 || got[0] != "/cube_test.gcode.3mf" {
		t.Fatalf("files on the printer: %v", got)
	}

	// the job shows in the status, with layers read from the file
	run := c.status(15*time.Second, func(s msg) bool {
		return s["printerId"] == id && (s["state"] == "running") && s["percent"].(float64) > 0
	})
	if run["totalLayers"].(float64) != 20 || !strings.Contains(run["file"].(string), "cube_test") {
		t.Fatalf("running status: %v", run)
	}
	if ams := run["ams"].(msg); ams["active"] == nil || ams["active"].(float64) != 2 {
		t.Fatalf("active tray: %v", ams["active"])
	}
	if run["nozzle"].(msg)["target"].(float64) != 220 {
		t.Fatalf("nozzle: %v", run["nozzle"])
	}

	if r := c.call("printer.pause", msg{"printerId": id}); r["type"] != "reply" {
		t.Fatalf("pause: %v", r)
	}
	c.status(10*time.Second, func(s msg) bool { return s["state"] == "pause" })
	if r := c.call("printer.resume", msg{"printerId": id}); r["type"] != "reply" {
		t.Fatalf("resume: %v", r)
	}
	c.status(10*time.Second, func(s msg) bool { return s["state"] == "running" })
	if r := c.call("printer.light", msg{"printerId": id, "on": false}); r["type"] != "reply" {
		t.Fatalf("light: %v", r)
	}
	c.status(10*time.Second, func(s msg) bool { return s["light"] == false })
	// a second send while it prints is refused
	if r := c.call("send.begin", msg{"printerId": id, "fileName": "x.gcode.3mf", "size": 10}); r["code"] != "busy" {
		t.Fatalf("send while printing: %v", r)
	}
	if r := c.call("printer.stop", msg{"printerId": id}); r["type"] != "reply" {
		t.Fatalf("stop: %v", r)
	}
	end := c.status(10*time.Second, func(s msg) bool { return s["state"] == "failed" })
	if end["printError"] != "0300_400C" {
		t.Fatalf("print error: %v", end["printError"])
	}

	// the printer is kept across a restart, without its access code in the browser's hands
	if r := c.call("printers.remove", msg{"printerId": id}); r["type"] != "reply" {
		t.Fatalf("remove: %v", r)
	}
	if l := c.call("printers.list", nil); len(l["printers"].([]any)) != 0 {
		t.Fatalf("list after remove: %v", l)
	}
}

func TestOriginAllowed(t *testing.T) {
	ok := []string{"https://wrathpak.github.io", "http://localhost:5173", "http://127.0.0.1:1", "http://localhost"}
	no := []string{"https://evil.example", "http://wrathpak.github.io.evil.example", "https://wrathpak.github.io:444", "http://localhostx:80", "null", "http://localhost:80/x", "https://localhost:5173"}
	for _, o := range ok {
		if !server.OriginAllowed(o, server.DefaultOrigins) {
			t.Errorf("%s should be allowed", o)
		}
	}
	for _, o := range no {
		if server.OriginAllowed(o, server.DefaultOrigins) {
			t.Errorf("%s should not be allowed", o)
		}
	}
	if !server.OriginAllowed("https://example.com", append([]string{"https://example.com"}, server.DefaultOrigins...)) {
		t.Error("an --allow-origin should work")
	}
}
